//go:build tizi

package tizi

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"

	"go.yaml.in/yaml/v3"
)

func TestManagedSmartPolicyRejectsExecutableOrMalformedInput(t *testing.T) {
	for _, input := range []string{
		"smart: {enabled: true, script: 'main(config)'}",
		"smart: {enabled: 'true'}",
		"smart: {enabled: true, useLightGBM: 1}",
		"smart: {collectorSize: 0}", "smart: {collectorSize: 100001}", "smart: {collectorSize: 1.5}", "smart: {collectorSize: '100'}",
		"smart: 'main(config)'", "unexpected: true",
	} {
		var m map[string]any
		if err := yaml.Unmarshal([]byte(input), &m); err != nil {
			t.Fatal(err)
		}
		if _, err := managedSmartPolicy(m); err == nil {
			t.Fatalf("accepted malformed safe policy %q", input)
		}
	}
	policy, err := managedSmartPolicy(map[string]any{"state-dir": "/private/test"})
	if err != nil || policy.Enabled || policy.CollectorSize != 100 {
		t.Fatalf("legacy/default wrapper: %+v %v", policy, err)
	}
}

func TestFinalDNSStateControlsHijack(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		base := map[string]any{"dns": map[string]any{"enable": enabled}, "tun": map[string]any{"enable": true, "dns-hijack": []any{"any:53"}}}
		clearDisabledDNSHijack(base)
		hijack := base["tun"].(map[string]any)["dns-hijack"].([]any)
		if enabled && len(hijack) != 1 || !enabled && len(hijack) != 0 {
			t.Fatalf("enabled=%v hijack=%v", enabled, hijack)
		}
	}
	missing := map[string]any{"tun": map[string]any{"dns-hijack": []any{"any:53"}}}
	clearDisabledDNSHijack(missing)
	if len(missing["tun"].(map[string]any)["dns-hijack"].([]any)) != 0 {
		t.Fatal("missing DNS retained dead hijack")
	}
}

func TestExpandAppliesSafeSmartAndDNSWithoutChangingEncryptedSource(t *testing.T) {
	testKeys(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	if err = writeEncrypted(dir, "identity.enc", identity{ServerURL: "https://example.com", PrivateKey: private, LoggedIn: true}); err != nil {
		t.Fatal(err)
	}
	source := "proxies:\n  - {name: proxy, type: socks5, server: 192.0.2.10, port: 1080}\nproxy-groups:\n  - {name: Select, type: select, proxies: [Auto, proxy]}\n  - {name: Auto, type: url-test, proxies: [proxy]}\nrules: [\"MATCH,Select\"]\ndns: {enable: false}\nsecret: sealed-source-controller-secret\n"
	if err = writeEncrypted(dir, "subscription.enc", subscription{YAML: source}); err != nil {
		t.Fatal(err)
	}
	if err = writeEncrypted(dir, "ledger.enc", ledgerState{}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(dir, "subscription.enc"))
	if err != nil {
		t.Fatal(err)
	}
	wrapper := map[string]any{"tizi-managed": map[string]any{"state-dir": dir, "smart": map[string]any{"enabled": true, "useLightGBM": true, "collectData": false, "collectorSize": 321}}, "dns": map[string]any{"enable": true}, "tun": map[string]any{"enable": true, "dns-hijack": []any{"any:53"}}, "profile": map[string]any{"store-selected": true}, "secret": "ordinary-local-controller-secret"}
	data, _ := yaml.Marshal(wrapper)
	expanded, _, err := ExpandConfig(data)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err = yaml.Unmarshal(expanded, &config); err != nil {
		t.Fatal(err)
	}
	if config["secret"] != "ordinary-local-controller-secret" {
		t.Fatal("ordinary controller secret lost")
	}
	groups := config["proxy-groups"].([]any)
	if groups[0].(map[string]any)["name"] != "Select" || groups[1].(map[string]any)["type"] != "smart" {
		t.Fatal("Smart conversion/order wrong")
	}
	if config["profile"].(map[string]any)["smart-collector-size"] != 321 {
		t.Fatal("collector size lost during overlay")
	}
	tun := config["tun"].(map[string]any)
	if len(tun["dns-hijack"].([]any)) != 1 || len(tun["route-exclude-address"].([]any)) != 1 {
		t.Fatal("final DNS or route exclusion wrong")
	}
	after, _ := os.ReadFile(filepath.Join(dir, "subscription.enc"))
	if !bytes.Equal(before, after) {
		t.Fatal("transformation rewrote encrypted subscription")
	}
}

func TestManagedSettingsMergeMapsAndReplaceExplicitValues(t *testing.T) {
	base := map[string]any{
		"dns":      map[string]any{"enable": false, "listen": "127.0.0.1:1053", "nameserver": []any{"tls://example.invalid"}, "fallback": []any{"https://example.invalid/dns-query"}, "nameserver-policy": map[string]any{"source.example": []any{"system"}}},
		"tun":      map[string]any{"mtu": 1400, "enable": false, "dns-hijack": []any{"any:53"}},
		"profile":  map[string]any{"store-fake-ip": true, "store-selected": true},
		"geox-url": map[string]any{"geoip": "https://example.invalid/geoip", "geosite": "https://example.invalid/geosite"},
	}
	patch := map[string]any{
		"dns":      map[string]any{"enable": true, "nameserver": []any{}, "fallback": nil, "nameserver-policy": map[string]any{"local.example": []any{"system"}}},
		"tun":      map[string]any{"enable": true, "dns-hijack": []any{}},
		"profile":  map[string]any{"store-selected": false},
		"geox-url": map[string]any{"geosite": "https://example.invalid/updated"},
	}
	result := mergeManagedSetting(base, patch).(map[string]any)
	dns := result["dns"].(map[string]any)
	if dns["enable"] != true || dns["listen"] != "127.0.0.1:1053" || len(dns["nameserver"].([]any)) != 0 || dns["fallback"] != nil {
		t.Fatal("partial DNS merge/array/null semantics changed")
	}
	if len(dns["nameserver-policy"].(map[string]any)) != 2 {
		t.Fatal("nested DNS policy was replaced")
	}
	tun := result["tun"].(map[string]any)
	if tun["mtu"] != 1400 || tun["enable"] != true || len(tun["dns-hijack"].([]any)) != 0 {
		t.Fatal("partial TUN merge failed")
	}
	profile := result["profile"].(map[string]any)
	if profile["store-fake-ip"] != true || profile["store-selected"] != false {
		t.Fatal("profile false or preserved setting lost")
	}
	if result["geox-url"].(map[string]any)["geoip"] != "https://example.invalid/geoip" {
		t.Fatal("Geo URL map lost source fields")
	}
	if base["dns"].(map[string]any)["enable"] != false || len(base["dns"].(map[string]any)["nameserver"].([]any)) != 1 {
		t.Fatal("merge mutated preceding map")
	}
	if mergeManagedSetting(base, nil) != nil {
		t.Fatal("explicit null did not replace map")
	}
}
