//go:build tizi

package tizi

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testKeys(t *testing.T) {
	t.Helper()
	before := BuildKeys
	BuildKeys = "test:" + base64.StdEncoding.EncodeToString(make([]byte, 32))
	t.Cleanup(func() { BuildKeys = before })
}
func TestEncryptedFilesTamperAndRotation(t *testing.T) {
	testKeys(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	original := map[string]string{"node": "private-host.example", "credential": "private-credential"}
	if e := writeEncrypted(dir, "subscription.enc", original); e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile(filepath.Join(dir, "subscription.enc"))
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(raw), "private-") {
		t.Fatal("plaintext leaked")
	}
	var read map[string]string
	if e = readEncrypted(dir, "subscription.enc", &read); e != nil || read["node"] != original["node"] {
		t.Fatalf("roundtrip: %v", e)
	}
	old := BuildKeys
	BuildKeys = "new:" + base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", 32))) + "," + old
	if e = readEncrypted(dir, "subscription.enc", &read); e != nil {
		t.Fatal("old key not readable", e)
	}
	var envelope sealedFile
	_ = json.Unmarshal(raw, &envelope)
	envelope.Data[0] ^= 1
	raw, _ = json.Marshal(envelope)
	_ = os.WriteFile(filepath.Join(dir, "subscription.enc"), raw, 0600)
	if e = readEncrypted(dir, "subscription.enc", &read); e == nil {
		t.Fatal("tamper accepted")
	}
}
func TestManagedWrapperPrivateAndRestricted(t *testing.T) {
	testKeys(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	_ = writeEncrypted(dir, "identity.enc", identity{ServerURL: "https://example.com", PrivateKey: key, LoggedIn: true})
	_ = writeEncrypted(dir, "subscription.enc", subscription{YAML: "proxies: []\nexternal-controller: ':9090'\nexternal-controller-tls: ':9443'\nexternal-ui: /tmp/dashboard\n"})
	_ = writeEncrypted(dir, "ledger.enc", ledgerState{})
	wrapper := []byte("tizi-managed:\n  state-dir: " + dir + "\nmixed-port: 7890\nexternal-controller: ':1234'\n")
	out, got, e := ExpandConfig(wrapper)
	if e != nil || got != dir {
		t.Fatalf("expand %s %v", out, e)
	}
	if strings.Contains(string(out), ":9090") || strings.Contains(string(out), ":1234") || strings.Contains(string(out), ":9443") || strings.Contains(string(out), "/tmp/dashboard") {
		t.Fatal("controller exposed")
	}
	if _, _, e = ExpandConfig(append(wrapper, []byte("proxies: []\n")...)); e == nil {
		t.Fatal("node overrides allowed")
	}
	_ = os.WriteFile(filepath.Join(dir, "ledger.enc"), []byte("corrupt"), 0600)
	if _, _, e = ExpandConfig(wrapper); e == nil {
		t.Fatal("corrupt ledger accepted")
	}
}
func TestEnrollmentFetchesHeaderAndProtectsCache(t *testing.T) {
	testKeys(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/login":
			var in map[string]string
			_ = json.NewDecoder(r.Body).Decode(&in)
			if r.Header.Get("X-Tizi-Signature") == "" {
				t.Error("no signature")
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"email": in["email"], "device_id": in["device_id"]})
		case "/v1/subscription":
			w.Header().Set("Subscription-Userinfo", "upload=123; download=456; total=10000; expire=2000000000")
			_, _ = w.Write([]byte("proxies: []\nrules: [MATCH,DIRECT]\n"))
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	res, e := runCommand(dir, "login", map[string]any{"server_url": server.URL, "email": "person@example.com", "password": "a private password", "device_name": "test"})
	if e != nil {
		t.Fatal(e)
	}
	status := res.(map[string]any)
	if status["logged_in"] != true {
		t.Fatal(status)
	}
	if status["subscription"].(map[string]int64)["download"] != 456 {
		t.Fatal("header lost")
	}
	for _, name := range []string{"identity.enc", "subscription.enc", "ledger.enc"} {
		info, e := os.Stat(filepath.Join(dir, name))
		if e != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("unsafe file %s", name)
		}
	}
}
func TestServerOriginValidation(t *testing.T) {
	for _, raw := range []string{"http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?token=x"} {
		if _, e := serverURL(raw); e == nil {
			t.Fatal("unsafe origin accepted", raw)
		}
	}
}

func TestServiceResponseSizeBound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(strings.Repeat("x", (10<<20)+1))) }))
	defer server.Close()
	if _, _, err := call(nil, server.URL, "GET", "/oversized", nil, false); err == nil {
		t.Fatal("oversized response accepted")
	}
}

func TestRuntimeCheckpointsDuringSlowReportAndCancels(t *testing.T) {
	testKeys(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	}))
	defer server.Close()
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	id := identity{ServerURL: server.URL, DeviceID: "test-device", PrivateKey: private, LoggedIn: true}
	if err = writeEncrypted(dir, "identity.enc", id); err != nil {
		t.Fatal(err)
	}
	if err = writeEncrypted(dir, "ledger.enc", ledgerState{Health: map[string]any{"complete": true}}); err != nil {
		t.Fatal(err)
	}
	if err = Configure(dir, map[string]bool{"paid-node": true}); err != nil {
		t.Fatal(err)
	}
	defer Close()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("report did not start")
	}
	meter := Capture([]string{"paid-node"}, true)
	if meter == nil {
		t.Fatal("no meter")
	}
	meter.Add(1234, 5678)
	deadline := time.Now().Add(4 * time.Second)
	persisted := false
	for time.Now().Before(deadline) {
		var saved ledgerState
		if readEncrypted(dir, "ledger.enc", &saved) == nil {
			for _, day := range saved.Days {
				if day.UploadBytes == 1234 && day.DownloadBytes == 5678 {
					persisted = true
				}
			}
		}
		if persisted {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !persisted {
		t.Fatal("slow network blocked per-second checkpoint")
	}
	before := time.Now()
	Close()
	if time.Since(before) > 2*time.Second {
		t.Fatal("shutdown waited for network timeout")
	}
}

func TestDelayedReceiptDoesNotHideNewlyClosedDay(t *testing.T) {
	// The 06:59:59 request covers dates before Oct29. Its receipt arrives after
	// the Oct30 07:00 boundary, so Oct29 is still due despite a fresh LastSync.
	receivedAt := time.Date(2026, 10, 30, 7, 0, 10, 0, settlementLocation)
	state := ledgerState{Sequence: 7, Ack: 7, LastSync: receivedAt.Unix(), ReportCutoff: "2026-10-29", Days: []DayUsage{{Day: "2026-10-28"}, {Day: "2026-10-29"}, {Day: "2026-10-30"}}}
	if got := pendingDaysAt(state, receivedAt); got != 1 {
		t.Fatalf("pending=%d want1", got)
	}
	if state.ReportCutoff == SettlementDay(receivedAt) {
		t.Fatal("late receipt suppressed new day report")
	}
}
