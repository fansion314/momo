//go:build ignore

// Linux loopback acceptance benchmark. Run this file explicitly from the repo root.
package main

import (
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	_ "modernc.org/sqlite"
)

var benchmarkContext context.Context
var clockTicks float64
var duration = flag.Duration("duration", 35*time.Second, "measured duration")
var sampleInterval = flag.Duration("sample-interval", 30*time.Second, "history sampling interval")
var repeats = flag.Int("repeat", 3, "repetitions")
var streams = flag.Int("streams", 8, "bulk streams")
var dialSequence atomic.Uint64
var active = flag.Int("active", 10000, "idle connections")
var rate = flag.Int("rate", 1000, "short connections/s")
var base = flag.String("baseline", ".cache/mihomo-baseline", "baseline binary")
var current = flag.String("current", ".cache/mihomo-current", "modified binary")

func fail(err error) {
	if err != nil {
		panic(err)
	}
}
func port() int {
	l, e := net.Listen("tcp", "127.0.0.1:0")
	fail(e)
	p := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return p
}
func dial(proxy string, target int) (net.Conn, error) {
	d := net.Dialer{Timeout: 3 * time.Second, LocalAddr: &net.TCPAddr{IP: net.IPv4(127, 0, 0, byte(1+dialSequence.Add(1)%32))}}
	c, e := d.Dial("tcp", proxy)
	if e != nil {
		return nil, e
	}
	c.SetDeadline(time.Now().Add(5 * time.Second))
	ok := false
	defer func() {
		if !ok {
			c.Close()
		}
	}()
	if _, e = c.Write([]byte{5, 1, 0}); e != nil {
		return nil, e
	}
	var auth [2]byte
	if _, e = io.ReadFull(c, auth[:]); e != nil {
		return nil, e
	}
	if auth != [2]byte{5, 0} {
		return nil, fmt.Errorf("auth %v", auth)
	}
	request := []byte{5, 1, 0, 1, 127, 0, 0, 1, 0, 0}
	binary.BigEndian.PutUint16(request[8:], uint16(target))
	if _, e = c.Write(request); e != nil {
		return nil, e
	}
	var reply [10]byte
	if _, e = io.ReadFull(c, reply[:]); e != nil {
		return nil, e
	}
	if reply[1] != 0 {
		return nil, fmt.Errorf("connect reply %v", reply)
	}
	c.SetDeadline(time.Time{})
	ok = true
	return c, nil
}
func proc(pid int) (ticks, rss, write int64) {
	raw, _ := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	fields := strings.Fields(string(raw))
	if len(fields) > 15 {
		u, _ := strconv.ParseInt(fields[13], 10, 64)
		s, _ := strconv.ParseInt(fields[14], 10, 64)
		ticks = u + s
	}
	raw, _ = os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "VmHWM:") {
			f := strings.Fields(line)
			rss, _ = strconv.ParseInt(f[1], 10, 64)
			rss *= 1024
		}
	}
	raw, _ = os.ReadFile(fmt.Sprintf("/proc/%d/io", pid))
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "write_bytes:") {
			f := strings.Fields(line)
			write, _ = strconv.ParseInt(f[1], 10, 64)
		}
	}
	return
}
func status(api string) map[string]any {
	client := http.Client{Timeout: 3 * time.Second}
	req, _ := http.NewRequest("GET", api+"/traffic-history/status", nil)
	req.Header.Set("Authorization", "Bearer bench-secret")
	res, e := client.Do(req)
	if e != nil {
		return map[string]any{"error": e.Error()}
	}
	defer res.Body.Close()
	var out map[string]any
	json.NewDecoder(res.Body).Decode(&out)
	return out
}
func run(binaryPath, mode string, round int) map[string]any {
	dir, e := os.MkdirTemp(".cache", "traffic-history-bench-")
	fail(e)
	defer os.RemoveAll(dir)
	abs, e := filepath.Abs(binaryPath)
	fail(e)
	proxyPort, apiPort := port(), port()
	proxy := fmt.Sprintf("127.0.0.1:%d", proxyPort)
	api := fmt.Sprintf("http://127.0.0.1:%d", apiPort)
	enabled := mode == "enabled"
	cfg := fmt.Sprintf("mixed-port: %d\nbind-address: 127.0.0.1\nexternal-controller: 127.0.0.1:%d\nsecret: bench-secret\nlog-level: error\nfind-process-mode: off\nipv6: false\nrules:\n  - MATCH,DIRECT\ntraffic-history:\n  enable: %v\n  sample-interval: %s\n  geoip:\n    enable: false\n", proxyPort, apiPort, enabled, sampleInterval.String())
	fail(os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(cfg), 0600))
	log, e := os.Create(filepath.Join(dir, "core.log"))
	fail(e)
	defer log.Close()
	cmd := exec.Command(abs, "-d", dir)
	cmd.Stdout = log
	cmd.Stderr = log
	fail(cmd.Start())
	defer func() {
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	}()
	ready := false
	for i := 0; i < 150; i++ {
		c, e := net.DialTimeout("tcp", proxy, 100*time.Millisecond)
		if e == nil {
			c.Close()
			ready = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !ready {
		raw, _ := os.ReadFile(filepath.Join(dir, "core.log"))
		panic(string(raw))
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	fail(e)
	defer listener.Close()
	target := listener.Addr().(*net.TCPAddr).Port
	go func() {
		for {
			c, e := listener.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	targets := []int{target}
	for i := 1; i < 32; i++ {
		l, e := net.Listen("tcp", "127.0.0.1:0")
		fail(e)
		defer l.Close()
		targets = append(targets, l.Addr().(*net.TCPAddr).Port)
		go func(l net.Listener) {
			for {
				c, e := l.Accept()
				if e != nil {
					return
				}
				go func() { defer c.Close(); io.Copy(c, c) }()
			}
		}(l)
	}
	idle := make([]net.Conn, *active)
	var setup sync.WaitGroup
	sem := make(chan struct{}, 128)
	errCh := make(chan error, 1)
	for i := range idle {
		sem <- struct{}{}
		setup.Add(1)
		go func(i int) {
			defer setup.Done()
			defer func() { <-sem }()
			c, e := dial(proxy, target)
			if e != nil {
				select {
				case errCh <- e:
				default:
				}
			}
			idle[i] = c
		}(i)
	}
	setup.Wait()
	select {
	case e := <-errCh:
		panic(e)
	default:
	}
	ctx, cancel := context.WithCancel(context.Background())
	var workers sync.WaitGroup
	var transferred, shorts, failed atomic.Int64
	var failMu sync.Mutex
	failures := map[string]int{}
	recordFailure := func(err error) {
		failed.Add(1)
		key := err.Error()
		var no syscall.Errno
		var ne net.Error
		if errors.As(err, &no) {
			key = no.Error()
		} else if errors.As(err, &ne) && ne.Timeout() {
			key = "timeout"
		}
		failMu.Lock()
		failures[key]++
		failMu.Unlock()
	}
	for i := 0; i < *streams; i++ {
		c, e := dial(proxy, target)
		fail(e)
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer c.Close()
			buf := make([]byte, 64<<10)
			go func() { <-ctx.Done(); c.Close() }()
			for {
				if _, e := c.Write(buf); e != nil {
					return
				}
				if _, e := io.ReadFull(c, buf); e != nil {
					return
				}
				transferred.Add(int64(len(buf) * 2))
			}
		}()
	}
	shortSem := make(chan struct{}, 512)
	shortDone := make(chan struct{})
	var shortWG sync.WaitGroup
	go func() {
		defer close(shortDone)
		tick := time.NewTicker(10 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				for j := 0; j < *rate/100; j++ {
					select {
					case shortSem <- struct{}{}:
					default:
						recordFailure(fmt.Errorf("generator capacity"))
						continue
					}
					shortWG.Add(1)
					go func() {
						defer shortWG.Done()
						defer func() { <-shortSem }()
						c, e := dial(proxy, targets[int(dialSequence.Add(1)%uint64(len(targets)))])
						if e != nil {
							recordFailure(e)
							return
						}
						defer c.Close()
						c.SetDeadline(time.Now().Add(3 * time.Second))
						buf := make([]byte, 64)
						if _, e = c.Write(buf); e == nil {
							_, e = io.ReadFull(c, buf)
						}
						if e != nil {
							recordFailure(e)
						} else {
							shorts.Add(1)
						}
					}()
				}
			}
		}
	}()
	ticks0, _, write0 := proc(cmd.Process.Pid)
	start := time.Now()
	select {
	case <-time.After(*duration):
	case <-benchmarkContext.Done():
	}
	elapsed := time.Since(start)
	ticks1, rss, write1 := proc(cmd.Process.Pid)
	cancel()
	<-shortDone
	shortWG.Wait()
	workers.Wait()
	history := status(api)
	for i, c := range idle {
		if i%10 == 0 {
			time.Sleep(time.Millisecond)
		}
		if c != nil {
			c.Close()
		}
	}
	fail(cmd.Process.Signal(syscall.SIGTERM))
	fail(cmd.Wait())
	result := map[string]any{"sampleIntervalMs": sampleInterval.Milliseconds(), "mode": mode, "round": round, "seconds": elapsed.Seconds(), "bytes": transferred.Load(), "MiBps": float64(transferred.Load()) / elapsed.Seconds() / (1 << 20), "shortPerSecond": float64(shorts.Load()) / elapsed.Seconds(), "shortFailures": failed.Load(), "failureTypes": failures, "cpuCores": float64(ticks1-ticks0) / clockTicks / elapsed.Seconds(), "peakRSS": rss, "diskWriteBytes": write1 - write0, "history": history}
	if enabled {
		db, e := sql.Open("sqlite", filepath.Join(dir, "traffic-history.db"))
		fail(e)
		var count, closed, up, down int64
		fail(db.QueryRow("SELECT COUNT(*),SUM(state='closed'),SUM(recorded_upload),SUM(recorded_download) FROM flows WHERE accounted=1").Scan(&count, &closed, &up, &down))
		result["persisted"] = map[string]any{"flows": count, "closed": closed, "upload": up, "download": down}
		var drops int64
		fail(db.QueryRow("SELECT SUM(dropped_records) FROM sessions").Scan(&drops))
		result["persistedDrops"] = drops
		var sampleUp, sampleDown, sampleConnections, dayUp, dayDown, dayConnections, skipped, writeErrors int64
		fail(db.QueryRow("SELECT COALESCE(SUM(s.upload),0),COALESCE(SUM(s.download),0),COALESCE(SUM(s.connections),0) FROM samples s JOIN flows f ON f.id=s.flow_id WHERE f.accounted=1").Scan(&sampleUp, &sampleDown, &sampleConnections))
		fail(db.QueryRow("SELECT COALESCE(SUM(upload),0),COALESCE(SUM(download),0),COALESCE(SUM(connections),0) FROM daily_usage WHERE accounted=1").Scan(&dayUp, &dayDown, &dayConnections))
		fail(db.QueryRow("SELECT SUM(skipped_samples),SUM(write_errors) FROM sessions").Scan(&skipped, &writeErrors))
		expectedFlows := int64(*active+*streams) + shorts.Load()
		expectedBytesMin := transferred.Load() + shorts.Load()*128
		result["expected"] = map[string]any{"flows": expectedFlows, "payloadBytesMin": expectedBytesMin, "payloadBytesMax": expectedBytesMin + int64(*streams)*(128<<10)}
		result["samples"] = map[string]any{"upload": sampleUp, "download": sampleDown, "connections": sampleConnections}
		result["daily"] = map[string]any{"upload": dayUp, "download": dayDown, "connections": dayConnections}
		result["persistedSkippedSamples"], result["persistedWriteErrors"] = skipped, writeErrors
		result["accountingConsistent"] = drops == 0 && skipped == 0 && writeErrors == 0 && count == expectedFlows && closed == count && sampleUp == up && sampleDown == down && dayUp == up && dayDown == down && sampleConnections == count && dayConnections == count && up+down >= expectedBytesMin && up+down <= expectedBytesMin+int64(*streams)*(128<<10)
		db.Close()
	}
	return result
}
func main() {
	flag.Parse()
	if *active < 0 || *rate < 0 || *rate%100 != 0 || *streams < 0 || *duration < time.Second || *sampleInterval < time.Second || *repeats < 1 {
		panic("invalid load parameters; rate must be a multiple of 100")
	}
	fail(os.MkdirAll(".cache", 0700))
	ticks, e := exec.Command("getconf", "CLK_TCK").Output()
	fail(e)
	clockTicks, e = strconv.ParseFloat(strings.TrimSpace(string(ticks)), 64)
	fail(e)
	if clockTicks <= 0 {
		panic("invalid CLK_TCK")
	}
	var stop context.CancelFunc
	benchmarkContext, stop = signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	for round := 1; round <= *repeats; round++ {
		modes := []string{"baseline", "disabled", "enabled"}
		if round%2 == 0 {
			modes = []string{"enabled", "disabled", "baseline"}
		}
		for _, mode := range modes {
			if benchmarkContext.Err() != nil {
				return
			}
			bin := *current
			if mode == "baseline" {
				bin = *base
			}
			result := run(bin, mode, round)
			raw, _ := json.Marshal(result)
			fmt.Println(string(raw))
		}
	}
}
