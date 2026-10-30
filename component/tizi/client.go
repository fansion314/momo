//go:build tizi

package tizi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/uuid/v5"
	"go.yaml.in/yaml/v3"
)

type serviceError struct{ Status int }

func (e *serviceError) Error() string {
	return fmt.Sprintf("Tizi service rejected request (HTTP %d)", e.Status)
}

type identity struct {
	ServerURL  string `json:"server_url"`
	DeviceID   string `json:"device_id"`
	PrivateKey []byte `json:"private_key"`
	Email      string `json:"email"`
	LoggedIn   bool   `json:"logged_in"`
}
type subscription struct {
	YAML      string           `json:"yaml"`
	Info      map[string]int64 `json:"info"`
	UpdatedAt int64            `json:"updated_at"`
}

func field(in map[string]any, key string) string { v, _ := in[key].(string); return v }
func serverURL(raw string) (string, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
		return "", errors.New("Invalid tizi server origin")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")) {
		return "", errors.New("Tizi requires HTTPS")
	}
	return strings.TrimRight(u.String(), "/"), nil
}
func call(id *identity, origin, method, path string, body any, signed bool) ([]byte, http.Header, error) {
	return callContext(context.Background(), id, origin, method, path, body, signed)
}
func callContext(ctx context.Context, id *identity, origin, method, path string, body any, signed bool) ([]byte, http.Header, error) {
	var payload []byte
	var e error
	if body != nil {
		payload, e = json.Marshal(body)
		if e != nil {
			return nil, nil, e
		}
	}
	req, e := http.NewRequestWithContext(ctx, method, origin+path, bytes.NewReader(payload))
	if e != nil {
		return nil, nil, errors.New("Invalid service request")
	}
	req.Header.Set("Content-Type", "application/json")
	if signed {
		if id == nil || len(id.PrivateKey) != ed25519.PrivateKeySize {
			return nil, nil, errors.New("Device is not enrolled")
		}
		nonce := uuid.Must(uuid.NewV4()).String()
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		hash := sha256.Sum256(payload)
		input := strings.Join([]string{"TIZI1", method, path, id.DeviceID, ts, nonce, hex.EncodeToString(hash[:])}, "\n")
		req.Header.Set("X-Tizi-Device", id.DeviceID)
		req.Header.Set("X-Tizi-Timestamp", ts)
		req.Header.Set("X-Tizi-Nonce", nonce)
		req.Header.Set("X-Tizi-Signature", base64.StdEncoding.EncodeToString(ed25519.Sign(id.PrivateKey, []byte(input))))
	}
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return errors.New("Tizi redirects are forbidden") }, Transport: &http.Transport{Proxy: nil, DialContext: serviceDialContext, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 20 * time.Second}}
	defer client.CloseIdleConnections()
	resp, e := client.Do(req)
	if e != nil {
		return nil, nil, errors.New("Tizi service is unreachable; cached subscription remains available")
	}
	defer resp.Body.Close()
	data, e := io.ReadAll(io.LimitReader(resp.Body, 10<<20+1))
	if e != nil || len(data) > 10<<20 {
		return nil, nil, errors.New("Invalid service response")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil, &serviceError{resp.StatusCode}
	}
	return data, resp.Header, nil
}
func loadIdentity(dir string) (*identity, error) {
	var id identity
	e := readEncrypted(dir, "identity.enc", &id)
	if e != nil {
		return nil, e
	}
	if len(id.PrivateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("Corrupt device identity")
	}
	if _, e = serverURL(id.ServerURL); e != nil {
		return nil, e
	}
	return &id, nil
}
func refresh(dir string, id *identity) error { return refreshContext(context.Background(), dir, id) }
func refreshContext(ctx context.Context, dir string, id *identity) error {
	data, h, e := callContext(ctx, id, id.ServerURL, "GET", "/v1/subscription", nil, true)
	if e != nil {
		return e
	}
	var config map[string]any
	if e = yaml.Unmarshal(data, &config); e != nil || len(config) == 0 {
		return errors.New("Invalid subscription YAML")
	}
	if _, ok := config["tizi-managed"]; ok {
		return errors.New("Nested managed subscription forbidden")
	}
	if p, ok := config["proxy-providers"]; ok && p != nil {
		return errors.New("Managed subscription must contain inline nodes, not proxy provider caches")
	}
	if p, ok := config["script"]; ok && p != nil {
		return errors.New("Managed subscription scripts are forbidden")
	}
	info := map[string]int64{}
	for _, part := range strings.Split(h.Get("Subscription-Userinfo"), ";") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		n, e := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		if e == nil && n >= 0 && (k == "upload" || k == "download" || k == "total" || k == "expire") {
			info[k] = n
		}
	}
	return writeEncrypted(dir, "subscription.enc", subscription{string(data), info, time.Now().Unix()})
}
func status(dir string) (map[string]any, error) {
	_, _, keyErr := keyRing()
	out := map[string]any{"supported": true, "keyReady": keyErr == nil, "logged_in": false, "managed_config_version": 2}
	if keyErr != nil {
		return out, nil
	}
	id, e := loadIdentity(dir)
	if os.IsNotExist(e) {
		return out, nil
	}
	if e != nil {
		return nil, e
	}
	out["logged_in"] = id.LoggedIn
	out["email"] = id.Email
	out["device_id"] = id.DeviceID
	out["server_url"] = id.ServerURL
	var sub subscription
	if e = readEncrypted(dir, "subscription.enc", &sub); e == nil {
		out["subscription"] = sub.Info
		out["subscription_updated_at"] = sub.UpdatedAt
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	var ledger ledgerState
	if e = readEncrypted(dir, "ledger.enc", &ledger); e == nil {
		out["last_sync_at"] = ledger.LastSync
		out["pending_days"] = pendingDays(ledger)
		out["health"] = "healthy"
		if complete, ok := ledger.Health["complete"].(bool); !ok {
			out["health"] = "unknown"
		} else if !complete {
			out["health"] = "incomplete"
		}
		out["health_details"] = ledger.Health
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	return out, nil
}
func runCommand(dir, command string, in map[string]any) (any, error) {
	if in != nil && field(in, "email") != "" {
		in["email"] = strings.ToLower(strings.TrimSpace(field(in, "email")))
	}
	if e := validateDir(dir); e != nil {
		return nil, e
	}
	if command == "status" {
		return status(dir)
	}
	if _, _, e := keyRing(); e != nil {
		return nil, e
	}
	public := map[string]string{"register": "/v1/registration/request", "registration-status": "/v1/registration/status", "complete-registration": "/v1/registration/complete", "reset-request": "/v1/password/request", "reset-confirm": "/v1/password/reset"}
	if path, ok := public[command]; ok {
		origin, e := serverURL(field(in, "server_url"))
		if e != nil {
			return nil, e
		}
		body := map[string]any{}
		for _, k := range []string{"email", "request_id", "password", "code"} {
			if v, ok := in[k]; ok {
				body[k] = v
			}
		}
		data, _, e := call(nil, origin, "POST", path, body, false)
		if e != nil {
			return nil, e
		}
		var result any
		e = json.Unmarshal(data, &result)
		return result, e
	}
	if command == "login" || command == "logout" {
		release, e := acquire(dir, "identity.lock")
		if e != nil {
			return nil, e
		}
		defer release()
		if running(dir) {
			return nil, errors.New("Stop the managed core before changing device login")
		}
	}
	if command == "login" {
		origin, e := serverURL(field(in, "server_url"))
		if e != nil {
			return nil, e
		}
		id, e := loadIdentity(dir)
		if os.IsNotExist(e) {
			_, private, e2 := ed25519.GenerateKey(rand.Reader)
			if e2 != nil {
				return nil, e2
			}
			id = &identity{DeviceID: uuid.Must(uuid.NewV4()).String(), PrivateKey: private}
		} else if e != nil {
			return nil, e
		}
		if id.Email != "" && (id.Email != field(in, "email") || id.ServerURL != origin) {
			return nil, errors.New("This installation is bound to a different account; use a separate state directory")
		}
		if id.Email != "" {
			var existingLedger ledgerState
			if e = readEncrypted(dir, "ledger.enc", &existingLedger); e != nil {
				return nil, errors.New("Existing tizi accounting ledger is missing or corrupt; restore it before login")
			}
		}
		id.ServerURL = origin
		body := map[string]any{"email": field(in, "email"), "password": field(in, "password"), "device_id": id.DeviceID, "public_key": base64.StdEncoding.EncodeToString(ed25519.PrivateKey(id.PrivateKey).Public().(ed25519.PublicKey)), "device_name": field(in, "device_name")}
		data, _, e := call(id, origin, "POST", "/v1/login", body, true)
		if e != nil {
			return nil, e
		}
		var res struct {
			Email    string `json:"email"`
			DeviceID string `json:"device_id"`
		}
		if e = json.Unmarshal(data, &res); e != nil || res.DeviceID != id.DeviceID || res.Email == "" {
			return nil, errors.New("Invalid enrollment response")
		}
		id.Email = res.Email
		id.LoggedIn = true

		if _, e = os.Stat(filepath.Join(dir, "ledger.enc")); os.IsNotExist(e) {
			if e = writeEncrypted(dir, "ledger.enc", ledgerState{Health: map[string]any{"complete": true}}); e != nil {
				return nil, e
			}
		}

		if e = writeEncrypted(dir, "identity.enc", id); e != nil {
			return nil, e
		}
		if e = refresh(dir, id); e != nil {
			return nil, e
		}
		return status(dir)
	}
	id, e := loadIdentity(dir)
	if e != nil {
		return nil, e
	}
	switch command {
	case "logout":
		if e = syncOfflineDays(dir, id, true); e != nil {
			return nil, e
		}
		id.LoggedIn = false
		if e = writeEncrypted(dir, "identity.enc", id); e != nil {
			return nil, e
		}
		return status(dir)
	case "refresh":
		if !id.LoggedIn {
			return nil, errors.New("Login required")
		}
		if e = refresh(dir, id); e != nil {
			return nil, e
		}
		return status(dir)
	case "sync":
		if running(dir) {
			if e = os.WriteFile(filepath.Join(dir, "sync.request"), nil, 0600); e != nil {
				return nil, e
			}
			return status(dir)
		}
		if e = syncOffline(dir, id); e != nil {
			return nil, e
		}
		return status(dir)
	case "usage":
		data, _, e := call(id, id.ServerURL, "GET", "/v1/me/usage", nil, true)
		if e != nil {
			return nil, e
		}
		var res any
		e = json.Unmarshal(data, &res)
		return res, e
	default:
		return nil, errors.New("Unknown tizi command")
	}
}
