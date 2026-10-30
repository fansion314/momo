//go:build tizi

package tizi

import (
	"errors"
	"fmt"
	"net/netip"
	"strings"
)

// SmartPolicy is the bounded, declarative counterpart of Momo's Smart override.
// It is applied only after the subscription has been decrypted inside the core.
type SmartPolicy struct {
	Enabled       bool `json:"enabled" yaml:"enabled"`
	UseLightGBM   bool `json:"useLightGBM" yaml:"useLightGBM"`
	CollectData   bool `json:"collectData" yaml:"collectData"`
	CollectorSize int  `json:"collectorSize" yaml:"collectorSize"`
}

func applySmart(base map[string]any, policy SmartPolicy) error {
	if !policy.Enabled {
		return nil
	}
	if base == nil {
		return errors.New("invalid managed Smart configuration")
	}
	if policy.CollectorSize == 0 {
		policy.CollectorSize = 100
	}
	if policy.CollectorSize < 1 || policy.CollectorSize > 100000 {
		return errors.New("Smart collectorSize must be between 1 and 100000")
	}
	groups, ok := base["proxy-groups"].([]any)
	if base["proxy-groups"] != nil && !ok {
		return errors.New("managed proxy-groups must be a list")
	}
	names := map[string]bool{}
	for _, item := range groups {
		group, ok := item.(map[string]any)
		if !ok {
			return errors.New("managed proxy group must be an object")
		}
		name, _ := group["name"].(string)
		if name == "" || names[name] {
			return errors.New("managed proxy group names must be nonempty and unique")
		}
		names[name] = true
	}
	proxies, _ := base["proxies"].([]any)
	for _, item := range proxies {
		if proxy, ok := item.(map[string]any); ok {
			if name, ok := proxy["name"].(string); ok {
				names[name] = true
			}
		}
	}
	profile, ok := base["profile"].(map[string]any)
	if base["profile"] != nil && !ok {
		return errors.New("managed profile must be an object")
	}
	if profile == nil {
		profile = map[string]any{}
		base["profile"] = profile
	}
	profile["smart-collector-size"] = policy.CollectorSize
	renamed := map[string]string{}
	hasAutomatic := false
	for _, item := range groups {
		group := item.(map[string]any)
		kind, _ := group["type"].(string)
		if !strings.EqualFold(kind, "url-test") && !strings.EqualFold(kind, "load-balance") {
			continue
		}
		hasAutomatic = true
		name := group["name"].(string)
		if !strings.Contains(name, "(Smart Group)") {
			next := uniqueSmartName(name+"(Smart Group)", names)
			renamed[name], group["name"], names[next] = next, next, true
		}
		setSmartOptions(group, policy)
		for _, field := range []string{"url", "interval", "lazy", "expected-status", "expected_status"} {
			delete(group, field)
		}
	}
	if hasAutomatic {
		applySmartReferences(base, groups, renamed, "")
	} else {
		hasSmart := false
		for _, item := range groups {
			group := item.(map[string]any)
			kind, _ := group["type"].(string)
			if strings.EqualFold(kind, "smart") {
				hasSmart = true
				setSmartOptions(group, policy)
			}
		}
		// Existing Smart groups retain routing. Otherwise repeated application after
		// url-test conversion would unexpectedly redirect unrelated select rules.
		if !hasSmart {
			outbounds := []any{}
			for _, item := range proxies {
				if proxy, ok := item.(map[string]any); ok {
					if name, ok := proxy["name"].(string); ok && name != "" {
						outbounds = append(outbounds, name)
					}
				}
			}
			if len(outbounds) > 0 {
				name := uniqueSmartName("Smart Group", names)
				group := map[string]any{"name": name, "proxies": outbounds}
				setSmartOptions(group, policy)
				groups = append([]any{group}, groups...)
				applySmartReferences(base, groups, nil, name)
			}
		}
	}
	base["proxy-groups"] = groups
	return nil
}

func uniqueSmartName(wanted string, names map[string]bool) string {
	if !names[wanted] {
		return wanted
	}
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s %d", wanted, i)
		if !names[candidate] {
			return candidate
		}
	}
}

func setSmartOptions(group map[string]any, policy SmartPolicy) {
	group["type"] = "smart"
	if group["policy-priority"] == nil || group["policy-priority"] == "" {
		group["policy-priority"] = ""
	}
	group["uselightgbm"], group["collectdata"] = policy.UseLightGBM, policy.CollectData
}

func smartBuiltin(target string) bool {
	switch target {
	case "DIRECT", "REJECT", "REJECT-DROP", "PASS", "PASS-RULE", "COMPATIBLE", "GLOBAL":
		return true
	}
	return false
}

func smartTarget(target string, names map[string]string, fallback string) string {
	if next, ok := names[target]; ok {
		return next
	}
	if fallback != "" && target != "" && !smartBuiltin(target) {
		return fallback
	}
	return target
}

