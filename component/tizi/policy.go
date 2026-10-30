//go:build tizi

package tizi

import "errors"

func managedSmartPolicy(managed map[string]any) (SmartPolicy, error) {
	policy := SmartPolicy{CollectorSize: 100}
	for key := range managed {
		if key != "state-dir" && key != "smart" {
			return policy, errors.New("Unknown managed tizi policy field")
		}
	}
	raw, exists := managed["smart"]
	if !exists {
		return policy, nil
	}
	values, ok := raw.(map[string]any)
	if !ok {
		return policy, errors.New("Invalid managed Smart policy")
	}
	for key, value := range values {
		switch key {
		case "enabled", "useLightGBM", "collectData":
			flag, ok := value.(bool)
			if !ok {
				return policy, errors.New("Smart policy flags must be boolean")
			}
			switch key {
			case "enabled":
				policy.Enabled = flag
			case "useLightGBM":
				policy.UseLightGBM = flag
			case "collectData":
				policy.CollectData = flag
			}
		case "collectorSize":
			size, ok := value.(int)
			if !ok || size < 1 || size > 100000 {
				return policy, errors.New("Smart collector size must be an integer between1 and100000")
			}
			policy.CollectorSize = size
		default:
			return policy, errors.New("Unknown managed Smart policy field")
		}
	}
	return policy, nil
}

// The final merged DNS state governs whether TUN can consume DNS packets. A
// disabled/missing DNS listener must never retain an inherited hijack rule.
func clearDisabledDNSHijack(base map[string]any) {
	dns, _ := base["dns"].(map[string]any)
	enabled, _ := dns["enable"].(bool)
	if !enabled {
		if tun, ok := base["tun"].(map[string]any); ok {
			tun["dns-hijack"] = []any{}
		}
	}
}

// mergeManagedSetting matches the ordinary factory's default deep merge: maps
// merge recursively; arrays and scalar/null values replace the preceding value.
// Override-script bang/plus syntax is deliberately not interpreted here.
func mergeManagedSetting(previous, patch any) any {
	object, ok := patch.(map[string]any)
	if !ok {
		return patch
	}
	merged := make(map[string]any)
	if original, ok := previous.(map[string]any); ok {
		for key, value := range original {
			merged[key] = value
		}
	}
	for key, value := range object {
		merged[key] = mergeManagedSetting(merged[key], value)
	}
	return merged
}
