//go:build tizi

package tizi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"go.yaml.in/yaml/v3"
)

type ledgerState struct {
	ReportCutoff string         `json:"report_cutoff"`
	Sequence     uint64         `json:"sequence"`
	Ack          uint64         `json:"ack"`
	Days         []DayUsage     `json:"days"`
	LastSync     int64          `json:"last_sync_at"`
	Health       map[string]any `json:"health"`
	Running      bool           `json:"running"`
}
type runtimeState struct {
	dir     string
	meter   *Meter
	ledger  ledgerState
	stop    chan struct{}
	done    chan struct{}
	release func()
}

var runtimeMu sync.Mutex
var currentRuntime *runtimeState

func running(dir string) bool {
	b, e := os.ReadFile(filepath.Join(dir, "runtime.lock"))
	if e != nil {
		return false
	}
	pid, e := strconv.Atoi(string(b))
	if e != nil {
		return true
	}
	p, e := os.FindProcess(pid)
	return e == nil && p.Signal(syscall.Signal(0)) == nil
}
func acquire(dir, name string) (func(), error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	p := filepath.Join(dir, name)
	f, e := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(e) {
		b, readErr := os.ReadFile(p)
		pid, parseErr := strconv.Atoi(string(b))
		if readErr == nil && parseErr == nil {
			proc, _ := os.FindProcess(pid)
			if proc != nil && proc.Signal(syscall.Signal(0)) != nil {
				_ = os.Remove(p)
				f, e = os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			}
		}
	}
	if e != nil {
		return nil, errors.New("Tizi state is busy; another process owns it")
	}
	if _, e = f.WriteString(strconv.Itoa(os.Getpid())); e != nil {
		f.Close()
		os.Remove(p)
		return nil, e
	}
	f.Close()
	return func() { _ = os.Remove(p) }, nil
}
func pendingDays(s ledgerState) int { return pendingDaysAt(s, time.Now()) }
func pendingDaysAt(s ledgerState, now time.Time) int {
	n := 0
	today := SettlementDay(now)
	lastDay := s.ReportCutoff
	for _, d := range s.Days {
		if d.Day < today && (lastDay == "" || d.Day >= lastDay) {
			n++
		}
	}
	return n
}

func report(dir string, id *identity, s *ledgerState, includeCurrent bool) error {
	days := make([]DayUsage, 0)
	today := SettlementDay(time.Now())
	for _, d := range s.Days {
		if d.Day < today || includeCurrent {
			days = append(days, d)
		}
	}
	s.Sequence++
	if e := writeEncrypted(dir, "ledger.enc", s); e != nil {
		return e
	}
	body := map[string]any{"sequence": s.Sequence, "days": days, "health": s.Health}
	data, _, e := call(id, id.ServerURL, "POST", "/v1/usage/report", body, true)
	if e != nil {
		return e
	}
	var ack struct {
		Sequence uint64 `json:"sequence"`
	}
	if json.Unmarshal(data, &ack) != nil || ack.Sequence != s.Sequence {
		return errors.New("Invalid tizi usage receipt")
	}
	s.Ack = ack.Sequence
	s.LastSync = time.Now().Unix()
	s.ReportCutoff = today
	return writeEncrypted(dir, "ledger.enc", s)
}
func syncOffline(dir string, id *identity) error { return syncOfflineDays(dir, id, false) }
func syncOfflineDays(dir string, id *identity, includeCurrent bool) error {
	release, e := acquire(dir, "runtime.lock")
	if e != nil {
		return e
	}
	defer release()
	var ledger ledgerState
	if e = readEncrypted(dir, "ledger.enc", &ledger); e != nil {
		return e
	}
	return report(dir, id, &ledger, includeCurrent)
}
func Active() bool { runtimeMu.Lock(); defer runtimeMu.Unlock(); return currentRuntime != nil }
func Configure(dir string, outbounds map[string]bool) error {
	runtimeMu.Lock()
	defer runtimeMu.Unlock()
	if currentRuntime != nil && currentRuntime.dir == dir {
		currentRuntime.meter.SetOutbounds(outbounds)
		return nil
	}
	if currentRuntime != nil {
		currentRuntime.meter.CloseConnections()
		close(currentRuntime.stop)
		<-currentRuntime.done
		currentRuntime = nil
	}
	SetMeter(nil)
	if dir == "" {
		return nil
	}
	id, e := loadIdentity(dir)
	if e != nil || !id.LoggedIn {
		return errors.New("Tizi login required")
	}
	release, e := acquire(dir, "runtime.lock")
	if e != nil {
		return e
	}
	var ledger ledgerState
	if e = readEncrypted(dir, "ledger.enc", &ledger); e != nil {
		release()
		return e
	}
	m, e := NewMeter(ledger.Days)
	if e != nil {
		release()
		return e
	}
	if ledger.Health == nil {
		ledger.Health = map[string]any{"complete": true}
	}
	if ledger.Running {
		ledger.Health["complete"] = false
		ledger.Health["unclean_shutdown"] = true
	}
	ledger.Running = true
	m.SetOutbounds(outbounds)
	m.EnsureDay(time.Now())
	r := &runtimeState{dir, m, ledger, make(chan struct{}), make(chan struct{}), release}
	r.ledger.Days = m.Snapshot()
	if e = writeEncrypted(dir, "ledger.enc", r.ledger); e != nil {
		release()
		return e
	}
	currentRuntime = r
	SetMeter(m)
	go r.run(id)
	return nil
}

