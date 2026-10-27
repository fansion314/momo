package statistic

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/metacubex/mihomo/common/atomic"
	"github.com/metacubex/mihomo/common/utils"
	"github.com/metacubex/mihomo/component/traffic_history"
	C "github.com/metacubex/mihomo/constant"
)

func TestManagerHistoryDeduplicatesLeave(t *testing.T) {
	oldHome := C.Path.HomeDir()
	C.SetHomeDir(t.TempDir())
	defer C.SetHomeDir(oldHome)
	m := &Manager{}
	cfg := traffic_history.DefaultConfig()
	cfg.Enable = true
	cfg.GeoIP.Enable = false
	cfg.Path = filepath.Join(C.Path.HomeDir(), "history.db")
	if err := m.History().Configure(cfg, m); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.History().Close() })
	info := &TrackerInfo{UUID: utils.NewUUIDV4(), Start: time.Now(), Metadata: &C.Metadata{NetWork: C.TCP, SmartTarget: "example.com", SmartBlock: "node"}, UploadTotal: atomic.NewInt64(123), DownloadTotal: atomic.NewInt64(456)}
	tracker := &tcpTracker{TrackerInfo: info, manager: m, pushToManager: true}
	m.Join(tracker)
	targets := 0
	m.RangeSmartTarget("example.com", func(string) bool { targets++; return true })
	if targets != 1 {
		t.Fatal("Smart target registration lost")
	}
	m.Leave(tracker)
	m.RangeSmartTarget("example.com", func(string) bool { t.Fatal("Smart target was not removed"); return true })
	m.Leave(tracker)
	internalInfo := &TrackerInfo{UUID: utils.NewUUIDV4(), Start: time.Now(), Metadata: &C.Metadata{}, UploadTotal: atomic.NewInt64(999), DownloadTotal: atomic.NewInt64(999)}
	internal := &udpTracker{TrackerInfo: internalInfo, manager: m, pushToManager: false}
	m.Join(internal)
	m.Leave(internal)
	if err := m.History().Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var metadata string
	if err = db.QueryRow(`SELECT metadata FROM flows WHERE accounted=1`).Scan(&metadata); err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if err = json.Unmarshal([]byte(metadata), &stored); err != nil || stored["smartTarget"] != "example.com" || stored["smartBlock"] != "node" {
		t.Fatalf("Smart metadata lost: %s %v", metadata, err)
	}
	var count, total int
	if err = db.QueryRow(`SELECT COUNT(*),SUM(recorded_upload) FROM flows WHERE accounted=1`).Scan(&count, &total); err != nil {
		t.Fatal(err)
	}
	if count != 1 || total != 123 {
		t.Fatalf("count=%d total=%d", count, total)
	}
	if err = db.QueryRow(`SELECT COUNT(*) FROM flows WHERE accounted=0`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("internal count=%d err=%v", count, err)
	}
	if err = db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE state='stopped' AND typeof(ended_at_ms)='integer'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("session count=%d err=%v", count, err)
	}
}

type lifecycleTracker struct{ C.Connection }

func (*lifecycleTracker) ID() string         { return "benchmark" }
func (*lifecycleTracker) Close() error       { return nil }
func (*lifecycleTracker) Info() *TrackerInfo { return &TrackerInfo{Metadata: &C.Metadata{}} }

func BenchmarkDisabledLifecycle(b *testing.B) {
	for _, baseline := range []bool{true, false} {
		name := "history_disabled"
		if baseline {
			name = "original_map_operations"
		}
		b.Run(name, func(b *testing.B) {
			m := &Manager{}
			c := &lifecycleTracker{}
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				m.Join(c)
				if baseline {
					m.connections.Delete(c.ID())
				} else {
					m.Leave(c)
				}
			}
		})
	}
}

func TestShutdownCapturesConcurrentLeaves(t *testing.T) {
	oldHome := C.Path.HomeDir()
	C.SetHomeDir(t.TempDir())
	defer C.SetHomeDir(oldHome)
	m := &Manager{}
	cfg := traffic_history.DefaultConfig()
	cfg.Enable = true
	cfg.GeoIP.Enable = false
	if err := m.History().Configure(cfg, m); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.History().Close() })
	trackers := make([]*tcpTracker, 1000)
	for i := range trackers {
		trackers[i] = &tcpTracker{TrackerInfo: &TrackerInfo{UUID: utils.NewUUIDV4(), Start: time.Now(), Metadata: &C.Metadata{}}, manager: m, pushToManager: true}
		m.Join(trackers[i])
	}
	var wg sync.WaitGroup
	start := make(chan struct{})
	for _, tracker := range trackers {
		wg.Add(1)
		go func(c Tracker) { defer wg.Done(); <-start; m.Leave(c) }(tracker)
	}
	close(start)
	if err := m.History().Close(); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	db, err := sql.Open("sqlite", C.Path.Resolve(cfg.Path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err = db.QueryRow(`SELECT COUNT(*) FROM flows`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != len(trackers) {
		t.Fatalf("lost zero-byte connections during shutdown: got %d want %d", count, len(trackers))
	}
}
