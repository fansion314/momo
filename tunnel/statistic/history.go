package statistic

import (
	"time"

	"github.com/metacubex/mihomo/component/traffic_history"
)

func (m *Manager) History() *traffic_history.Service { return &m.history }

func (m *Manager) HistoryAlive(id string) bool { return m.Get(id) != nil }

func (m *Manager) RangeHistory(visit func(traffic_history.Record) bool) {
	m.Range(func(c Tracker) bool { return visit(historyRecord(c, false)) })
}

func historyRecord(c Tracker, closed bool) traffic_history.Record {
	info := c.Info()
	accounted := true
	switch tracker := c.(type) {
	case *tcpTracker:
		accounted = tracker.pushToManager
	case *udpTracker:
		accounted = tracker.pushToManager
	}
	return traffic_history.Record{TrackerID: c.ID(), Start: info.Start, Observed: time.Now(),
		Upload: info.UploadTotal.Load(), Download: info.DownloadTotal.Load(), Metadata: info.Metadata,
		Chains: info.Chain, ProviderChains: info.ProviderChain, Rule: info.Rule, RulePayload: info.RulePayload,
		Accounted: accounted, Closed: closed}
}
