//go:build tizi

package tizi

import (
	"reflect"
	"testing"

	"go.yaml.in/yaml/v3"
)

func smartFixture(t *testing.T, text string) map[string]any {
	t.Helper()
	var base map[string]any
	if err := yaml.Unmarshal([]byte(text), &base); err != nil {
		t.Fatal(err)
	}
	return base
}
func smartCopy(t *testing.T, base map[string]any) map[string]any {
	t.Helper()
	raw, err := yaml.Marshal(base)
	if err != nil {
		t.Fatal(err)
	}
	return smartFixture(t, string(raw))
}
func TestSmartConversionPreservesOrderAndReferences(t *testing.T) {
	base := smartFixture(t, `
mode: rule
profile: {store-selected: true}
proxies:
  - {name: node, type: ss, server: 192.0.2.1, dialer-proxy: Auto}
proxy-groups:
  - {name: GLOBAL, type: select, proxies: [Auto, Balance, DIRECT], use: [Auto]}
  - {name: Auto, type: url-test, proxies: [node], url: https://example.invalid, interval: 10, lazy: true, expected-status: 200, tolerance: 30, policy-priority: "node:2"}
  - {name: Balance, type: load-balance, proxies: [node]}
  - {name: Already, type: smart, proxies: [node]}
rules:
  - DOMAIN,Auto,Auto
  - DOMAIN,Auto,GLOBAL
  - MATCH,Balance
  - IP-CIDR,192.0.2.0/24,Auto,no-resolve
  - AND,((DOMAIN,Auto),(OR,((DOMAIN,other),(NETWORK,UDP)))),Auto
  - DOMAIN-REGEX,^x{1,3}\.Auto$,Auto
  - SUB-RULE,(NETWORK,TCP),Auto
sub-rules:
  Auto: ["MATCH,Auto", "DOMAIN,Auto,DIRECT"]
proxy-providers:
  Auto: {type: inline, proxy: Auto, override: {dialer-proxy: Balance}}
rule-providers:
  Auto: {type: inline, proxy: Auto, payload: [Auto]}
`)
	policy := SmartPolicy{Enabled: true, UseLightGBM: true, CollectData: true, CollectorSize: 42}
	if err := applySmart(base, policy); err != nil {
		t.Fatal(err)
	}
	groups := base["proxy-groups"].([]any)
	wantNames := []string{"GLOBAL", "Auto(Smart Group)", "Balance(Smart Group)", "Already"}
	for i, item := range groups {
		if item.(map[string]any)["name"] != wantNames[i] {
			t.Fatal(groups)
		}
	}
	auto := groups[1].(map[string]any)
	if auto["type"] != "smart" || auto["uselightgbm"] != true || auto["collectdata"] != true || auto["tolerance"] != 30 || auto["policy-priority"] != "node:2" {
		t.Fatal(auto)
	}
	for _, key := range []string{"url", "interval", "lazy", "expected-status"} {
		if _, exists := auto[key]; exists {
			t.Fatalf("obsolete Smart option %s", key)
		}
	}
	if base["profile"].(map[string]any)["smart-collector-size"] != 42 || base["profile"].(map[string]any)["store-selected"] != true {
		t.Fatal(base["profile"])
	}
	wantRules := []any{"DOMAIN,Auto,Auto(Smart Group)", "DOMAIN,Auto,GLOBAL", "MATCH,Balance(Smart Group)", "IP-CIDR,192.0.2.0/24,Auto(Smart Group),no-resolve", "AND,((DOMAIN,Auto),(OR,((DOMAIN,other),(NETWORK,UDP)))),Auto(Smart Group)", "DOMAIN-REGEX,^x{1,3}\\.Auto$,Auto(Smart Group)", "SUB-RULE,(NETWORK,TCP),Auto"}
	if !reflect.DeepEqual(base["rules"], wantRules) {
		t.Fatalf("rules: %#v", base["rules"])
	}
	if got := groups[0].(map[string]any)["use"].([]any)[0]; got != "Auto" {
		t.Fatal("provider reference was renamed")
	}
	if got := base["proxies"].([]any)[0].(map[string]any)["dialer-proxy"]; got != "Auto(Smart Group)" {
		t.Fatal(got)
	}
	ruleProvider := base["rule-providers"].(map[string]any)["Auto"].(map[string]any)
	if ruleProvider["proxy"] != "Auto(Smart Group)" || ruleProvider["payload"].([]any)[0] != "Auto" {
		t.Fatal(ruleProvider)
	}
	if got := base["sub-rules"].(map[string]any)["Auto"].([]any)[0]; got != "MATCH,Auto(Smart Group)" {
		t.Fatal(got)
	}
	// Applying the transform again must not retarget the separate GLOBAL rule.
	before := smartCopy(t, base)
	if err := applySmart(base, policy); err != nil {
		t.Fatal(err)
	}
	// On subsequent application, existing native Smart options also update.
	before["proxy-groups"].([]any)[3].(map[string]any)["uselightgbm"] = true
	before["proxy-groups"].([]any)[3].(map[string]any)["collectdata"] = true
	before["proxy-groups"].([]any)[3].(map[string]any)["policy-priority"] = ""
	if !reflect.DeepEqual(base, before) {
		t.Fatalf("second transform changed routing: %#v", base)
	}
}

