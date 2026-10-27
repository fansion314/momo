package traffic_history

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestRetentionDrainsExpiredConnectionBatches(t *testing.T) {
	r := testRecorder(t)
	const count = 1501
	batch := make([]Record, count)
	for i := range batch {
		batch[i] = testRecord(r, fmt.Sprintf("expired-%d", i), 1, 2)
		batch[i].Closed = true
	}
	if err := r.writeBatch(context.Background(), batch); err != nil {
		t.Fatal(err)
	}
	if _, err := r.db.Exec(`UPDATE samples SET at_ms=1; UPDATE flows SET last_at_ms=1,state_at_ms=1`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := r.cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if got := scalar(t, r, "SELECT COUNT(*) FROM samples"); got != 0 {
		t.Fatalf("retained %d expired samples", got)
	}
	if got := scalar(t, r, "SELECT COUNT(*) FROM flows"); got != 0 {
		t.Fatalf("retained %d expired terminal flows after one cleanup", got)
	}
}

func TestRetentionNeverReusesFlowOrSampleIDs(t *testing.T) {
	r := testRecorder(t)
	old := testRecord(r, "old", 1, 2)
	old.Closed = true
	if err := r.writeBatch(context.Background(), []Record{old}); err != nil {
		t.Fatal(err)
	}
	oldFlowID := scalar(t, r, "SELECT MAX(id) FROM flows")
	oldSampleID := scalar(t, r, "SELECT MAX(id) FROM samples")
	if _, err := r.db.Exec(`UPDATE samples SET at_ms=1; UPDATE flows SET last_at_ms=1,state_at_ms=1`); err != nil {
		t.Fatal(err)
	}
	if err := r.cleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
	if scalar(t, r, "SELECT COUNT(*) FROM flows") != 0 || scalar(t, r, "SELECT COUNT(*) FROM samples") != 0 {
		t.Fatal("cleanup did not empty flow and sample tables")
	}
	next := testRecord(r, "next", 3, 4)
	if err := r.writeBatch(context.Background(), []Record{next}); err != nil {
		t.Fatal(err)
	}
	if got := scalar(t, r, "SELECT MIN(id) FROM flows"); got <= oldFlowID {
		t.Fatalf("flow ID reused: got %d after previous maximum %d", got, oldFlowID)
	}
	if got := scalar(t, r, "SELECT MIN(id) FROM samples"); got <= oldSampleID {
		t.Fatalf("sample ID reused: got %d after previous maximum %d", got, oldSampleID)
	}
}

func TestRetentionUsesUnconfirmedStateObservationTime(t *testing.T) {
	r := testRecorder(t)
	batch := []Record{
		testRecord(r, "expired-unconfirmed", 1, 2),
		testRecord(r, "recent-unconfirmed", 3, 4),
		testRecord(r, "still-active", 5, 6),
	}
	if err := r.writeBatch(context.Background(), batch); err != nil {
		t.Fatal(err)
	}
	// EmptySource reports both missing flows. Reconcile must record when their
	// disappearance was observed, independently of their last traffic sample.
	if _, err := r.db.Exec(`UPDATE samples SET at_ms=1; UPDATE flows SET last_at_ms=1,state_at_ms=1`); err != nil {
		t.Fatal(err)
	}
	if err := r.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	cutoff := time.Now().Add(-time.Duration(r.cfg.RetentionDays) * 24 * time.Hour).UnixMilli()
	if got := scalar(t, r, fmt.Sprintf(`SELECT COUNT(*) FROM flows WHERE state='unconfirmed' AND state_at_ms>%d`, cutoff)); got != int64(len(batch)) {
		t.Fatalf("reconcile did not timestamp newly unconfirmed flows: got %d", got)
	}
	if _, err := r.db.Exec(`UPDATE flows SET state_at_ms=1 WHERE tracker_id='expired-unconfirmed'; UPDATE flows SET state='active' WHERE tracker_id='still-active'`); err != nil {
		t.Fatal(err)
	}
	if err := r.cleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := scalar(t, r, `SELECT COUNT(*) FROM flows WHERE tracker_id='expired-unconfirmed'`); got != 0 {
		t.Fatal("expired unconfirmed flow in current session was retained")
	}
	if got := scalar(t, r, `SELECT COUNT(*) FROM flows WHERE tracker_id='recent-unconfirmed' AND state='unconfirmed'`); got != 1 {
		t.Fatal("recently unconfirmed idle flow expired before its state observation aged out")
	}
	if got := scalar(t, r, `SELECT COUNT(*) FROM flows WHERE tracker_id='still-active' AND state='active'`); got != 1 {
		t.Fatal("active flow checkpoint expired")
	}
	if got := scalar(t, r, "SELECT COUNT(*) FROM samples"); got != 0 {
		t.Fatalf("retained %d expired samples", got)
	}
}
