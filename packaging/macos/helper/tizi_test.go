package main

import (
	"bytes"
	"encoding/base64"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTiziActionAllowlist(t *testing.T) {
	for _, action := range []string{"decrypt", "export", "seal", "/bin/sh", "", "status\nlogin", "../usage"} {
		if allowedTiziAction(action) {
			t.Fatalf("unsafe action accepted: %q", action)
		}
	}
	for _, action := range []string{"status", "login", "logout", "sync", "usage", "refresh", "registration-status"} {
		if !allowedTiziAction(action) {
			t.Fatalf("account operation missing: %q", action)
		}
	}
}

func TestTiziBridgeRequiresSessionAndRejectsOverrides(t *testing.T) {
	s := newService(t.TempDir(), installation{UID: 501})
	s.token = strings.Repeat("a", 64)
	s.lease = time.Now()
	for _, tc := range []struct {
		body, token, origin string
		want                int
	}{
		{`{"action":"status","payload":{}}`, "wrong", "", 401},
		{`{"action":"status","payload":{}}`, s.token, "http://evil.invalid", 403},
		{`{"action":"decrypt","payload":{}}`, s.token, "", 400},
		{`{"action":"status","payload":{"state_dir":"/etc"}}`, s.token, "", 400},
		{`{"action":"status","payload":{}} {}`, s.token, "", 400},
		{`{"action":"status","payload":{},"path":"/bin/sh"}`, s.token, "", 400},
	} {
		r := httptest.NewRequest("POST", "/v1/tizi/action", strings.NewReader(tc.body))
		r.Header.Set("X-Momo-Session", tc.token)
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("%s: status %d want %d", tc.body, w.Code, tc.want)
		}
	}
}

func TestTiziOutputBound(t *testing.T) {
	var b limitedTiziOutput
	if _, err := b.Write(bytes.Repeat([]byte("x"), 4<<20)); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Write([]byte("x")); err == nil {
		t.Fatal("unbounded native output accepted")
	}
}

func TestTiziSnapshotCannotReplaceAccountState(t *testing.T) {
	root := protectedTestRoot(t)
	for _, dir := range []string{"data", "tizi"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	ledger := filepath.Join(root, "tizi", "ledger.enc")
	if err := os.WriteFile(ledger, []byte("original sealed accounting"), 0600); err != nil {
		t.Fatal(err)
	}
	s := newService(root, installation{})
	input := snapshot{Config: "mode: direct\n", Files: []snapshotFile{{Path: "../tizi/ledger.enc", Data: base64.StdEncoding.EncodeToString([]byte("overwrite"))}}}
	if _, err := s.stageSnapshot(input); err == nil {
		t.Fatal("account path traversal accepted")
	}
	input.Files[0].Path = "tizi/ledger.enc"
	tx, err := s.stageSnapshot(input)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.finish(true); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(ledger)
	if err != nil || string(data) != "original sealed accounting" {
		t.Fatal("snapshot replaced account state outside data directory")
	}
}

type observedTiziBody struct {
	io.ReadCloser
	started chan struct{}
	once    sync.Once
}

func (b *observedTiziBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.started) })
	return b.ReadCloser.Read(p)
}

func TestTiziNetworkOperationsDoNotBlockLifecycleAndExpireWithLease(t *testing.T) {
	s := newService(t.TempDir(), installation{UID: 501})
	s.token = strings.Repeat("a", 64)
	s.lease = time.Now()
	var done []chan struct{}
	for i := 0; i < 2; i++ {
		reader, writer := io.Pipe()
		t.Cleanup(func() { _ = writer.Close(); _ = reader.Close() })
		body := &observedTiziBody{ReadCloser: reader, started: make(chan struct{})}
		r := httptest.NewRequest("POST", "/v1/tizi/action", body)
		r.Header.Set("X-Momo-Session", s.token)
		finished := make(chan struct{})
		done = append(done, finished)
		go func() { s.ServeHTTP(httptest.NewRecorder(), r); close(finished) }()
		select {
		case <-body.started:
		case <-time.After(time.Second):
			t.Fatal("account request never started")
		}
	}
	statusDone := make(chan struct{})
	go func() {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("GET", "/v1/status", nil))
		close(statusDone)
	}()
	select {
	case <-statusDone:
	case <-time.After(time.Second):
		t.Fatal("slow account request blocked local lifecycle status")
	}
	s.expireLease(time.Now().Add(11 * time.Second))
	for _, finished := range done {
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Fatal("expired lease left an account request running")
		}
	}
	s.authMu.Lock()
	defer s.authMu.Unlock()
	if len(s.tiziOperations) != 0 {
		t.Fatal("completed account operations leaked")
	}
}
