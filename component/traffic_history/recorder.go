package traffic_history

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/metacubex/mihomo/common/utils"
	"github.com/metacubex/mihomo/log"
)

type Status struct {
	AggregationTimezone    string   `json:"aggregationTimezone"`
	DetailAvailableFrom    *int64   `json:"detailAvailableFrom"`
	AggregateAvailableFrom *int64   `json:"aggregateAvailableFrom"`
	Enabled                bool     `json:"enabled"`
	Ready                  bool     `json:"ready"`
	Healthy                bool     `json:"healthy"`
	SessionID              string   `json:"sessionId,omitempty"`
	StartedAt              int64    `json:"startedAt,omitempty"`
	SchemaVersion          int      `json:"schemaVersion"`
	RetentionDays          int      `json:"retentionDays"`
	SampleIntervalMs       int64    `json:"sampleIntervalMs"`
	QueueUsed              int      `json:"queueUsed"`
	PendingBytes           int64    `json:"pendingBytes"`
	DroppedRecords         int64    `json:"droppedRecords"`
	SkippedSamples         int64    `json:"skippedSamples"`
	WriteErrors            int64    `json:"writeErrors"`
	LastCommitAt           int64    `json:"lastCommitAt"`
	LastError              string   `json:"lastError,omitempty"`
	GeoWarnings            []string `json:"geoWarnings,omitempty"`
}

// Service is zero-value ready. Its pointer load is the only history operation
// added to a disabled Manager.Leave; configuration never locks that call site.
type Service struct {
	mu       sync.Mutex
	cfg      Config
	current  atomic.Pointer[Recorder]
	statusMu sync.RWMutex
	last     Status
}

func (s *Service) Recorder() *Recorder { return s.current.Load() }

func (s *Service) Status() Status {
	if r := s.current.Load(); r != nil {
		return r.Status()
	}
	s.statusMu.RLock()
	defer s.statusMu.RUnlock()
	return s.last
}

func (s *Service) setStatus(status Status) { s.statusMu.Lock(); s.last = status; s.statusMu.Unlock() }

func (s *Service) Configure(cfg Config, source Source) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := cfg.Validate(); err != nil {
		return err
	}
	if s.cfg == cfg && (!cfg.Enable || s.current.Load() != nil) {
		return nil
	}
	if old := s.current.Load(); old != nil {
		err := old.Close()
		s.current.Store(nil)
		status := old.Status()
		status.Ready = false
		status.Enabled = cfg.Enable
		if err != nil {
			status.LastError = err.Error()
		}
		s.setStatus(status)
		if err != nil {
			return err
		}
	}
	s.cfg = cfg
	if !cfg.Enable {
		status := s.Status()
		status.Enabled = false
		status.Ready = false
		s.setStatus(status)
		return nil
	}
	r, err := newRecorder(cfg, source)
	if err != nil {
		status := s.Status()
		status.Enabled = true
		status.Ready = false
		status.SchemaVersion = schemaVersion
		status.RetentionDays = cfg.RetentionDays
		status.LastError = err.Error()
		s.setStatus(status)
		return err
	}
	s.current.Store(r)
	go r.run()
	return nil
}

func (s *Service) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.current.Load(); r != nil {
		err := r.Close()
		s.current.Store(nil)
		status := r.Status()
		status.Ready = false
		s.setStatus(status)
		return err
	}
	return nil
}

type Recorder struct {
	coverageMu                                              sync.Mutex
	detailAvailableFrom, aggregateAvailableFrom             *int64
	aggregationTimezone                                     string
	aggregationLocation                                     *time.Location
	cfg                                                     Config
	source                                                  Source
	db, reader                                              *sql.DB
	geo                                                     *geoReader
	session                                                 string
	started                                                 time.Time
	ctx                                                     context.Context
	cancel                                                  context.CancelFunc
	queue                                                   chan Record
	slots                                                   chan struct{}
	queries                                                 chan struct{}
	acceptMu                                                sync.RWMutex
	accepting                                               bool
	stop, done                                              chan struct{}
	stopOnce                                                sync.Once
	pendingBytes, dropped, skipped, writeErrors, lastCommit atomic.Int64
	errorMu                                                 sync.RWMutex
	lastError                                               string
	pending                                                 []Record // writer-owned, at most BatchSize records
	retryAt                                                 time.Time
	retryDelay                                              time.Duration
	lastWarning                                             time.Time
	warnedDrops                                             int64
}

