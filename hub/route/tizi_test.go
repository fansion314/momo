package route

import (
	"github.com/metacubex/mihomo/log"
	"testing"
)

func TestManagedPatchRejectsLoggingAndServerEndpoints(t *testing.T) {
	debug := log.DEBUG
	silent := log.SILENT
	server := ":9999"
	for _, tc := range []struct {
		name    string
		value   configSchema
		allowed bool
	}{
		{"ordinary", configSchema{}, true},
		{"silent", configSchema{LogLevel: &silent}, true},
		{"debug", configSchema{LogLevel: &debug}, false},
		{"ss", configSchema{ShadowSocksConfig: &server}, false},
		{"vmess", configSchema{VmessConfig: &server}, false},
		{"tcptun", configSchema{TcptunConfig: &server}, false},
		{"tuic", configSchema{TuicServer: &tuicServerSchema{Enable: true}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := managedPatchAllowed(&tc.value, true); got != tc.allowed {
				t.Fatalf("managed allow=%v want=%v", got, tc.allowed)
			}
			if !managedPatchAllowed(&tc.value, false) {
				t.Fatal("normal profiles changed")
			}
		})
	}
}
