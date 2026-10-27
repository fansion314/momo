package traffic_history

import (
	"strings"
	"time"

	C "github.com/metacubex/mihomo/constant"
)

// Record initially borrows tracker metadata. Admission makes an owned copy before
// returning to the producer. No JSON encoding or database work runs in Record().
type Record struct {
	TrackerID              string
	Start                  time.Time
	Observed               time.Time
	Upload, Download       int64
	Metadata               *C.Metadata
	Chains, ProviderChains C.Chain
	Rule, RulePayload      string
	Accounted, Closed      bool
	bytes                  int64
}

type Source interface {
	RangeHistory(func(Record) bool)
	HistoryAlive(string) bool
}

func (r Record) size() int64 {
	n := int64(1024 + len(r.TrackerID) + len(r.Rule) + len(r.RulePayload))
	for _, chain := range []C.Chain{r.Chains, r.ProviderChains} {
		for _, s := range chain {
			n += int64(len(s) + 16)
		}
	}
	if m := r.Metadata; m != nil {
		for _, s := range []string{m.Host, m.SniffHost, m.Process, m.ProcessPath, m.InName, m.InUser, m.RematchName, m.SpecialProxy, m.SpecialRules, m.RemoteDst, m.SrcIPASN, m.DstIPASN, m.UUID, m.SmartBlock, m.SmartTarget, m.WildcardTarget, m.ExitGeoIP, m.ExitIPASN} {
			n += int64(len(s))
		}
		for _, codes := range [][]string{m.SrcGeoIP, m.DstGeoIP} {
			for _, s := range codes {
				n += int64(len(s) + 16)
			}
		}
	}
	return n
}

func (r Record) clone() Record {
	r.TrackerID = strings.Clone(r.TrackerID)
	r.Rule, r.RulePayload = strings.Clone(r.Rule), strings.Clone(r.RulePayload)
	r.Chains, r.ProviderChains = cloneStrings(r.Chains), cloneStrings(r.ProviderChains)
	if r.Metadata != nil {
		m := *r.Metadata
		m.RawSrcAddr, m.RawDstAddr = nil, nil
		m.SrcGeoIP, m.DstGeoIP = cloneStrings(m.SrcGeoIP), cloneStrings(m.DstGeoIP)
		m.Host, m.SniffHost = strings.Clone(m.Host), strings.Clone(m.SniffHost)
		m.Process, m.ProcessPath = strings.Clone(m.Process), strings.Clone(m.ProcessPath)
		m.InName, m.InUser, m.RematchName = strings.Clone(m.InName), strings.Clone(m.InUser), strings.Clone(m.RematchName)
		m.SpecialProxy, m.SpecialRules = strings.Clone(m.SpecialProxy), strings.Clone(m.SpecialRules)
		m.UUID = strings.Clone(m.UUID)
		m.SmartTarget, m.SmartBlock = strings.Clone(m.SmartTarget), strings.Clone(m.SmartBlock)
		m.WildcardTarget = strings.Clone(m.WildcardTarget)
		m.ExitGeoIP, m.ExitIPASN = strings.Clone(m.ExitGeoIP), strings.Clone(m.ExitIPASN)
		m.RemoteDst, m.SrcIPASN, m.DstIPASN = strings.Clone(m.RemoteDst), strings.Clone(m.SrcIPASN), strings.Clone(m.DstIPASN)
		r.Metadata = &m
	}
	return r
}

func cloneStrings[T ~[]string](in T) T {
	if in == nil {
		return nil
	}
	out := make(T, len(in))
	for i, s := range in {
		out[i] = strings.Clone(s)
	}
	return out
}
