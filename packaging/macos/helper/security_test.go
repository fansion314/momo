package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestSnapshotPathBoundaries(t *testing.T) {
	for _, path := range []string{"../etc/passwd", "/etc/passwd", "a/../b", "a//b", "a\\b", "", ".", "config.yaml", "x/core.sock", "x/.momo-backup", "a\x00b"} {
		if safeRelative(path) {
			t.Errorf("accepted %q", path)
		}
	}
	for _, path := range []string{"providers/a.yaml", "traffic-history.db", "cache.db-wal", "geoip.metadb"} {
		if !safeRelative(path) {
			t.Errorf("rejected %q", path)
		}
	}
}

func TestCoreAllowlist(t *testing.T) {
	for _, p := range []struct{ method, path string }{{"POST", "/restart"}, {"POST", "/upgrade"}, {"POST", "/upgrade/ui"}, {"PUT", "/configs"}, {"GET", "/proxies/../../etc/passwd"}, {"GET", "/providers/proxies/%2fetc"}, {"GET", "/unknown"}, {"POST", "/providers/proxies/x"}} {
		if allowedCoreRoute(p.method, p.path) {
			t.Errorf("allowed dangerous operation %v", p)
		}
	}
	for _, p := range []struct{ method, path string }{{"GET", "/version"}, {"GET", "/traffic"}, {"GET", "/traffic-history/status"}, {"PATCH", "/configs"}, {"PUT", "/proxies/group"}, {"DELETE", "/connections/id"}} {
		if !allowedCoreRoute(p.method, p.path) {
			t.Errorf("rejected normal operation %v", p)
		}
	}
}

func TestSessionAndLeaseIndependentOfLifecycle(t *testing.T) {
	s := newService(t.TempDir(), installation{UID: 501})
	s.token = strings.Repeat("a", 64)
	s.lease = time.Now()
	s.mu.Lock()
	done := make(chan int, 1)
	go func() {
		r := httptest.NewRequest("POST", "/v1/lease", bytes.NewReader([]byte("{}")))
		r.Header.Set("X-Momo-Session", s.token)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		done <- w.Code
	}()
	select {
	case code := <-done:
		if code != 200 {
			t.Fatalf("lease status %d", code)
		}
	case <-time.After(time.Second):
		t.Error("lease blocked by lifecycle lock")
	}
	s.mu.Unlock()
	r := httptest.NewRequest("POST", "/v1/core/stop", nil)
	r.Header.Set("X-Momo-Session", "wrong")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("bad token accepted: %d", w.Code)
	}
	r = httptest.NewRequest("POST", "/v1/lease", nil)
	r.Header.Set("Origin", "http://evil.invalid")
	r.Header.Set("X-Momo-Session", s.token)
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("browser origin accepted")
	}
}

func TestSessionRotationExpiry(t *testing.T) {
	s := newService(t.TempDir(), installation{UID: 501})
	r := httptest.NewRequest("POST", "/v1/session", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("session: %s", w.Body.String())
	}
	var token map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &token)
	if len(token["token"]) != 64 {
		t.Fatal("weak session token")
	}
	w = httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("POST", "/v1/session", nil))
	if w.Code != 409 {
		t.Fatal("stole live session")
	}
	s.authMu.Lock()
	s.lease = time.Now().Add(-11 * time.Second)
	s.authMu.Unlock()
	s.expireLease(time.Now())
	if s.token != "" {
		t.Fatal("expired token remained valid")
	}
	w = httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("POST", "/v1/session", nil))
	if w.Code != 200 {
		t.Fatal("could not recover expired session")
	}
	var next map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &next)
	if next["token"] == token["token"] {
		t.Fatal("session token reused")
	}
}

type stalledBody struct {
	started              chan struct{}
	closed               chan struct{}
	startOnce, closeOnce sync.Once
}

