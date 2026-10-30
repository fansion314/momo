//go:build tizi

package statistic

import (
	"net"
	"testing"

	"github.com/metacubex/mihomo/common/buf"
	"github.com/metacubex/mihomo/component/tizi"
	C "github.com/metacubex/mihomo/constant"
)

type meteredTCP struct {
	C.Conn
	closed bool
	name   string
}

func (c *meteredTCP) Chains() C.Chain                 { return C.Chain{c.name, "group"} }
func (c *meteredTCP) ProviderChains() C.Chain         { return nil }
func (c *meteredTCP) RemoteDestination() string       { return "test.invalid:443" }
func (c *meteredTCP) Close() error                    { c.closed = true; return nil }
func (c *meteredTCP) Read(b []byte) (int, error)      { return copy(b, []byte("data")), nil }
func (c *meteredTCP) Write(b []byte) (int, error)     { return len(b), nil }
func (c *meteredTCP) ReadBuffer(b *buf.Buffer) error  { _, err := b.Write([]byte("data")); return err }
func (c *meteredTCP) WriteBuffer(b *buf.Buffer) error { return nil }

type meteredUDP struct {
	C.PacketConn
	closed bool
	name   string
}

func (c *meteredUDP) Chains() C.Chain           { return C.Chain{c.name, "group"} }
func (c *meteredUDP) ProviderChains() C.Chain   { return nil }
func (c *meteredUDP) RemoteDestination() string { return "test.invalid:443" }
func (c *meteredUDP) Close() error              { c.closed = true; return nil }
func (c *meteredUDP) ReadFrom(b []byte) (int, net.Addr, error) {
	return copy(b, []byte("packet")), &net.UDPAddr{}, nil
}
func (c *meteredUDP) WaitReadFrom() ([]byte, func(), net.Addr, error) {
	return []byte("packet"), func() {}, &net.UDPAddr{}, nil
}
func (c *meteredUDP) WriteTo(b []byte, _ net.Addr) (int, error) { return len(b), nil }

func TestTiziTrackerIOAndProfileOwnership(t *testing.T) {
	m, _ := tizi.NewMeter(nil)
	m.SetOutbounds(map[string]bool{"node": true})
	tizi.SetMeter(m)
	t.Cleanup(func() { tizi.SetMeter(nil) })
	manager := &Manager{}
	raw := &meteredTCP{name: "node"}
	tcp := NewTCPTracker(raw, manager, &C.Metadata{}, nil, 2, 3, true)
	udp := NewUDPTracker(&meteredUDP{name: "node"}, manager, &C.Metadata{}, nil, 5, 7, true)
	// A subsequent switch must not move live connections to a new account/profile.
	other, _ := tizi.NewMeter(nil)
	tizi.SetMeter(other)
	_, _ = tcp.Read(make([]byte, 10))
	_, _ = tcp.Write([]byte("hello"))
	b := buf.New()
	defer b.Release()
	_ = tcp.ReadBuffer(b)
	_ = tcp.WriteBuffer(buf.As([]byte("abc")))
	_, readerCount := tcp.UnwrapReader()
	readerCount[0](9)
	_, writerCount := tcp.UnwrapWriter()
	writerCount[0](11)
	_, _, _ = udp.ReadFrom(make([]byte, 10))
	_, _, _, _ = udp.WaitReadFrom()
	_, _ = udp.WriteTo([]byte("four"), &net.UDPAddr{})
	rows := m.Snapshot()
	if len(rows) != 1 || rows[0].UploadBytes != 30 || rows[0].DownloadBytes != 39 {
		t.Fatalf("unexpected metered totals: %+v", rows)
	}
	if len(other.Snapshot()) != 0 {
		t.Fatal("profile switch moved old connection accounting")
	}
	m.SetHealthy(false)
	if !raw.closed {
		t.Fatal("ledger failure left managed connection open")
	}
	_ = tcp.Close()
	_ = udp.Close()
}

func TestTiziTrackerExcludesDirectAndInternal(t *testing.T) {
	m, _ := tizi.NewMeter(nil)
	m.SetOutbounds(map[string]bool{"node": true, "custom direct": false})
	tizi.SetMeter(m)
	t.Cleanup(func() { tizi.SetMeter(nil) })
	for _, tc := range []struct {
		name      string
		accounted bool
	}{{"DIRECT", true}, {"custom direct", true}, {"node", false}} {
		tracker := NewTCPTracker(&meteredTCP{name: tc.name}, &Manager{}, &C.Metadata{}, nil, 10, 20, tc.accounted)
		_, _ = tracker.Write([]byte("data"))
		_ = tracker.Close()
	}
	if len(m.Snapshot()) != 0 {
		t.Fatal(m.Snapshot())
	}
}
