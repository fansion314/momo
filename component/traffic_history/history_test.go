package traffic_history

import (
	"context"
	"database/sql"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	C "github.com/metacubex/mihomo/constant"
)

type emptySource struct{}

func (emptySource) RangeHistory(func(Record) bool) {}
func (emptySource) HistoryAlive(string) bool       { return false }

func testRecorder(t testing.TB) *Recorder {
	t.Helper()
	cfg := DefaultConfig()
	cfg.Path = filepath.Join(t.TempDir(), "history.db")
	cfg.GeoIP.Enable = false
	r, err := newRecorder(cfg, emptySource{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.cancel(); r.geo.close(); _ = r.reader.Close(); _ = r.db.Close() })
	return r
}

func testRecord(r *Recorder, id string, upload, download int64) Record {
	return Record{TrackerID: id, Start: r.started.Add(time.Millisecond), Observed: r.started.Add(time.Second), Upload: upload, Download: download,
		Metadata: &C.Metadata{Host: "example.com", DstIP: netip.MustParseAddr("1.1.1.1"), SrcIP: netip.MustParseAddr("192.168.1.2"), Process: "browser", NetWork: C.TCP}, Chains: C.Chain{"node", "group"}, Rule: "DomainSuffix", RulePayload: "example.com", Accounted: true}
}

