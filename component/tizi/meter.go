//go:build tizi

package tizi

import (
	"errors"
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// DayUsage contains only aggregate payload bytes. It never carries connection metadata.
type DayUsage struct {
	Day           string `json:"day"`
	UploadBytes   int64  `json:"upload_bytes"`
	DownloadBytes int64  `json:"download_bytes"`
}

var settlementLocation = time.FixedZone("Asia/Shanghai", 8*60*60)
var activeMeter atomic.Pointer[Meter]

// SettlementDay uses the start date of the Shanghai 07:00 accounting day.
func SettlementDay(at time.Time) string {
	return at.In(settlementLocation).Add(-7 * time.Hour).Format(time.DateOnly)
}

type Meter struct {
	mu         sync.Mutex
	days       map[string]DayUsage
	outbounds  map[string]bool
	healthy    atomic.Bool
	closers    map[uint64]func()
	nextCloser uint64
}

func NewMeter(days []DayUsage) (*Meter, error) {
	m := &Meter{days: make(map[string]DayUsage), closers: make(map[uint64]func())}
	for _, day := range days {
		parsed, err := time.Parse(time.DateOnly, day.Day)
		if err != nil || parsed.Format(time.DateOnly) != day.Day || day.UploadBytes < 0 || day.DownloadBytes < 0 {
			return nil, errors.New("invalid tizi accounting day")
		}
		if _, exists := m.days[day.Day]; exists {
			return nil, errors.New("duplicate tizi accounting day")
		}
		m.days[day.Day] = day
	}
	m.healthy.Store(true)
	return m, nil
}

// SetOutbounds records concrete proxy types from the parsed managed config.
// Looking at adapter names alone would incorrectly bill named DIRECT aliases.
func (m *Meter) SetOutbounds(outbounds map[string]bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.outbounds = make(map[string]bool, len(outbounds))
	for name, eligible := range outbounds {
		m.outbounds[name] = eligible
	}
}

func SetMeter(m *Meter) { activeMeter.Store(m) }

// Capture fixes ownership for this connection even if the selected profile later changes.
func Capture(chains []string, accounted bool) *Meter {
	if !accounted || len(chains) == 0 {
		return nil
	}
	m := activeMeter.Load()
	if m == nil {
		return nil
	}
	switch chains[0] {
	case "DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE":
		return nil
	}
	m.mu.Lock()
	eligible := m.outbounds[chains[0]]
	m.mu.Unlock()
	if !eligible {
		return nil
	}
	return m
}

func (m *Meter) Healthy() bool { return m != nil && m.healthy.Load() }

// SetHealthy(false) closes every registered connection outside the counter lock.
func (m *Meter) SetHealthy(healthy bool) {
	if m == nil {
		return
	}
	m.healthy.Store(healthy)
	if healthy {
		return
	}
	m.CloseConnections()
}

// CloseConnections is used before changing the owner or stopping the journal writer.
// It leaves counters healthy so final reads already in flight can still be recorded.
func (m *Meter) CloseConnections() {
	if m == nil {
		return
	}
	m.mu.Lock()
	closers := make([]func(), 0, len(m.closers))
	for _, close := range m.closers {
		closers = append(closers, close)
	}
	m.mu.Unlock()
	for _, close := range closers {
		close()
	}
}

func (m *Meter) BindClose(close func()) func() {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	m.nextCloser++
	id := m.nextCloser
	m.closers[id] = close
	healthy := m.healthy.Load()
	m.mu.Unlock()
	if !healthy {
		close()
	}
	return func() { m.mu.Lock(); delete(m.closers, id); m.mu.Unlock() }
}

func (m *Meter) Add(upload, download int64) {
	if m != nil {
		m.addAt(upload, download, time.Now())
	}
}

func (m *Meter) addAt(upload, download int64, at time.Time) {
	if m == nil || !m.Healthy() || upload < 0 || download < 0 {
		return
	}
	m.mu.Lock()
	if !m.Healthy() {
		m.mu.Unlock()
		return
	}
	day := SettlementDay(at)
	usage := m.days[day]
	if upload > math.MaxInt64-usage.UploadBytes || download > math.MaxInt64-usage.DownloadBytes {
		m.mu.Unlock()
		m.SetHealthy(false)
		return
	}
	usage.Day = day
	usage.UploadBytes += upload
	usage.DownloadBytes += download
	m.days[day] = usage
	m.mu.Unlock()
}

func (m *Meter) EnsureDay(at time.Time) { m.addAt(0, 0, at) }

func (m *Meter) Snapshot() []DayUsage {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]DayUsage, 0, len(m.days))
	for _, day := range m.days {
		result = append(result, day)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Day < result[j].Day })
	return result
}
