//go:build tizi

package tizi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/metacubex/mihomo/component/resolver"
	"github.com/miekg/dns"
)

type controlPlaneResolver struct{ calls atomic.Int64 }

func (r *controlPlaneResolver) LookupIP(_ context.Context, _ string) ([]netip.Addr, error) {
	r.calls.Add(1)
	return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
}
func (r *controlPlaneResolver) LookupIPv4(ctx context.Context, host string) ([]netip.Addr, error) {
	return r.LookupIP(ctx, host)
}
func (r *controlPlaneResolver) LookupIPv6(context.Context, string) ([]netip.Addr, error) {
	return nil, errors.New("no IPv6 fixture")
}
func (r *controlPlaneResolver) ResolveECH(context.Context, string) ([]byte, error) { return nil, nil }
func (r *controlPlaneResolver) ExchangeContext(context.Context, *dns.Msg) (*dns.Msg, error) {
	return nil, errors.New("unexpected raw exchange")
}
func (r *controlPlaneResolver) Invalid() bool    { return true }
func (r *controlPlaneResolver) ClearCache()      {}
func (r *controlPlaneResolver) ResetConnection() {}

func TestControlPlaneUsesInternalRealIPResolverWithSystemDNSUnavailable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"ok":true}`)) }))
	defer server.Close()
	oldSystem, oldProxy, oldNet := resolver.SystemResolver, resolver.ProxyServerHostResolver, net.DefaultResolver
	realIPs := &controlPlaneResolver{}
	resolver.SystemResolver = realIPs
	resolver.ProxyServerHostResolver = realIPs
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("system DNS points at a TUN fake-IP listener")
	}}
	t.Cleanup(func() {
		resolver.SystemResolver = oldSystem
		resolver.ProxyServerHostResolver = oldProxy
		net.DefaultResolver = oldNet
	})
	alias := "http://control-plane.invalid:" + strings.Split(server.URL, ":")[2]
	body, _, err := call(nil, alias, "GET", "/status", nil, false)
	if err != nil || string(body) != `{"ok":true}` {
		t.Fatalf("control-plane request failed with dead OS DNS: %v", err)
	}
	if realIPs.calls.Load() == 0 {
		t.Fatal("request bypassed internal proxy-server resolver")
	}
}

func TestNativeCLIRegisterWithoutInitializedProxyResolver(t *testing.T) {
	if os.Getenv("TIZI_MANUAL_CLI_FIXTURE") == "1" {
		BuildKeys = "fixture:" + base64.StdEncoding.EncodeToString(make([]byte, 32))
		systemDNS := &controlPlaneResolver{}
		resolver.SystemResolver = systemDNS
		resolver.ProxyServerHostResolver = nil
		Main([]string{"--state-dir", os.Getenv("TIZI_MANUAL_STATE_DIR"), "register"})
		if systemDNS.calls.Load() == 0 {
			os.Exit(2)
		}
		os.Exit(0)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/registration/request" {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"request_id":"fresh-cli-fixture"}`))
	}))
	defer server.Close()
	stateDir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestNativeCLIRegisterWithoutInitializedProxyResolver$")
	cmd.Env = append(os.Environ(), "TIZI_MANUAL_CLI_FIXTURE=1", "TIZI_MANUAL_STATE_DIR="+stateDir)
	origin := strings.Replace(server.URL, "127.0.0.1", "localhost", 1)
	request, _ := json.Marshal(map[string]string{"server_url": origin, "email": "fixture@example.invalid"})
	cmd.Stdin = bytes.NewReader(request)
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("standalone manual CLI transport: %v", err)
	}
	var result struct {
		OK   bool `json:"ok"`
		Data struct {
			RequestID string `json:"request_id"`
		} `json:"data"`
	}
	if json.Unmarshal(output, &result) != nil || !result.OK || result.Data.RequestID != "fresh-cli-fixture" {
		t.Fatal("standalone command did not complete registration transport")
	}
}