func applySmartReferences(base map[string]any, groups []any, names map[string]string, fallback string) {
	for _, item := range groups {
		group := item.(map[string]any)
		if values, ok := group["proxies"].([]any); ok {
			for i, value := range values {
				if name, ok := value.(string); ok {
					if next, ok := names[name]; ok {
						values[i] = next
					}
				}
			}
		}
	}
	mapRules := func(rules []any) {
		for i, item := range rules {
			switch rule := item.(type) {
			case string:
				rules[i] = smartRule(rule, names, fallback)
			case map[string]any:
				for _, field := range []string{"target", "proxy"} {
					if target, ok := rule[field].(string); ok {
						rule[field] = smartTarget(target, names, fallback)
					}
				}
			}
		}
	}
	if rules, ok := base["rules"].([]any); ok {
		mapRules(rules)
	}
	if sections, ok := base["sub-rules"].(map[string]any); ok {
		for _, section := range sections {
			if rules, ok := section.([]any); ok {
				mapRules(rules)
			}
		}
	}
	// Only fields that semantically refer to outbounds are renamed. Provider names,
	// rule matchers, server names and other coincident strings remain untouched.
	renameField := func(object map[string]any, field string) {
		if name, ok := object[field].(string); ok {
			if next, ok := names[name]; ok {
				object[field] = next
			}
		}
	}
	if proxies, ok := base["proxies"].([]any); ok {
		for _, item := range proxies {
			if proxy, ok := item.(map[string]any); ok {
				renameField(proxy, "dialer-proxy")
			}
		}
	}
	for _, section := range []string{"proxy-providers", "rule-providers"} {
		if providers, ok := base[section].(map[string]any); ok {
			for _, item := range providers {
				if provider, ok := item.(map[string]any); ok {
					renameField(provider, "proxy")
					renameField(provider, "dialer-proxy")
					if override, ok := provider["override"].(map[string]any); ok {
						renameField(override, "dialer-proxy")
					}
				}
			}
		}
	}
	for _, section := range []string{"listeners", "tunnels"} {
		if items, ok := base[section].([]any); ok {
			for _, item := range items {
				if object, ok := item.(map[string]any); ok {
					renameField(object, "proxy")
				}
			}
		}
	}
}

// smartRule follows the core rule grammar. Logical/regex payloads may contain
// commas; their target is the final field, never a token inside a matcher.
func smartRule(rule string, names map[string]string, fallback string) string {
	first := strings.IndexByte(rule, ',')
	if first < 0 {
		return rule
	}
	kind := strings.ToUpper(strings.TrimSpace(rule[:first]))
	if kind == "SUB-RULE" {
		return rule
	}
	start, end := first+1, len(rule)
	switch kind {
	case "MATCH":
		if next := strings.IndexByte(rule[start:], ','); next >= 0 {
			end = start + next
		}
	case "NOT", "OR", "AND", "DOMAIN-REGEX", "PROCESS-NAME-REGEX", "PROCESS-PATH-REGEX":
		start = strings.LastIndexByte(rule, ',') + 1
	default:
		second := strings.IndexByte(rule[start:], ',')
		if second < 0 {
			return rule
		}
		start += second + 1
		if next := strings.IndexByte(rule[start:], ','); next >= 0 {
			end = start + next
		}
	}
	old := strings.TrimSpace(rule[start:end])
	next := smartTarget(old, names, fallback)
	if old == next {
		return rule
	}
	return rule[:start] + next + rule[end:]
}

// ensureSmartTunExcludes must run after merging the safe local TUN overlay.
func ensureSmartTunExcludes(base map[string]any, enabled bool) {
	if !enabled {
		return
	}
	proxies, _ := base["proxies"].([]any)
	tun, ok := base["tun"].(map[string]any)
	if !ok || tun["enable"] != true {
		return
	}
	excludes, _ := tun["route-exclude-address"].([]any)
	seen := map[string]bool{}
	for _, item := range excludes {
		if text, ok := item.(string); ok {
			seen[strings.ToLower(strings.TrimSpace(text))] = true
		}
	}
	for _, item := range proxies {
		proxy, ok := item.(map[string]any)
		if !ok {
			continue
		}
		server, ok := proxy["server"].(string)
		if !ok {
			continue
		}
		host := strings.TrimSpace(server)
		if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
			host = host[1 : len(host)-1]
		}
		addr, err := netip.ParseAddr(host)
		if err != nil || addr.Zone() != "" {
			continue
		}
		cidr := netip.PrefixFrom(addr, addr.BitLen()).String()
		if seen[strings.ToLower(host)] || seen[cidr] {
			continue
		}
		excludes = append(excludes, cidr)
		seen[cidr] = true
	}
	tun["route-exclude-address"] = excludes
}
