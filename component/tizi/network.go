//go:build tizi

package tizi

import (
	"context"
	"net"
	"time"

	"github.com/metacubex/mihomo/component/dialer"
	"github.com/metacubex/mihomo/component/resolver"
)

// serviceDialContext uses the same real-IP resolver and bound socket policy as
// proxy-server connections. OS DNS can point into our own fake-IP TUN listener;
// sending control-plane requests through it can recurse through managed traffic.
// Native standalone commands still work before the core has initialized DNS.
func serviceDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if resolver.SystemResolver != nil {
		return dialer.DialContext(ctx, network, address)
	}
	return (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second, Resolver: &net.Resolver{PreferGo: true}}).DialContext(ctx, network, address)
}
