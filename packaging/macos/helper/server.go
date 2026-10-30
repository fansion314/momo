package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type service struct {
	mu               sync.Mutex
	authMu           sync.Mutex
	root, work       string
	install          installation
	token            string
	lease            time.Time
	generation       uint64
	operationCancel  context.CancelFunc
	operationContext context.Context
	cmd              *exec.Cmd
	identity         string
	done             chan struct{}
	running          atomic.Bool
	ageKey           string
	logs             *boundedLog
	network          *networkManager
	coreClient       *http.Client
	proxy            *httputil.ReverseProxy
	server           *http.Server
}

func newCoreRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	return http.NewRequestWithContext(ctx, method, "http://core"+path, body)
}

func newService(root string, i installation) *service {
	s := &service{root: root, work: filepath.Join(root, "data"), install: i}
	s.logs = &boundedLog{path: filepath.Join(root, "core.log"), limit: 4 << 20}
	s.network = newNetwork(root, runNetworksetup)
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", filepath.Join(s.work, "core.sock"))
	}, MaxIdleConns: 8, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 15 * time.Second}
	s.coreClient = &http.Client{Transport: transport, Timeout: 35 * time.Second}
	s.proxy = &httputil.ReverseProxy{Transport: transport, Rewrite: func(pr *httputil.ProxyRequest) {
		pr.Out.URL.Scheme = "http"
		pr.Out.URL.Host = "core"
		pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, "/core")
		pr.Out.URL.RawPath = ""
		pr.Out.Host = "core"
		pr.Out.Header.Del("X-Momo-Session")
		pr.Out.Header.Del("Authorization")
		pr.Out.Header.Del("Cookie")
	}, ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) { http.Error(w, "managed core unavailable", 502) }}
	return s
}

func serve() error {
	if err := protectedTree(stateRoot); err != nil {
		return err
	}
	i, err := loadInstallation()
	if err != nil {
		return err
	}
	selfHash, err := fileHash(helperPath)
	if err != nil || selfHash != i.HelperHash {
		return errors.New("installed helper hash mismatch; authorize installation again")
	}
	coreHash, err := fileHash(filepath.Join(stateRoot, "mihomomo"))
	if err != nil || coreHash != i.CoreHash {
		return errors.New("installed core hash mismatch; authorize installation again")
	}
	if err = recoverOwnedProcess(stateRoot); err != nil {
		return err
	}
	s := newService(stateRoot, i)
	if err = s.network.restore(); err != nil {
		return err
	}
	// /private/var/run is group-writable on macOS. Keep IPC under the existing
	// root-only mutable PrivilegedHelperTools parent instead of weakening checks.
	base := filepath.Dir(socketDir)
	dir := socketDir
	if err = protectedAncestors(base); err != nil {
		return err
	}
	if _, e := os.Lstat(dir); errors.Is(e, os.ErrNotExist) {
		if e = os.Mkdir(dir, 0711); e != nil {
			return e
		}
	} else if e != nil {
		return e
	}
	// Only the directory is root-owned; its socket is intentionally UID-bound.
	// A stale socket must not prevent launchd from recovering after SIGKILL.
	if err = protectedAncestors(dir); err != nil {
		return err
	}
	sock := filepath.Join(dir, "helper.sock")
	if info, e := os.Lstat(sock); e == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("unexpected helper socket path")
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || (stat.Uid != 0 && stat.Uid != uint32(i.UID)) {
			return errors.New("unexpected stale socket owner")
		}
		if e = os.Remove(sock); e != nil {
			return e
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		return err
	}
	defer l.Close()
	// Parent cannot be renamed by authorized app; traversal only. Socket itself
	// grants access exclusively to the admin-selected UID.
	if err = os.Chmod(dir, 0711); err != nil {
		return err
	}
	if err = os.Chown(sock, i.UID, -1); err != nil {
		return err
	}
	if err = os.Chmod(sock, 0600); err != nil {
		return err
	}
	listener := &uidListener{UnixListener: l, uid: i.UID}
	s.server = &http.Server{Handler: s, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 90 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				s.expireLease(time.Now())
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		<-ctx.Done()
		_ = s.server.Close()
		s.mu.Lock()
		defer s.mu.Unlock()
		_ = s.stopCore()
		_ = s.network.restore()
	}()
	err = s.server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if e := s.stopCore(); e != nil {
			return e
		}
		return s.network.restore()
	}
	return err
}