func scalar(t testing.TB, r *Recorder, query string) int64 {
	t.Helper()
	var n int64
	if err := r.db.QueryRow(query).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestCheckpointsFinalAndOutOfOrder(t *testing.T) {
	r := testRecorder(t)
	a := testRecord(r, "one", 10, 100)
	if err := r.writeBatch(context.Background(), []Record{a, a}); err != nil {
		t.Fatal(err)
	}
	b := a
	b.Upload = 30
	b.Download = 200
	b.Observed = b.Observed.Add(time.Second)
	final := b
	final.Upload = 40
	final.Download = 250
	final.Closed = true
	final.Observed = final.Observed.Add(time.Second)
	stale := b
	stale.Upload = 1000
	stale.Observed = stale.Observed.Add(10 * time.Second)
	if err := r.writeBatch(context.Background(), []Record{b, a, final, final, stale}); err != nil {
		t.Fatal(err)
	}
	for query, want := range map[string]int64{"SELECT SUM(upload) FROM samples": 40, "SELECT SUM(download) FROM samples": 250, "SELECT SUM(connections) FROM samples": 1, "SELECT COUNT(*) FROM flows WHERE state='closed'": 1, "SELECT recorded_upload FROM flows": 40} {
		if got := scalar(t, r, query); got != want {
			t.Fatalf("%s: got %d want %d", query, got, want)
		}
	}
}

func TestFailedBatchRollsBackAllCheckpoints(t *testing.T) {
	r := testRecorder(t)
	_, err := r.db.Exec(`CREATE TRIGGER injected_failure BEFORE INSERT ON samples WHEN NEW.download=999 BEGIN SELECT RAISE(ABORT,'injected'); END`)
	if err != nil {
		t.Fatal(err)
	}
	batch := []Record{testRecord(r, "a", 10, 20), testRecord(r, "b", 30, 999)}
	if err = r.writeBatch(context.Background(), batch); err == nil {
		t.Fatal("expected injected error")
	}
	if scalar(t, r, "SELECT COUNT(*) FROM flows") != 0 || scalar(t, r, "SELECT COUNT(*) FROM samples") != 0 {
		t.Fatal("partial batch committed")
	}
	if _, err = r.db.Exec(`DROP TRIGGER injected_failure`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err = r.writeBatch(context.Background(), batch); err != nil {
			t.Fatal(err)
		}
	}
	if scalar(t, r, "SELECT SUM(upload) FROM samples") != 40 {
		t.Fatal("retry double counted")
	}
}

func TestPreexistingAndInternalAccounting(t *testing.T) {
	r := testRecorder(t)
	old := testRecord(r, "old", 100, 200)
	old.Start = r.started.Add(-time.Hour)
	internal := testRecord(r, "internal", 1000, 2000)
	internal.Accounted = false
	if err := r.writeBatch(context.Background(), []Record{old, internal}); err != nil {
		t.Fatal(err)
	}
	old.Upload += 25
	old.Download += 50
	old.Observed = old.Observed.Add(time.Second)
	if err := r.writeBatch(context.Background(), []Record{old}); err != nil {
		t.Fatal(err)
	}
	q := DefaultQuery()
	q.From = r.started.Add(-time.Hour).UnixMilli()
	q.To = r.started.Add(time.Hour).UnixMilli()
	result, err := r.Query(context.Background(), "summary", 0, q)
	if err != nil {
		t.Fatal(err)
	}
	data := result["data"].(map[string]any)
	if data["upload"] != int64(25) || data["download"] != int64(50) || data["connections"] != int64(0) {
		t.Fatalf("wrong counted totals: %v", data)
	}
	q.IncludeInternal = true
	result, err = r.Query(context.Background(), "summary", 0, q)
	if err != nil {
		t.Fatal(err)
	}
	if result["data"].(map[string]any)["upload"] != int64(1025) {
		t.Fatal(result)
	}
}

func TestAdmissionOwnsMetadataAndIsBounded(t *testing.T) {
	r := testRecorder(t)
	r.slots = make(chan struct{}, 2)
	r.queue = make(chan Record, 2)
	a := testRecord(r, "one", 1, 2)
	if !r.Record(a) || !r.Record(a) || r.Record(a) {
		t.Fatal("queue admission mismatch")
	}
	a.Metadata.Host = "changed"
	a.Chains[0] = "changed"
	got := <-r.queue
	if got.Metadata.Host != "example.com" || got.Chains[0] != "node" {
		t.Fatal("borrowed mutable metadata")
	}
	r.release(got)
	got = <-r.queue
	r.release(got)
	if r.pendingBytes.Load() != 0 || r.dropped.Load() != 1 {
		t.Fatal(r.Status())
	}
	a.Rule = string(make([]byte, r.cfg.MaxPendingBytes))
	if r.Record(a) || len(r.slots) != 0 {
		t.Fatal("oversize record exceeded budget")
	}
}

func TestRestartRecoveryRetentionAndUnknownEnd(t *testing.T) {
	r := testRecorder(t)
	a := testRecord(r, "lost-final", 10, 20)
	if err := r.writeBatch(context.Background(), []Record{a}); err != nil {
		t.Fatal(err)
	}
	if err := r.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if scalar(t, r, "SELECT COUNT(*) FROM flows WHERE state='unconfirmed' AND end_at_ms IS NULL") != 1 {
		t.Fatal("invented end time")
	}
	_ = r.reader.Close()
	_ = r.db.Close()
	reopened, err := newRecorder(r.cfg, emptySource{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.cancel()
	defer reopened.reader.Close()
	defer reopened.db.Close()
	defer reopened.geo.close()
	if scalar(t, reopened, "SELECT COUNT(*) FROM flows WHERE state='interrupted' AND end_at_ms IS NULL") != 1 {
		t.Fatal("restart did not mark abandoned flow")
	}
	if _, err = reopened.db.Exec(`UPDATE samples SET at_ms=1; UPDATE flows SET last_at_ms=1,state_at_ms=1`); err != nil {
		t.Fatal(err)
	}
	if err = reopened.cleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
	if scalar(t, reopened, "SELECT COUNT(*) FROM samples") != 0 || scalar(t, reopened, "SELECT COUNT(*) FROM flows") != 0 {
		t.Fatal("retention failed")
	}
}

func TestGroupsSeriesAndPagination(t *testing.T) {
	r := testRecorder(t)
	batch := []Record{testRecord(r, "a", 10, 20), testRecord(r, "b", 30, 40)}
	if err := r.writeBatch(context.Background(), batch); err != nil {
		t.Fatal(err)
	}
	q := DefaultQuery()
	q.From = r.started.UnixMilli()
	q.To = r.started.Add(time.Hour).UnixMilli()
	q.GroupBy = []string{"policy", "chain", "sourceIP"}
	result, err := r.Query(context.Background(), "groups", 0, q)
	if err != nil {
		t.Fatal(err)
	}
	data := result["data"].([]map[string]any)
	if len(data) != 1 || data[0]["upload"] != int64(40) {
		t.Fatal(result)
	}
	q.Limit = 1
	result, err = r.Query(context.Background(), "flows", 0, q)
	if err != nil {
		t.Fatal(err)
	}
	if result["truncated"] != true {
		t.Fatal(result)
	}
	q.Cursor = result["nextCursor"].(int64)
	result, err = r.Query(context.Background(), "flows", 0, q)
	if err != nil || len(result["data"].([]map[string]any)) != 1 {
		t.Fatalf("%v %v", result, err)
	}
	q.GroupBy = []string{"domain); DROP TABLE flows;--"}
	if _, err = r.Query(context.Background(), "groups", 0, q); err == nil {
		t.Fatal("accepted SQL identifier injection")
	}
	q = DefaultQuery()
	q.To = q.From
	if q.Validate() == nil {
		t.Fatal("accepted empty range")
	}
}

func TestServiceCloseAndConcurrentAdmission(t *testing.T) {
	r := testRecorder(t)
	go r.run()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 1000; i++ {
			rec := testRecord(r, fmt.Sprint(i), 1, 2)
			rec.Closed = true
			r.Record(rec)
		}
	}()
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	<-done
	if r.Record(testRecord(r, "late", 1, 2)) {
		t.Fatal("accepted after close")
	}
	if len(r.slots) != 0 || r.pendingBytes.Load() != 0 {
		t.Fatal(r.Status())
	}
}

func BenchmarkFinalAdmission(b *testing.B) {
	r := testRecorder(b)
	rec := testRecord(r, "flow", 1, 2)
	rec.Closed = true
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if !r.Record(rec) {
			b.Fatal("unexpected drop")
		}
		got := <-r.queue
		r.release(got)
	}
}

func BenchmarkBatchWriter(b *testing.B) {
	r := testRecorder(b)
	batch := make([]Record, 512)
	for i := range batch {
		batch[i] = testRecord(r, fmt.Sprint(i), 0, 0)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for j := range batch {
			batch[j].Upload++
			batch[j].Download += 10
			batch[j].Observed = batch[j].Observed.Add(time.Second)
		}
		if err := r.writeBatch(context.Background(), batch); err != nil {
			b.Fatal(err)
		}
	}
	b.ReportMetric(float64(b.N*len(batch))/b.Elapsed().Seconds(), "records/s")
}

type loadSource struct {
	mu      sync.Mutex
	records []Record
}

func (s *loadSource) RangeHistory(visit func(Record) bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.records {
		s.records[i].Upload++
		s.records[i].Download += 10
		s.records[i].Observed = time.Now()
		if !visit(s.records[i]) {
			return
		}
	}
}
func (s *loadSource) HistoryAlive(string) bool { return true }

func TestHealthyLoad(t *testing.T) {
	if os.Getenv("MIHOMO_HISTORY_STRESS") != "1" {
		t.Skip("set MIHOMO_HISTORY_STRESS=1 for 10k active / 1k short connections/s stress test")
	}
	r := testRecorder(t)
	r.cfg.SampleInterval = time.Second // Deliberately more demanding than the default 30s.
	r.cfg.FlushInterval = 20 * time.Millisecond
	source := &loadSource{records: make([]Record, 10000)}
	for i := range source.records {
		source.records[i] = testRecord(r, fmt.Sprintf("active-%d", i), 0, 0)
	}
	r.source = source
	go r.run()
	t.Cleanup(func() { _ = r.Close() })
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for i := 0; i < 500; i++ {
		<-ticker.C
		for j := 0; j < 10; j++ {
			rec := testRecord(r, fmt.Sprintf("short-%d-%d", i, j), 123, 456)
			rec.Start = time.Now()
			rec.Observed = rec.Start
			rec.Closed = true
			if !r.Record(rec) {
				t.Fatal("healthy workload dropped a final record", r.Status())
			}
		}
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	status := r.Status()
	if status.DroppedRecords != 0 || status.SkippedSamples != 0 || status.WriteErrors != 0 {
		t.Fatal(status)
	}
	db, err := sql.Open("sqlite", r.cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count, upload int64
	if err = db.QueryRow(`SELECT COUNT(*),SUM(recorded_upload) FROM flows WHERE tracker_id LIKE 'short-%'`).Scan(&count, &upload); err != nil {
		t.Fatal(err)
	}
	if count != 5000 || upload != 5000*123 {
		t.Fatalf("count=%d upload=%d", count, upload)
	}
	t.Logf("10k active, 5k short records, 1s sampling: %+v", status)
}

func TestQueryConcurrencyAndCancellation(t *testing.T) {
	r := testRecorder(t)
	q := DefaultQuery()
	r.queries <- struct{}{}
	r.queries <- struct{}{}
	if _, err := r.Query(context.Background(), "summary", 0, q); err != ErrBusy {
		t.Fatalf("expected busy, got %v", err)
	}
	<-r.queries
	<-r.queries
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.Query(ctx, "summary", 0, q); err == nil {
		t.Fatal("ignored cancellation")
	}
}

func TestStorageFailureKeepsAdmissionBounded(t *testing.T) {
	r := testRecorder(t)
	r.cfg.BatchSize = 1
	r.cfg.QueueSize = 2
	r.slots = make(chan struct{}, 2)
	r.queue = make(chan Record, 2)
	if _, err := r.db.Exec(`CREATE TRIGGER storage_failure BEFORE INSERT ON flows BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END`); err != nil {
		t.Fatal(err)
	}
	go r.run()
	t.Cleanup(func() { _ = r.Close() })
	if !r.Record(testRecord(r, "first", 1, 2)) {
		t.Fatal("first admission failed")
	}
	deadline := time.After(3 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for r.writeErrors.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("writer did not encounter failure")
		case <-tick.C:
		}
	}
	start := time.Now()
	if !r.Record(testRecord(r, "second", 1, 2)) || r.Record(testRecord(r, "third", 1, 2)) {
		t.Fatal("failed writer did not retain bounded queue")
	}
	if time.Since(start) > 250*time.Millisecond {
		t.Fatal("admission waited for storage")
	}
	if _, err := r.db.Exec(`DROP TRIGGER storage_failure`); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if r.Status().DroppedRecords != 1 || r.Status().WriteErrors == 0 {
		t.Fatal(r.Status())
	}
}

func TestGeoMetadataAndMissingFiles(t *testing.T) {
	g := openGeo(GeoConfig{Enable: true, CountryPath: filepath.Join(t.TempDir(), "absent.mmdb"), ASNPath: filepath.Join(t.TempDir(), "absent-asn.mmdb")})
	defer g.close()
	if len(g.warnings) != 2 {
		t.Fatal(g.warnings)
	}
	m := &C.Metadata{DstIP: netip.MustParseAddr("1.1.1.1"), DstGeoIP: []string{"cn"}, DstIPASN: "13335 Cloudflare"}
	geo := g.lookup(m)
	if geo.Country != "CN" || geo.ASN != "13335" || geo.Organization != "Cloudflare" {
		t.Fatal(geo)
	}
	if got := g.lookup(&C.Metadata{DstIP: netip.MustParseAddr("192.168.1.2")}); got.Country != "LOCAL" {
		t.Fatal(got)
	}
	if got := g.lookup(&C.Metadata{}); got.Country != "UNKNOWN" {
		t.Fatal(got)
	}
}

func TestRejectUnrelatedDatabase(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Path = filepath.Join(t.TempDir(), "unrelated.db")
	cfg.GeoIP.Enable = false
	db, err := sql.Open("sqlite", cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE important_data(value TEXT);INSERT INTO important_data VALUES('keep')`); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = newRecorder(cfg, emptySource{}); err == nil {
		t.Fatal("adopted unrelated SQLite file")
	}
	var value string
	if err = db.QueryRow(`SELECT value FROM important_data`).Scan(&value); err != nil || value != "keep" {
		t.Fatalf("%q %v", value, err)
	}
}

func TestServiceReloadAndRecordingGap(t *testing.T) {
	oldHome := C.Path.HomeDir()
	C.SetHomeDir(t.TempDir())
	defer C.SetHomeDir(oldHome)
	var service Service
	cfg := DefaultConfig()
	cfg.Enable = true
	cfg.GeoIP.Enable = false
	if err := service.Configure(cfg, emptySource{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close() })
	first := service.Recorder()
	if err := service.Configure(cfg, emptySource{}); err != nil || service.Recorder() != first {
		t.Fatalf("reload was not idempotent: %v", err)
	}
	rec := testRecord(first, "connection", 100, 200)
	rec.Closed = true
	if !first.Record(rec) {
		t.Fatal("first recording failed")
	}
	cfg.Enable = false
	if err := service.Configure(cfg, emptySource{}); err != nil {
		t.Fatal(err)
	}
	if service.Status().Enabled || service.Recorder() != nil {
		t.Fatal(service.Status())
	}
	cfg.Enable = true
	if err := service.Configure(cfg, emptySource{}); err != nil {
		t.Fatal(err)
	}
	second := service.Recorder()
	if first.session == second.session {
		t.Fatal("reused recording session")
	}
	rec.Start = second.started.Add(-time.Hour)
	rec.Observed = second.started
	rec.Upload = 1000
	rec.Download = 2000
	rec.Closed = false
	if !second.Record(rec) {
		t.Fatal("baseline admission failed")
	}
	rec.Upload += 25
	rec.Download += 50
	rec.Closed = true
	rec.Observed = rec.Observed.Add(time.Second)
	if !second.Record(rec) {
		t.Fatal("final admission failed")
	}
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", C.Path.Resolve(cfg.Path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var upload int64
	if err = db.QueryRow(`SELECT SUM(upload) FROM samples`).Scan(&upload); err != nil || upload != 125 {
		t.Fatalf("gap was backfilled: upload=%d err=%v", upload, err)
	}
}

// Exercise short-lived flow insertion rather than repeatedly updating the same
// live checkpoint. This captures the workload used in proxy load acceptance.
func BenchmarkNewFlowBatchWriter(b *testing.B) {
	r := testRecorder(b)
	batch := make([]Record, 512)
	for i := range batch {
		batch[i] = testRecord(r, "", 64, 64)
		batch[i].Closed = true
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for j := range batch {
			batch[j].TrackerID = fmt.Sprintf("short-%d-%d", i, j)
		}
		if err := r.writeBatch(context.Background(), batch); err != nil {
			b.Fatal(err)
		}
	}
	b.ReportMetric(float64(b.N*len(batch))/b.Elapsed().Seconds(), "records/s")
}
