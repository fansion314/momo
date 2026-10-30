package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

type processRecord struct {
	PID      int    `json:"pid"`
	Identity string `json:"identity"`
}

func recoverOwnedProcess(root string) error {
	path := filepath.Join(root, "process.json")
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var record processRecord
	if err = json.Unmarshal(b, &record); err != nil {
		return err
	}
	if record.PID <= 1 || record.Identity == "" {
		return errors.New("invalid process recovery record")
	}
	identity, err := processIdentity(record.PID)
	if err == nil && identity == record.Identity {
		if err = stopPID(record.PID, record.Identity, 6*time.Second); err != nil {
			return err
		}
	}
	return os.Remove(path)
}

func stopPID(pid int, identity string, grace time.Duration) error {
	current, err := processIdentity(pid)
	if err != nil || current != identity {
		return nil
	}
	if err = syscall.Kill(pid, syscall.SIGINT); err != nil && err != syscall.ESRCH {
		return err
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		current, err = processIdentity(pid)
		if err != nil || current != identity {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	current, err = processIdentity(pid)
	if err == nil && current == identity {
		return syscall.Kill(pid, syscall.SIGKILL)
	}
	return nil
}

// boundedLog never writes secrets/configs to persistent logs and caps core output.
type boundedLog struct {
	mu    sync.Mutex
	path  string
	limit int64
}

func (b *boundedLog) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	if int64(len(p)) > b.limit {
		p = p[len(p)-int(b.limit):]
	}
	if info, err := os.Stat(b.path); err == nil && info.Size()+int64(len(p)) > b.limit {
		if err = os.Truncate(b.path, 0); err != nil {
			return 0, err
		}
	}
	f, err := os.OpenFile(b.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return 0, err
	}
	_, err = f.Write(p)
	closeErr := f.Close()
	if err != nil {
		return 0, err
	}
	return n, closeErr
}
func (b *boundedLog) read() (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	f, err := os.Open(b.path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer f.Close()
	i, err := f.Stat()
	if err != nil {
		return "", err
	}
	start := i.Size() - (1 << 20)
	if start < 0 {
		start = 0
	}
	if _, err = f.Seek(start, 0); err != nil {
		return "", err
	}
	data := make([]byte, i.Size()-start)
	n, err := f.Read(data)
	if err != nil && n == 0 {
		return "", err
	}
	return string(data[:n]), nil
}

func (s *service) startCore(key string) error {
	if s.cmd != nil {
		return errors.New("core already running")
	}
	core := filepath.Join(s.root, "mihomomo")
	hash, err := fileHash(core)
	if err != nil {
		return err
	}
	if hash != s.install.CoreHash {
		return errors.New("installed core hash changed; authorize installation again")
	}
	if err = protectedTree(s.work); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(s.work, "core.sock"))
	cmd := exec.Command(core, "--momo-managed", "-d", s.work, "-f", filepath.Join(s.work, "config.yaml"), "-ext-ctl-unix", filepath.Join(s.work, "core.sock"))
	cmd.Dir = s.work
	cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=" + s.work}
	if key != "" {
		cmd.Env = append(cmd.Env, "CLASH_AGE_SECRET_KEY="+key)
	}
	cmd.Stdout = s.logs
	cmd.Stderr = s.logs
	if err = cmd.Start(); err != nil {
		return err
	}
	identity, err := processIdentity(cmd.Process.Pid)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	if err = writeJSON(filepath.Join(s.root, "process.json"), processRecord{cmd.Process.Pid, identity}); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	s.cmd = cmd
	s.identity = identity
	s.running.Store(true)
	s.ageKey = key
	done := make(chan struct{})
	s.done = done
	go func() {
		_ = cmd.Wait()
		close(done)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.cmd == cmd {
			s.cmd = nil
			s.identity = ""
			s.running.Store(false)
			_ = os.Remove(filepath.Join(s.root, "process.json"))
			_ = s.network.restore()
		}
	}()
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		if s.operationContext != nil {
			if err := s.operationContext.Err(); err != nil {
				_ = s.stopCore()
				return err
			}
		}
		select {
		case <-done:
			_ = s.stopCore()
			return errors.New("managed core exited during startup")
		default:
		}
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		req, _ := newCoreRequest(ctx, "GET", "/version", nil)
		resp, e := s.coreClient.Do(req)
		cancel()
		if e == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = s.stopCore()
	return fmt.Errorf("managed core did not become ready")
}

func (s *service) stopCore() error {
	if s.cmd == nil {
		return nil
	}
	cmd, done := s.cmd, s.done
	err := stopPID(cmd.Process.Pid, s.identity, 6*time.Second)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		if err == nil {
			err = errors.New("managed core did not exit")
		}
	}
	if err == nil {
		s.cmd = nil
		s.identity = ""
		s.running.Store(false)
		_ = os.Remove(filepath.Join(s.root, "process.json"))
	}
	return err
}