type uidListener struct {
	*net.UnixListener
	uid int
}

func (l *uidListener) Accept() (net.Conn, error) {
	for {
		c, err := l.AcceptUnix()
		if err != nil {
			return nil, err
		}
		uid, err := peerUID(c)
		if err == nil && uid == l.uid {
			return c, nil
		}
		_ = c.Close()
	}
}

func (s *service) expireLease(now time.Time) {
	s.authMu.Lock()
	expired := s.token != "" && now.Sub(s.lease) > 10*time.Second
	generation := s.generation
	if expired {
		s.token = ""
		if s.operationCancel != nil {
			s.operationCancel()
		}
	}
	s.authMu.Unlock()
	if expired {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.authMu.Lock()
		stillExpired := s.generation == generation && s.token == ""
		s.authMu.Unlock()
		if !stillExpired {
			return
		}
		_ = s.stopCore()
		_ = s.network.restore()
	}
}
func sessionMatches(expected, actual string) bool {
	return expected != "" && len(expected) == len(actual) && subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}
func decode(w http.ResponseWriter, r *http.Request, out any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 768<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("expected one JSON object")
	}
	return nil
}
func respond(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (s *service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// A browser Origin must never be able to drive a privileged service, even if
	// a future browser acquires Unix-domain transports. There is no CORS grant.
	if r.Header.Get("Origin") != "" {
		http.Error(w, "browser origins are forbidden", 403)
		return
	}
	// Keep leases independent of slow snapshot validation and core stop/start.
	if r.Method == http.MethodPost && r.URL.Path == "/v1/lease" {
		s.authMu.Lock()
		defer s.authMu.Unlock()
		if !sessionMatches(s.token, r.Header.Get("X-Momo-Session")) || time.Since(s.lease) > 10*time.Second {
			http.Error(w, "session required", 401)
			return
		}
		s.lease = time.Now()
		respond(w, map[string]bool{"ok": true, "running": s.running.Load()})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.Method == http.MethodGet && r.URL.Path == "/v1/status" {
		pid := 0
		if s.cmd != nil {
			pid = s.cmd.Process.Pid
		}
		_, err := os.Stat(filepath.Join(s.root, "migrated"))
		respond(w, map[string]any{"protocol": 1, "helperVersion": helperVersion, "coreVersion": s.install.CoreVersion, "helperHash": s.install.HelperHash, "coreHash": s.install.CoreHash, "running": s.cmd != nil, "pid": pid, "workDir": s.work, "uid": s.install.UID, "dataMigrated": err == nil})
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/v1/session" {
		s.authMu.Lock()
		defer s.authMu.Unlock()
		if s.token != "" && time.Since(s.lease) <= 10*time.Second {
			http.Error(w, "an application session is already active", 409)
			return
		}
		if err := s.stopCore(); err != nil {
			http.Error(w, "cannot stop previous core", 503)
			return
		}
		if err := s.network.restore(); err != nil {
			http.Error(w, "cannot restore previous network settings", 503)
			return
		}
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			http.Error(w, "cannot create session", 500)
			return
		}
		s.token = hex.EncodeToString(b)
		s.generation++
		s.lease = time.Now()
		respond(w, map[string]string{"token": s.token})
		return
	}
	s.authMu.Lock()
	authorized := sessionMatches(s.token, r.Header.Get("X-Momo-Session")) && time.Since(s.lease) <= 10*time.Second
	s.authMu.Unlock()
	if !authorized {
		http.Error(w, "session required", 401)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/core/") {
		if s.cmd == nil {
			http.Error(w, "managed core is not running", 503)
			return
		}
		if !allowedCoreRoute(r.Method, strings.TrimPrefix(r.URL.Path, "/core")) {
			http.Error(w, "operation forbidden", 403)
			return
		}
		// The reverse proxy can hold an upgraded WebSocket for hours. Do not hold
		// the lifecycle mutex while copying traffic; expiry still stops its core.
		s.mu.Unlock()
		s.proxy.ServeHTTP(w, r)
		s.mu.Lock()
		return
	}
	opctx, cancel := context.WithCancel(r.Context())
	s.operationContext = opctx
	s.authMu.Lock()
	if !sessionMatches(s.token, r.Header.Get("X-Momo-Session")) || time.Since(s.lease) > 10*time.Second {
		s.authMu.Unlock()
		cancel()
		s.operationContext = nil
		http.Error(w, "session required", 401)
		return
	}
	s.operationCancel = cancel
	s.authMu.Unlock()
	// Closing an in-flight upload unblocks JSON decoding after lease expiry.
	closed := make(chan struct{})
	go func() {
		select {
		case <-opctx.Done():
			_ = r.Body.Close()
		case <-closed:
		}
	}()
	defer func() {
		close(closed)
		cancel()
		s.authMu.Lock()
		s.operationCancel = nil
		s.authMu.Unlock()
		s.operationContext = nil
	}()
	var err error
	switch {
	case r.Method == http.MethodPost && (r.URL.Path == "/v1/core/start" || r.URL.Path == "/v1/core/config"):
		var input snapshot
		err = decode(w, r, &input)
		if err == nil {
			err = s.applySnapshot(input, r.URL.Path == "/v1/core/start")
		}
	case r.Method == http.MethodPost && r.URL.Path == "/v1/core/stop":
		err = s.stopCore()
		if e := s.network.restore(); e != nil {
			err = errors.Join(err, e)
		}
	case r.Method == http.MethodGet && r.URL.Path == "/v1/core/logs":
		var logs string
		logs, err = s.logs.read()
		if err == nil {
			respond(w, map[string]string{"logs": logs})
			return
		}
	case r.Method == http.MethodGet && r.URL.Path == "/v1/core/state":
		if s.cmd != nil {
			http.Error(w, "stop the managed core before exporting state", 409)
			return
		}
		var files []snapshotFile
		files, err = s.exportState()
		if err == nil {
			respond(w, map[string]any{"files": files})
			return
		}
	case r.Method == http.MethodPost && r.URL.Path == "/v1/network/proxy":
		var p proxyRequest
		err = decode(w, r, &p)
		if err == nil {
			err = s.network.proxy(p)
		}
	case r.Method == http.MethodPost && r.URL.Path == "/v1/network/dns":
		var d dnsRequest
		err = decode(w, r, &d)
		if err == nil {
			err = s.network.dns(d)
		}
	case r.Method == http.MethodGet && r.URL.Path == "/v1/network/status":
		respond(w, s.network.status())
		return
	default:
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	respond(w, map[string]bool{"ok": true})
}

func allowedCoreRoute(method, path string) bool {
	unescaped, err := url.PathUnescape(path)
	if err != nil || unescaped != path || strings.Contains(path, "..") || strings.ContainsAny(path, "\\\x00") {
		return false
	}
	if method == http.MethodGet {
		for _, base := range []string{"/", "/version", "/configs", "/proxies", "/providers/proxies", "/providers/rules", "/rules", "/connections", "/traffic", "/logs", "/memory", "/dns/query", "/group", "/traffic-history", "/smart"} {
			if path == base || (base != "/" && strings.HasPrefix(path, base+"/")) {
				return true
			}
		}
	}
	if method == http.MethodPatch && path == "/configs" {
		return true
	}
	if method == http.MethodDelete && (path == "/connections" || strings.HasPrefix(path, "/connections/")) {
		return true
	}
	if method == http.MethodPut {
		return strings.HasPrefix(path, "/proxies/") || strings.HasPrefix(path, "/providers/proxies/") || strings.HasPrefix(path, "/providers/rules/")
	}
	if method == http.MethodPost {
		return path == "/configs/geo" || path == "/cache/fakeip/flush" || path == "/cache/dns/flush" || path == "/connections" || strings.HasPrefix(path, "/smart/")
	}
	return false
}