func newRecorder(cfg Config, source Source) (*Recorder, error) {
	ctx, cancel := context.WithCancel(context.Background())
	openCtx, openCancel := context.WithTimeout(ctx, 5*time.Minute)
	defer openCancel()
	db, reader, err := openDatabase(openCtx, cfg.Path, cfg.AggregationTimezone)
	if err != nil {
		cancel()
		return nil, err
	}
	r := &Recorder{cfg: cfg, source: source, db: db, reader: reader, session: utils.NewUUIDV4().String(), started: time.Now(), ctx: ctx, cancel: cancel,
		queue: make(chan Record, cfg.QueueSize), slots: make(chan struct{}, cfg.QueueSize), queries: make(chan struct{}, 2), accepting: true, stop: make(chan struct{}), done: make(chan struct{}), pending: make([]Record, 0, cfg.BatchSize)}
	r.aggregationTimezone, r.aggregationLocation, err = loadAggregationTimezone(openCtx, db)
	if err != nil {
		_ = reader.Close()
		_ = db.Close()
		cancel()
		return nil, err
	}
	tx, err := db.BeginTx(openCtx, nil)
	if err == nil {
		_, err = tx.ExecContext(openCtx, `UPDATE flows SET state='interrupted',state_at_ms=? WHERE session_id IN (SELECT id FROM sessions WHERE state='active') AND state IN ('active','unconfirmed')`, r.started.UnixMilli())
		if err == nil {
			_, err = tx.ExecContext(openCtx, `UPDATE sessions SET state='interrupted' WHERE state='active'`)
		}
		if err == nil {
			_, err = tx.ExecContext(openCtx, `INSERT INTO sessions(id,started_at_ms,state) VALUES(?,?,'active')`, r.session, r.started.UnixMilli())
		}
		if err == nil {
			err = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
	}
	if err != nil {
		_ = reader.Close()
		_ = db.Close()
		cancel()
		return nil, err
	}
	r.geo = openGeo(cfg.GeoIP)
	for _, warning := range r.geo.warnings {
		log.Warnln("[TrafficHistory] GeoIP: %s", warning)
	}
	return r, nil
}

func (r *Recorder) Status() Status {
	r.errorMu.RLock()
	lastError := r.lastError
	r.errorMu.RUnlock()
	ready := r.ctx.Err() == nil
	select {
	case <-r.done:
		ready = false
	default:
	}
	detail, aggregate := r.availability()
	return Status{AggregationTimezone: r.aggregationTimezone, DetailAvailableFrom: detail, AggregateAvailableFrom: aggregate, Enabled: true, Ready: ready, Healthy: ready && lastError == "", SessionID: r.session, StartedAt: r.started.UnixMilli(), SchemaVersion: schemaVersion, RetentionDays: r.cfg.RetentionDays, SampleIntervalMs: r.cfg.SampleInterval.Milliseconds(),
		QueueUsed: len(r.slots), PendingBytes: r.pendingBytes.Load(), DroppedRecords: r.dropped.Load(), SkippedSamples: r.skipped.Load(), WriteErrors: r.writeErrors.Load(), LastCommitAt: r.lastCommit.Load(), LastError: lastError, GeoWarnings: append([]string(nil), r.geo.warnings...)}
}

// Record never waits for SQLite or queue capacity. The short admission lock
// only synchronizes with stopping producers; database work never holds it.
func (r *Recorder) Record(rec Record) bool {
	r.acceptMu.RLock()
	defer r.acceptMu.RUnlock()
	return r.recordLocked(rec)
}

// OnLeave includes removal from the active map in the admission barrier.
// This prevents shutdown from missing a connection between its removal and
// enqueue. The callback must never perform network or database I/O.
func (r *Recorder) OnLeave(remove func() (Record, bool)) {
	r.acceptMu.RLock()
	defer r.acceptMu.RUnlock()
	if rec, ok := remove(); ok {
		r.recordLocked(rec)
	}
}

func (r *Recorder) recordLocked(rec Record) bool {
	if !r.accepting {
		return false
	}
	if !r.reserve(&rec) {
		r.dropped.Add(1)
		return false
	}
	r.queue <- rec.clone() // reserved slot guarantees channel capacity
	return true
}

func (r *Recorder) reserve(rec *Record) bool {
	select {
	case r.slots <- struct{}{}:
	default:
		return false
	}
	n := rec.size()
	for {
		used := r.pendingBytes.Load()
		if n > r.cfg.MaxPendingBytes-used {
			<-r.slots
			return false
		}
		if r.pendingBytes.CompareAndSwap(used, used+n) {
			rec.bytes = n
			return true
		}
	}
}

func (r *Recorder) release(rec Record) { r.pendingBytes.Add(-rec.bytes); <-r.slots }

func (r *Recorder) Close() error {
	r.stopOnce.Do(func() { close(r.stop) })
	timer := time.NewTimer(r.cfg.ShutdownTimeout)
	defer timer.Stop()
	select {
	case <-r.done:
		if lastError := r.Status().LastError; lastError != "" {
			return errors.New(lastError)
		}
		return nil
	case <-timer.C:
		r.cancel()
		return errors.New("traffic-history: shutdown deadline exceeded; pending data may be lost")
	}
}

func (r *Recorder) stopAccepting() {
	r.acceptMu.Lock()
	r.accepting = false
	r.acceptMu.Unlock()
}

func (r *Recorder) failure(err error) {
	r.writeErrors.Add(1)
	r.errorMu.Lock()
	r.lastError = err.Error()
	r.errorMu.Unlock()
	if time.Since(r.lastWarning) >= 30*time.Second {
		log.Warnln("[TrafficHistory] %s", err)
		r.lastWarning = time.Now()
	}
}

func (r *Recorder) flush(force bool) bool {
	if len(r.pending) == 0 {
		return true
	}
	if !force && time.Now().Before(r.retryAt) {
		return false
	}
	ctx, cancel := context.WithTimeout(r.ctx, 2*time.Second)
	defer cancel()
	if err := r.writeBatch(ctx, r.pending); err != nil {
		r.failure(err)
		if r.retryDelay == 0 {
			r.retryDelay = time.Second
		} else {
			r.retryDelay = min(30*time.Second, r.retryDelay*2)
		}
		r.retryAt = time.Now().Add(r.retryDelay)
		return false
	}
	for i, rec := range r.pending {
		r.release(rec)
		r.pending[i] = Record{}
	}
	r.pending = r.pending[:0]
	r.retryDelay = 0
	r.retryAt = time.Time{}
	r.lastCommit.Store(time.Now().UnixMilli())
	r.errorMu.Lock()
	r.lastError = ""
	r.errorMu.Unlock()
	return true
}

func (r *Recorder) drain() {
	for len(r.pending) < r.cfg.BatchSize {
		select {
		case rec := <-r.queue:
			r.pending = append(r.pending, rec)
		default:
			return
		}
	}
}

func (r *Recorder) sample() {
	if !r.flush(false) {
		r.skipped.Add(1)
		return
	}
	r.source.RangeHistory(func(rec Record) bool {
		if r.ctx.Err() != nil {
			return false
		}
		// Interleave final records with sampling instead of building a full
		// snapshot or making the producer queue wait for a complete traversal.
		r.drain()
		if len(r.pending) == r.cfg.BatchSize && !r.flush(false) {
			r.skipped.Add(1)
			return false
		}
		if !r.reserve(&rec) {
			r.skipped.Add(1)
			return true
		}
		r.pending = append(r.pending, rec.clone())
		if len(r.pending) == r.cfg.BatchSize {
			return r.flush(false)
		}
		return true
	})
	if r.flush(false) {
		ctx, cancel := context.WithTimeout(r.ctx, 2*time.Second)
		if err := r.reconcile(ctx); err != nil {
			r.failure(err)
		}
		cancel()
	}
}

func (r *Recorder) run() {
	defer close(r.done)
	defer r.db.Close()
	defer r.reader.Close()
	defer r.availability()
	defer r.geo.close()
	defer func() {
		lost := int64(0)
		for _, rec := range r.pending {
			lost++
			r.release(rec)
		}
		for {
			select {
			case rec := <-r.queue:
				lost++
				r.release(rec)
			default:
				if lost != 0 {
					r.dropped.Add(lost)
					log.Warnln("[TrafficHistory] discarded %d pending records during shutdown", lost)
				}
				return
			}
		}
	}()
	defer r.cancel()
	defer r.stopAccepting()
	samples := time.NewTicker(r.cfg.SampleInterval)
	defer samples.Stop()
	flush := time.NewTicker(r.cfg.FlushInterval)
	defer flush.Stop()
	cleanup := time.NewTicker(time.Hour)
	defer cleanup.Stop()
	cleanupPending := r.cfg.RetentionDays != 0
	var lastCleanup time.Time
	r.sample() // Establish a baseline for connections predating this session.
	for {
		var input <-chan Record
		if len(r.pending) < r.cfg.BatchSize {
			input = r.queue
		}
		select {
		case rec := <-input:
			r.pending = append(r.pending, rec)
			if len(r.pending) == r.cfg.BatchSize {
				r.flush(false)
			}
		case <-samples.C:
			r.sample()
		case <-cleanup.C:
			cleanupPending = true
		case <-flush.C:
			r.flush(false)
			if cleanupPending && len(r.pending) == 0 && len(r.slots) < max(1, r.cfg.QueueSize/2) && time.Since(lastCleanup) >= time.Second {
				lastCleanup = time.Now()
				deadline := lastCleanup.Add(25 * time.Millisecond)
				ctx, cancel := context.WithTimeout(r.ctx, 100*time.Millisecond)
				for {
					done, err := r.cleanupStep(ctx)
					if err != nil {
						r.failure(err)
						break
					}
					if done {
						cleanupPending = false
						break
					}
					if time.Now().After(deadline) {
						break
					}
				}
				cancel()
			}
			if dropped := r.dropped.Load(); dropped != r.warnedDrops && time.Since(r.lastWarning) >= 30*time.Second {
				log.Warnln("[TrafficHistory] dropped %d final records (queue or memory budget exhausted)", dropped)
				r.warnedDrops = dropped
				r.lastWarning = time.Now()
			}
		case <-r.stop:
			r.retryAt = time.Time{}
			r.sample()
			r.stopAccepting()
			for {
				r.drain()
				if !r.flush(true) {
					return
				}
				if len(r.queue) == 0 {
					break
				}
			}
			ctx, cancel := context.WithTimeout(r.ctx, 2*time.Second)
			err := r.finish(ctx)
			cancel()
			if err != nil {
				r.failure(err)
			}
			return
		case <-r.ctx.Done():
			return
		}
	}
}

func (r *Recorder) finish(ctx context.Context) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE flows SET state='suspended',state_at_ms=? WHERE session_id=? AND state='active'`, time.Now().UnixMilli(), r.session); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE sessions SET ended_at_ms=?,state='stopped',dropped_records=?,skipped_samples=?,write_errors=? WHERE id=?`, time.Now().UnixMilli(), r.dropped.Load(), r.skipped.Load(), r.writeErrors.Load(), r.session); err != nil {
		return err
	}
	return tx.Commit()
}
