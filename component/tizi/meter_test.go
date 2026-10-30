//go:build tizi

package tizi

import (
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMeterSettlementAndRestore(t *testing.T) {
	m, err := NewMeter(nil)
	if err != nil {
		t.Fatal(err)
	}
	before := time.Date(2026, 10, 30, 6, 59, 59, 0, settlementLocation)
	m.addAt(10, 20, before)
	m.addAt(30, 40, before.Add(time.Second))
	m.EnsureDay(before.Add(24*time.Hour + time.Second))
	rows := m.Snapshot()
	if len(rows) != 3 || rows[0] != (DayUsage{"2026-10-29", 10, 20}) || rows[1] != (DayUsage{"2026-10-30", 30, 40}) || rows[2] != (DayUsage{"2026-10-31", 0, 0}) {
		t.Fatalf("rows: %+v", rows)
	}
	restored, err := NewMeter(rows)
	if err != nil {
		t.Fatal(err)
	}
	restored.addAt(7, 8, before)
	if restored.Snapshot()[0] != (DayUsage{"2026-10-29", 17, 28}) {
		t.Fatal(restored.Snapshot())
	}
	// Settlement is independent of the OS/query timezone.
	if SettlementDay(before.UTC()) != "2026-10-29" {
		t.Fatal(SettlementDay(before.UTC()))
	}
}

func TestMeterOwnershipAndConcreteOutboundClassification(t *testing.T) {
	m, _ := NewMeter(nil)
	m.SetOutbounds(map[string]bool{"proxy": true, "custom direct": false, "DIRECT": true})
	SetMeter(m)
	t.Cleanup(func() { SetMeter(nil) })
	for _, tc := range []struct {
		chain           []string
		accounted, want bool
	}{
		{nil, true, false}, {[]string{"DIRECT", "proxy"}, true, false}, {[]string{"proxy", "DIRECT"}, true, true},
		{[]string{"custom direct", "group"}, true, false}, {[]string{"unknown"}, true, false},
		{[]string{"proxy"}, false, false}, {[]string{"REJECT"}, true, false},
	} {
		if got := Capture(tc.chain, tc.accounted); (got != nil) != tc.want {
			t.Fatalf("%+v: %v", tc, got)
		}
	}
	owner := Capture([]string{"proxy"}, true)
	other, _ := NewMeter(nil)
	SetMeter(other)
	owner.Add(11, 12)
	if len(other.Snapshot()) != 0 || m.Snapshot()[0].UploadBytes != 11 {
		t.Fatal("ownership moved on profile switch")
	}
}

func TestMeterConcurrentCountersAndSnapshotIsolation(t *testing.T) {
	m, _ := NewMeter(nil)
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			for range 1000 {
				m.Add(3, 5)
			}
		})
	}
	wg.Wait()
	rows := m.Snapshot()
	if len(rows) != 1 || rows[0].UploadBytes != 36000 || rows[0].DownloadBytes != 60000 {
		t.Fatal(rows)
	}
	rows[0].UploadBytes = 0
	if m.Snapshot()[0].UploadBytes != 36000 {
		t.Fatal("snapshot aliases live data")
	}
}

func TestMeterInvalidRestoreAndFailClosed(t *testing.T) {
	for _, days := range [][]DayUsage{{{"2026-02-30", 0, 0}}, {{"2026-10-30", -1, 0}}, {{"2026-10-30", 0, 0}, {"2026-10-30", 0, 0}}} {
		if _, err := NewMeter(days); err == nil {
			t.Fatalf("accepted %+v", days)
		}
	}
	m, _ := NewMeter([]DayUsage{{SettlementDay(time.Now()), math.MaxInt64, 0}})
	var closed atomic.Int32
	unbind := m.BindClose(func() { closed.Add(1) })
	m.Add(1, 0)
	if m.Healthy() || closed.Load() != 1 {
		t.Fatal("overflow did not close connections")
	}
	m.Add(0, 3)
	if m.Snapshot()[0].DownloadBytes != 0 {
		t.Fatal("counted after accounting failure")
	}
	unbind()
	m.SetHealthy(false)
	if closed.Load() != 1 {
		t.Fatal("unbound closer invoked")
	}
	cleanup := m.BindClose(func() { closed.Add(1) })
	defer cleanup()
	if closed.Load() != 2 {
		t.Fatal("new connection not immediately closed")
	}
}