type networkResult struct {
	cutoff   string
	kind     string
	sequence uint64
	err      error
}

func (r *runtimeState) run(id *identity) {
	defer close(r.done)
	defer r.release()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	nextAttempt := time.Now()
	lastRefresh := time.Now()
	results := make(chan networkResult, 1)
	var cancel context.CancelFunc
	busy := false
	checkpoint := func() error {
		r.meter.EnsureDay(time.Now())
		r.ledger.Days = r.meter.Snapshot()
		return writeEncrypted(r.dir, "ledger.enc", r.ledger)
	}
	for {
		select {
		case <-r.stop:
			if cancel != nil {
				cancel()
			}
			if busy {
				<-results
			}
			r.ledger.Running = false
			if err := checkpoint(); err != nil {
				r.meter.SetHealthy(false)
			}
			return
		case result := <-results:
			busy = false
			if cancel != nil {
				cancel()
				cancel = nil
			}
			now := time.Now()
			if result.kind == "report" {
				if result.err == nil && result.sequence == r.ledger.Sequence {
					r.ledger.Ack = result.sequence
					r.ledger.LastSync = now.Unix()
					r.ledger.ReportCutoff = result.cutoff
					nextAttempt = now.Add(time.Second)
				} else {
					var rejected *serviceError
					if errors.As(result.err, &rejected) && (rejected.Status == 401 || rejected.Status == 403 || rejected.Status == 409) {
						r.meter.SetHealthy(false)
						r.ledger.Health["complete"] = false
						r.ledger.Health["server_rejected"] = true
					}
					nextAttempt = now.Add(time.Minute)
				}
				if err := checkpoint(); err != nil {
					r.meter.SetHealthy(false)
				}
			} else {
				lastRefresh = now
			}
		case now := <-ticker.C:
			if err := checkpoint(); err != nil {
				r.meter.SetHealthy(false)
				r.ledger.Health["complete"] = false
				r.ledger.Health["storage_error"] = true
				continue
			}
			if busy {
				continue
			}
			_, requested := os.Stat(filepath.Join(r.dir, "sync.request"))
			wantReport := requested == nil || r.ledger.ReportCutoff != SettlementDay(now)
			if wantReport && !now.Before(nextAttempt) {
				_ = os.Remove(filepath.Join(r.dir, "sync.request"))
				days := make([]DayUsage, 0)
				today := SettlementDay(now)
				for _, day := range r.ledger.Days {
					if day.Day < today {
						days = append(days, day)
					}
				}
				r.ledger.Sequence++
				payload, err := json.Marshal(map[string]any{"sequence": r.ledger.Sequence, "days": days, "health": r.ledger.Health})
				if err != nil {
					r.meter.SetHealthy(false)
					continue
				}
				if err = checkpoint(); err != nil {
					r.meter.SetHealthy(false)
					continue
				}
				ctx, stop := context.WithCancel(context.Background())
				cancel = stop
				busy = true
				sequence := r.ledger.Sequence
				go func() {
					data, _, err := callContext(ctx, id, id.ServerURL, "POST", "/v1/usage/report", json.RawMessage(payload), true)
					if err == nil {
						var ack struct {
							Sequence uint64 `json:"sequence"`
						}
						if json.Unmarshal(data, &ack) != nil || ack.Sequence != sequence {
							err = errors.New("Invalid tizi usage receipt")
						}
					}
					results <- networkResult{cutoff: today, kind: "report", sequence: sequence, err: err}
				}()
			} else if now.Sub(lastRefresh) >= time.Hour {
				ctx, stop := context.WithCancel(context.Background())
				cancel = stop
				busy = true
				go func() { err := refreshContext(ctx, r.dir, id); results <- networkResult{kind: "refresh", err: err} }()
			}
		}
	}
}