func (b *stalledBody) Read([]byte) (int, error) {
	b.startOnce.Do(func() { close(b.started) })
	<-b.closed
	return 0, io.ErrClosedPipe
}
func (b *stalledBody) Close() error { b.closeOnce.Do(func() { close(b.closed) }); return nil }
func TestExpiredLeaseCancelsStalledSnapshot(t *testing.T) {
	s := newService(t.TempDir(), installation{UID: 501})
	s.token = strings.Repeat("b", 64)
	s.lease = time.Now()
	body := &stalledBody{started: make(chan struct{}), closed: make(chan struct{})}
	r := httptest.NewRequest("POST", "/v1/core/start", nil)
	r.Body = body
	r.Header.Set("X-Momo-Session", s.token)
	done := make(chan struct{})
	go func() { s.ServeHTTP(httptest.NewRecorder(), r); close(done) }()
	select {
	case <-body.started:
	case <-time.After(time.Second):
		t.Fatal("request did not begin reading")
	}
	s.authMu.Lock()
	s.lease = time.Now().Add(-11 * time.Second)
	s.authMu.Unlock()
	expired := make(chan struct{})
	go func() { s.expireLease(time.Now()); close(expired) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("expired lease did not interrupt stalled body")
	}
	select {
	case <-expired:
	case <-time.After(time.Second):
		t.Fatal("expiry cleanup remained blocked")
	}
}

func TestBoundedLog(t *testing.T) {
	b := &boundedLog{path: filepath.Join(t.TempDir(), "core.log"), limit: 64}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				if _, err := b.Write([]byte(strings.Repeat("x", 32))); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	i, err := os.Stat(b.path)
	if err != nil {
		t.Fatal(err)
	}
	if i.Size() > 64 {
		t.Fatal("unbounded log")
	}
	if _, err = b.Write([]byte(strings.Repeat("y", 1024))); err != nil {
		t.Fatal(err)
	}
	data, err := b.read()
	if err != nil || data != strings.Repeat("y", 64) {
		t.Fatal("oversize write was not bounded")
	}
}

func TestProtectedTreeAndSnapshotRollback(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("protected filesystem invariants require root; exercised by rootless-container UID0 CI")
	}
	// /tmp and the bind-mounted container /root may be user-writable. Find an
	// already-protected ancestor; never chmod a developer/container home for tests.
	parent := ""
	for _, candidate := range []string{"/root", "/var/lib", "/Library/Application Support"} {
		if err := protectedAncestors(candidate); err == nil {
			parent = candidate
			break
		}
	}
	if parent == "" {
		t.Skip("no root-owned protected test ancestor available")
	}
	root, err := os.MkdirTemp(parent, "momo-helper-test-")
	if err != nil {
		t.Skip(err)
	}
	defer os.RemoveAll(root)
	work := filepath.Join(root, "data")
	if err = os.Mkdir(work, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(work, "cache.db"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	s := newService(root, installation{})
	input := snapshot{Config: "mode: direct\n", Files: []snapshotFile{{Path: "cache.db", Data: base64.StdEncoding.EncodeToString([]byte("new"))}}}
	tx, err := s.stageSnapshot(input)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.finish(false); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(work, "cache.db"))
	if string(b) != "old" {
		t.Fatal("failed to roll back old data")
	}
	input.Files[0].ImportOnly = true
	tx, err = s.stageSnapshot(input)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.finish(true); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(filepath.Join(work, "cache.db"))
	if string(b) != "old" {
		t.Fatal("migration overwrote service state")
	}
	asset := snapshot{Config: "mode: direct\n", Files: []snapshotFile{{Path: "provider.yaml", Data: base64.StdEncoding.EncodeToString([]byte("source"))}}}
	tx, err = s.stageSnapshot(asset)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.finish(true); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(work, "provider.yaml"), []byte("kernel update"), 0600); err != nil {
		t.Fatal(err)
	}
	tx, err = s.stageSnapshot(asset)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.finish(true); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(filepath.Join(work, "provider.yaml"))
	if string(b) != "kernel update" {
		t.Fatal("unchanged source overwrote newer managed asset")
	}
	asset.Files[0].Data = base64.StdEncoding.EncodeToString([]byte("changed source"))
	tx, err = s.stageSnapshot(asset)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.finish(true); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(filepath.Join(work, "provider.yaml"))
	if string(b) != "changed source" {
		t.Fatal("changed source did not update asset")
	}
	if err = os.Symlink("/etc/passwd", filepath.Join(work, "evil")); err != nil {
		t.Fatal(err)
	}
	if _, err = s.stageSnapshot(input); err == nil {
		t.Fatal("accepted symlink in protected tree")
	}
	_ = os.Remove(filepath.Join(work, "evil"))
	if err = os.Link(filepath.Join(work, "cache.db"), filepath.Join(work, "hardlink")); err != nil {
		t.Fatal(err)
	}
	if err = protectedTree(work); err == nil {
		t.Fatal("accepted hardlink in protected tree")
	}
}