func TestSmartCollisionAndSuffixOnce(t *testing.T) {
	base := smartFixture(t, `
proxies: [{name: "Auto(Smart Group) 2"}]
proxy-groups:
  - {name: Auto, type: URL-TEST}
  - {name: "Auto(Smart Group)", type: select}
  - {name: "Named(Smart Group)", type: load-balance}
rules: ["MATCH,Auto", "DOMAIN,Auto,Auto(Smart Group)"]
`)
	if err := applySmart(base, SmartPolicy{Enabled: true}); err != nil {
		t.Fatal(err)
	}
	groups := base["proxy-groups"].([]any)
	if groups[0].(map[string]any)["name"] != "Auto(Smart Group) 3" || groups[2].(map[string]any)["name"] != "Named(Smart Group)" {
		t.Fatal(groups)
	}
	if base["rules"].([]any)[1] != "DOMAIN,Auto,Auto(Smart Group)" {
		t.Fatal(base["rules"])
	}
	before := smartCopy(t, base)
	_ = applySmart(base, SmartPolicy{Enabled: true})
	if !reflect.DeepEqual(before, base) {
		t.Fatal("not idempotent")
	}
}

func TestSmartFallbackAndBuiltinTargets(t *testing.T) {
	base := smartFixture(t, `
proxies: [{name: node}, {name: Smart Group}]
proxy-groups: [{name: Main, type: select, proxies: [node, DIRECT]}]
rules:
  - MATCH,Main
  - DOMAIN,Main,node
  - AND,((DOMAIN,Main),(NETWORK,TCP)),Main
  - MATCH,DIRECT
  - MATCH,REJECT
  - MATCH,REJECT-DROP
  - MATCH,PASS
  - MATCH,COMPATIBLE
  - SUB-RULE,(NETWORK,TCP),Main
`)
	if err := applySmart(base, SmartPolicy{Enabled: true, UseLightGBM: true}); err != nil {
		t.Fatal(err)
	}
	groups := base["proxy-groups"].([]any)
	if len(groups) != 2 || groups[0].(map[string]any)["name"] != "Smart Group 2" || groups[1].(map[string]any)["name"] != "Main" {
		t.Fatal(groups)
	}
	rules := base["rules"].([]any)
	if rules[0] != "MATCH,Smart Group 2" || rules[1] != "DOMAIN,Main,Smart Group 2" || rules[2] != "AND,((DOMAIN,Main),(NETWORK,TCP)),Smart Group 2" || rules[3] != "MATCH,DIRECT" || rules[8] != "SUB-RULE,(NETWORK,TCP),Main" {
		t.Fatal(rules)
	}
	before := smartCopy(t, base)
	_ = applySmart(base, SmartPolicy{Enabled: true, UseLightGBM: true})
	if !reflect.DeepEqual(before, base) {
		t.Fatal("fallback not idempotent")
	}
}

func TestSmartExistingAndNoInlineProxies(t *testing.T) {
	base := smartFixture(t, `proxy-groups: [{name: One, type: smart}, {name: Two, type: SMART}]
rules: ["MATCH,One"]`)
	if err := applySmart(base, SmartPolicy{Enabled: true, CollectData: true}); err != nil {
		t.Fatal(err)
	}
	for _, item := range base["proxy-groups"].([]any) {
		if item.(map[string]any)["collectdata"] != true {
			t.Fatal(item)
		}
	}
	if base["profile"].(map[string]any)["smart-collector-size"] != 100 {
		t.Fatal(base["profile"])
	}
	empty := smartFixture(t, `proxy-providers: {remote: {type: http}}
rules: ["MATCH,DIRECT"]`)
	_ = applySmart(empty, SmartPolicy{Enabled: true})
	if len(empty["proxy-groups"].([]any)) != 0 || empty["rules"].([]any)[0] != "MATCH,DIRECT" {
		t.Fatal(empty)
	}
}

func TestSmartValidationDisabledAndTunAfterOverlay(t *testing.T) {
	base := smartFixture(t, `proxies: [{name: ipv4, server: 192.0.2.1}, {name: ipv6, server: "[2001:db8::1]"}, {name: domain, server: example.invalid}]
tun: {enable: false, route-exclude-address: [192.0.2.1/32]}`)
	before := smartCopy(t, base)
	if err := applySmart(base, SmartPolicy{CollectorSize: -1}); err != nil || !reflect.DeepEqual(before, base) {
		t.Fatal("disabled policy changed config", err)
	}
	for _, size := range []int{-1, 100001} {
		if err := applySmart(base, SmartPolicy{Enabled: true, CollectorSize: size}); err == nil {
			t.Fatal("accepted invalid size")
		}
	}
	ensureSmartTunExcludes(base, true)
	if !reflect.DeepEqual(before, base) {
		t.Fatal("disabled TUN changed")
	}
	base["tun"].(map[string]any)["enable"] = true
	ensureSmartTunExcludes(base, false)
	if len(base["tun"].(map[string]any)["route-exclude-address"].([]any)) != 1 {
		t.Fatal(base)
	}
	ensureSmartTunExcludes(base, true)
	ensureSmartTunExcludes(base, true)
	if got := base["tun"].(map[string]any)["route-exclude-address"]; !reflect.DeepEqual(got, []any{"192.0.2.1/32", "2001:db8::1/128"}) {
		t.Fatal(got)
	}
}

func TestSmartFallbackKeepsPassRuleBuiltin(t *testing.T) {
	if got := smartRule("MATCH,PASS-RULE", nil, "Smart Group"); got != "MATCH,PASS-RULE" {
		t.Fatal("fallback changed builtin subrule continuation")
	}
}