func Close() {
	runtimeMu.Lock()
	defer runtimeMu.Unlock()
	SetMeter(nil)
	if currentRuntime != nil {
		currentRuntime.meter.CloseConnections()
		close(currentRuntime.stop)
		<-currentRuntime.done
		currentRuntime = nil
	}
}

// ExpandConfig keeps managed node secrets out of the application's runtime files.
func ExpandConfig(buf []byte) ([]byte, string, error) {
	if !bytes.Contains(buf, []byte("tizi-managed")) {
		return buf, "", nil
	}
	var wrapper map[string]any
	if e := yaml.Unmarshal(buf, &wrapper); e != nil {
		return nil, "", e
	}
	raw, ok := wrapper["tizi-managed"]
	if !ok {
		return buf, "", nil
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, "", errors.New("Invalid tizi-managed wrapper")
	}
	smartPolicy, policyErr := managedSmartPolicy(m)
	if policyErr != nil {
		return nil, "", policyErr
	}
	dir, _ := m["state-dir"].(string)
	if e := validateDir(dir); e != nil {
		return nil, "", e
	}
	id, e := loadIdentity(dir)
	if e != nil || !id.LoggedIn {
		return nil, "", errors.New("Tizi login required")
	}
	var sub subscription
	if e = readEncrypted(dir, "subscription.enc", &sub); e != nil {
		return nil, "", e
	}
	var ledger ledgerState
	if e = readEncrypted(dir, "ledger.enc", &ledger); e != nil {
		return nil, "", e
	}
	if _, e = NewMeter(ledger.Days); e != nil {
		return nil, "", e
	}
	var base map[string]any
	if e = yaml.Unmarshal([]byte(sub.YAML), &base); e != nil {
		return nil, "", errors.New("Invalid cached tizi subscription")
	}
	allowed := map[string]bool{"mixed-port": true, "port": true, "socks-port": true, "redir-port": true, "tproxy-port": true, "allow-lan": true, "bind-address": true, "mode": true, "ipv6": true, "log-level": true, "find-process-mode": true, "tun": true, "dns": true, "sniffer": true, "hosts": true, "traffic-history": true, "external-controller-unix": true, "external-controller-pipe": true, "external-controller": true, "secret": true, "profile": true, "unified-delay": true, "tcp-concurrent": true, "skip-auth-prefixes": true, "lan-allowed-ips": true, "lan-disallowed-ips": true, "authentication": true, "interface-name": true, "geodata-mode": true, "geo-auto-update": true, "geo-update-interval": true, "geox-url": true, "lgbm-auto-update": true, "lgbm-update-interval": true, "lgbm-url": true}
	for k, v := range wrapper {
		if k == "tizi-managed" {
			continue
		}
		if !allowed[k] {
			return nil, "", fmt.Errorf("Managed tizi override %q is not allowed", k)
		}
		base[k] = mergeManagedSetting(base[k], v)
	}
	if err := applySmart(base, smartPolicy); err != nil {
		return nil, "", err
	}
	ensureSmartTunExcludes(base, smartPolicy.Enabled)
	clearDisabledDNSHijack(base)
	delete(base, "tizi-managed")
	if _, ok := base["proxy-providers"]; ok {
		return nil, "", errors.New("Managed proxy provider caches are forbidden")
	}
	delete(base, "tizi-state-dir")
	base["ss-config"] = ""
	base["vmess-config"] = ""
	base["tcptun-config"] = ""
	delete(base, "listeners")
	delete(base, "script")
	delete(base, "tunnels")
	delete(base, "tuic-server")
	delete(base, "listeners")
	base["external-controller"] = ""
	base["external-controller-tls"] = ""
	base["external-ui"] = ""
	base["external-ui-url"] = ""
	base["external-controller-cors"] = map[string]any{"allow-origins": []string{}, "allow-private-network": false}
	base["log-level"] = "silent"
	out, e := yaml.Marshal(base)
	return out, dir, e
}