type fakeNetwork struct {
	values map[string]networkValue
	calls  int
	failAt int
}

func (f *fakeNetwork) run(args ...string) (string, error) {
	if args[0] == "-listallnetworkservices" {
		return "An asterisk (*) denotes that a network service is disabled.\nWi-Fi", nil
	}
	if strings.HasPrefix(args[0], "-get") {
		kind := strings.TrimPrefix(args[0], "-get")
		v := f.values[kind]
		switch kind {
		case "webproxy", "securewebproxy", "socksfirewallproxy":
			on := "No"
			if v.Enabled {
				on = "Yes"
			}
			return fmt.Sprintf("Enabled: %s\nServer: %s\nPort: %d\nAuthenticated Proxy Enabled: 0", on, v.Host, v.Port), nil
		case "autoproxyurl":
			on := "No"
			if v.Enabled {
				on = "Yes"
			}
			return "URL: " + v.URL + "\nEnabled: " + on, nil
		case "proxyautodiscovery":
			if v.Enabled {
				return "Auto Proxy Discovery: On", nil
			}
			return "Auto Proxy Discovery: Off", nil
		default:
			if len(v.List) == 0 {
				return "There aren't any entries", nil
			}
			return strings.Join(v.List, "\n"), nil
		}
	}
	f.calls++
	if f.failAt == f.calls {
		return "", errors.New("injected command failure")
	}
	for _, kind := range []string{"webproxy", "securewebproxy", "socksfirewallproxy", "autoproxyurl", "proxyautodiscovery", "proxybypassdomains", "dnsservers"} {
		v := f.values[kind]
		switch args[0] {
		case "-set" + kind + "state":
			v.Enabled = args[2] == "on"
		case "-setautoproxystate":
			if kind != "autoproxyurl" {
				continue
			}
			v.Enabled = args[2] == "on"
		case "-set" + kind:
			switch kind {
			case "webproxy", "securewebproxy", "socksfirewallproxy":
				v.Host = args[2]
				_, _ = fmt.Sscanf(args[3], "%d", &v.Port)
				v.Enabled = true
			case "autoproxyurl":
				v.URL = args[2]
				v.Enabled = true
			case "proxyautodiscovery":
				v.Enabled = args[2] == "on"
			default:
				v.List = append([]string{}, args[2:]...)
				if len(v.List) == 1 && v.List[0] == "Empty" {
					v.List = nil
				}
			}
		default:
			continue
		}
		f.values[kind] = v
		return "", nil
	}
	return "", fmt.Errorf("unknown command: %v", args)
}
func TestNetworkCrashIntermediateAndExternalOwnership(t *testing.T) {
	before := networkValue{Enabled: false, Host: "old", Port: 1234}
	f := &fakeNetwork{values: map[string]networkValue{"webproxy": before}, failAt: 2}
	n := newNetwork(t.TempDir(), f.run)
	if err := n.apply("Wi-Fi", "webproxy", networkValue{Enabled: false, Host: "127.0.0.1", Port: 7890}); err == nil {
		t.Fatal("failure injection did not fire")
	}
	// Simulate process death: only the durable journal survives.
	recovered := newNetwork(filepath.Dir(n.path), f.run)
	if err := recovered.restore(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(f.values["webproxy"], before) {
		t.Fatal("lost original after partial mutation")
	}
	if err := recovered.apply("Wi-Fi", "webproxy", networkValue{Enabled: true, Host: "127.0.0.1", Port: 7890}); err != nil {
		t.Fatal(err)
	}
	external := networkValue{Enabled: true, Host: "vpn", Port: 9999}
	f.values["webproxy"] = external
	if err := recovered.restore(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(f.values["webproxy"], external) {
		t.Fatal("overwrote external network change")
	}
}
func TestNetworkRestoreFailureRetainsJournal(t *testing.T) {
	before := networkValue{Enabled: true, URL: "http://old/pac"}
	f := &fakeNetwork{values: map[string]networkValue{"autoproxyurl": before}}
	n := newNetwork(t.TempDir(), f.run)
	if err := n.apply("Wi-Fi", "autoproxyurl", networkValue{Enabled: false, URL: "http://127.0.0.1/pac"}); err != nil {
		t.Fatal(err)
	}
	f.failAt = f.calls + 2
	if err := n.restore(); err == nil {
		t.Fatal("restore failure not reported")
	}
	fresh := newNetwork(filepath.Dir(n.path), f.run)
	if err := fresh.restore(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(f.values["autoproxyurl"], before) {
		t.Fatal("failed to resume interrupted restoration")
	}
}

func TestPACEmptyURLRestorationUsesNativeClear(t *testing.T) {
	before := networkValue{Enabled: false, URL: "(null)"}
	unrelated := networkValue{Enabled: true, Host: "other", Port: 8888}
	f := &fakeNetwork{values: map[string]networkValue{"autoproxyurl": before, "webproxy": unrelated}}
	n := newNetwork(t.TempDir(), f.run)
	cleared := 0
	n.clearPAC = func(service string) error {
		if service != "Wi-Fi" {
			t.Fatal("cleared wrong service")
		}
		v := f.values["autoproxyurl"]
		v.URL = "(null)"
		f.values["autoproxyurl"] = v
		cleared++
		return nil
	}
	if err := n.apply("Wi-Fi", "autoproxyurl", networkValue{Enabled: true, URL: "http://127.0.0.1/pac"}); err != nil {
		t.Fatal(err)
	}
	if err := n.restore(); err != nil {
		t.Fatal(err)
	}
	if cleared != 1 || !reflect.DeepEqual(f.values["autoproxyurl"], before) {
		t.Fatal("empty saved PAC URL was not cleared/restored")
	}
	if !reflect.DeepEqual(f.values["webproxy"], unrelated) {
		t.Fatal("PAC clearing changed unrelated proxy settings")
	}
}

func TestManualEmptyAddressRestorationUsesNativeClear(t *testing.T) {
	for _, kind := range []string{"webproxy", "securewebproxy", "socksfirewallproxy"} {
		t.Run(kind, func(t *testing.T) {
			f := &fakeNetwork{values: map[string]networkValue{kind: {}, "autoproxyurl": {URL: "http://other/pac", Enabled: true}}}
			n := newNetwork(t.TempDir(), f.run)
			cleared := 0
			n.clearAddress = func(service, k string) error {
				if service != "Wi-Fi" || k != kind {
					t.Fatal("cleared wrong fields")
				}
				v := f.values[k]
				v.Host = ""
				v.Port = 0
				f.values[k] = v
				cleared++
				return nil
			}
			if err := n.apply("Wi-Fi", kind, networkValue{Enabled: true, Host: "127.0.0.1", Port: 17894}); err != nil {
				t.Fatal(err)
			}
			if err := n.restore(); err != nil {
				t.Fatal(err)
			}
			if cleared != 1 || !reflect.DeepEqual(f.values[kind], networkValue{}) {
				t.Fatal("empty proxy address not restored")
			}
			if f.values["autoproxyurl"].URL != "http://other/pac" {
				t.Fatal("cleared unrelated PAC URL")
			}
		})
	}
}

func TestProcessFixture(t *testing.T) {
	if os.Getenv("MOMO_HELPER_PROCESS_FIXTURE") != "1" {
		return
	}
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT)
	fmt.Fprintln(os.Stdout, "ready")
	<-ch
	os.Exit(0)
}

func TestRecoveryNeverSignalsReusedPID(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestProcessFixture$")
	cmd.Env = append(os.Environ(), "MOMO_HELPER_PROCESS_FIXTURE=1")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	ready := make([]byte, 6)
	if _, err = out.Read(ready); err != nil {
		t.Fatal(err)
	}
	identity, err := processIdentity(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err = writeJSON(filepath.Join(root, "process.json"), processRecord{PID: cmd.Process.Pid, Identity: identity + "-different-start"}); err != nil {
		t.Fatal(err)
	}
	if err = recoverOwnedProcess(root); err != nil {
		t.Fatal(err)
	}
	if current, err := processIdentity(cmd.Process.Pid); err != nil || current != identity {
		t.Fatal("mismatched recovery record signalled unrelated process")
	}
	if err = writeJSON(filepath.Join(root, "process.json"), processRecord{PID: cmd.Process.Pid, Identity: identity}); err != nil {
		t.Fatal(err)
	}
	// Reap concurrently, as launchd does for a recovered orphan. Linux zombies
	// otherwise retain their process identity until their parent waits.
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	if err = recoverOwnedProcess(root); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("owned process survived recovery")
	}
	if _, err = os.Stat(filepath.Join(root, "process.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("recovery record not removed")
	}
}
