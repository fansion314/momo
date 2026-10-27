package traffic_history

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func dailyRecorder(t *testing.T, zone string) *Recorder {
	t.Helper()
	cfg := DefaultConfig()
	cfg.Path = filepath.Join(t.TempDir(), "daily.db")
	cfg.GeoIP.Enable = false
	cfg.AggregationTimezone = zone
	r, err := newRecorder(cfg, emptySource{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.cancel(); r.geo.close(); r.reader.Close(); r.db.Close() })
	return r
}
func dayQuery(r *Recorder, at time.Time) Query {
	loc := r.aggregationLocation
	t := at.In(loc)
	start := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
	q := DefaultQuery()
	q.Resolution = "day"
	q.Interval = 24 * time.Hour
	q.From = start.UnixMilli()
	q.To = start.AddDate(0, 0, 1).UnixMilli()
	return q
}

func TestDailyTransactionRetryAndRetention(t *testing.T) {
	r := dailyRecorder(t, "Asia/Shanghai")
	ctx := context.Background()
	if _, err := r.db.Exec(`CREATE TRIGGER fail_daily BEFORE INSERT ON daily_usage WHEN NEW.download>=999 BEGIN SELECT RAISE(ABORT,'daily failure'); END`); err != nil {
		t.Fatal(err)
	}
	batch := []Record{testRecord(r, "a", 10, 20), testRecord(r, "b", 30, 999)}
	batch[0].Metadata.SrcPort = 1234
	batch[1].Metadata.SrcPort = 5678
	batch[0].Metadata.SmartTarget = "target-one"
	batch[1].Metadata.SmartTarget = "target-two"
	if err := r.writeBatch(ctx, batch); err == nil {
		t.Fatal("expected transaction failure")
	}
	for _, table := range []string{"flows", "samples", "daily_usage"} {
		if scalar(t, r, "SELECT COUNT(*) FROM "+table) != 0 {
			t.Fatalf("partial transaction: %s", table)
		}
	}
	if _, err := r.db.Exec("DROP TRIGGER fail_daily"); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := r.writeBatch(ctx, batch); err != nil {
			t.Fatal(err)
		}
	}
	if scalar(t, r, "SELECT SUM(upload) FROM daily_usage") != 40 || scalar(t, r, "SELECT SUM(connections) FROM daily_usage") != 2 {
		t.Fatal("retry duplicated aggregate")
	}
	if scalar(t, r, "SELECT COUNT(*) FROM daily_usage") != 1 {
		t.Fatal("raw ports/tracker IDs/Smart metadata fragmented daily rollup")
	}
	q := dayQuery(r, batch[0].Observed)
	result, err := r.Query(ctx, "summary", 0, q)
	if err != nil {
		t.Fatal(err)
	}
	data := result["data"].(map[string]any)
	if data["upload"] != int64(40) || data["connections"] != int64(2) || data["participatingConnections"] != nil {
		t.Fatal(result)
	}
	q.GroupBy = []string{"domain", "sourceIP", "chain"}
	q.Filters = map[string]string{"policy": "group"}
	if result, err = r.Query(ctx, "groups", 0, q); err != nil || len(result["data"].([]map[string]any)) != 1 {
		t.Fatalf("groups %v %v", result, err)
	}
	if _, err = r.db.Exec("UPDATE samples SET at_ms=1;UPDATE flows SET state='closed',state_at_ms=1"); err != nil {
		t.Fatal(err)
	}
	if err = r.cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if scalar(t, r, "SELECT COUNT(*) FROM samples") != 0 || scalar(t, r, "SELECT COUNT(*) FROM flows") != 0 || scalar(t, r, "SELECT SUM(upload) FROM daily_usage") != 40 {
		t.Fatal("retention removed aggregates")
	}
	status := r.Status()
	if status.DetailAvailableFrom != nil || status.AggregateAvailableFrom == nil || status.AggregationTimezone != "Asia/Shanghai" {
		t.Fatal(status)
	}
}

func TestDailyV2BackfillOnceAndTimezonePersisted(t *testing.T) {
	r := dailyRecorder(t, "America/New_York")
	ctx := context.Background()
	batch := make([]Record, 603)
	for i := range batch {
		batch[i] = testRecord(r, fmt.Sprintf("legacy-%d", i), 7, 13)
	}
	if err := r.writeBatch(ctx, batch); err != nil {
		t.Fatal(err)
	}
	// Remove only v3 schema to reproduce a populated pre-aggregation database.
	if _, err := r.db.Exec("DROP TABLE daily_usage;DROP TABLE aggregation_settings;PRAGMA user_version=2"); err != nil {
		t.Fatal(err)
	}
	r.reader.Close()
	r.db.Close()
	for range 2 {
		reopened, err := newRecorder(r.cfg, emptySource{})
		if err != nil {
			t.Fatal(err)
		}
		if scalar(t, reopened, "SELECT SUM(upload) FROM daily_usage") != 603*7 || scalar(t, reopened, "SELECT SUM(connections) FROM daily_usage") != 603 {
			t.Fatal("backfill repeated or missing")
		}
		if reopened.aggregationTimezone != "America/New_York" {
			t.Fatal("timezone changed")
		}
		reopened.cancel()
		reopened.geo.close()
		reopened.reader.Close()
		reopened.db.Close()
	}
	cfg := r.cfg
	cfg.AggregationTimezone = "UTC"
	if changed, err := newRecorder(cfg, emptySource{}); err == nil {
		changed.db.Close()
		changed.reader.Close()
		t.Fatal("silently changed aggregation timezone")
	}
	cfg.AggregationTimezone = ""
	reopened, err := newRecorder(cfg, emptySource{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	defer reopened.reader.Close()
	defer reopened.cancel()
	defer reopened.geo.close()
	if reopened.aggregationTimezone != "America/New_York" {
		t.Fatal("default did not preserve database timezone")
	}
}

func TestDailyMigrationRollsBackAndRetries(t *testing.T) {
	r := testRecorder(t)
	rec := testRecord(r, "backfill", 3, 4)
	if err := r.writeBatch(context.Background(), []Record{rec}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.db.Exec("DROP TABLE daily_usage;DROP TABLE aggregation_settings;PRAGMA user_version=2;PRAGMA foreign_keys=OFF;INSERT INTO samples(flow_id,at_ms,from_ms,upload,download,connections) VALUES(999999,1,1,1,1,1);PRAGMA foreign_keys=ON"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := initializeDaily(context.Background(), r.db, "UTC"); err == nil {
		t.Fatal("expected invalid legacy foreign key to abort backfill")
	}
	if scalar(t, r, "SELECT COUNT(*) FROM sqlite_master WHERE name='aggregation_settings'") != 0 {
		t.Fatal("failed backfill committed partial schema")
	}
	if _, err := r.db.Exec("DELETE FROM samples WHERE flow_id=999999"); err != nil {
		t.Fatal(err)
	}
	// A canceled migration must create neither settings nor aggregates.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := initializeDaily(ctx, r.db, "UTC"); err == nil {
		t.Fatal("ignored cancellation")
	}
	if scalar(t, r, "SELECT COUNT(*) FROM sqlite_master WHERE name='aggregation_settings'") != 0 {
		t.Fatal("partial migration schema")
	}
	if _, _, err := initializeDaily(context.Background(), r.db, "UTC"); err != nil {
		t.Fatal(err)
	}
	if scalar(t, r, "SELECT SUM(upload) FROM daily_usage") != 3 {
		t.Fatal("retry lost backfill")
	}
}

func TestDailyDSTBoundariesAndCalendarLimit(t *testing.T) {
	r := dailyRecorder(t, "America/New_York")
	loc := r.aggregationLocation
	for _, test := range []struct {
		date  string
		hours time.Duration
	}{{"2026-03-08", 23}, {"2026-11-01", 25}} {
		start, err := time.ParseInLocation("2006-01-02", test.date, loc)
		if err != nil {
			t.Fatal(err)
		}
		rec := testRecord(r, test.date, 5, 8)
		rec.Start = start.Add(time.Hour)
		rec.Observed = start.Add(2 * time.Hour)
		r.started = start
		if err = r.writeBatch(context.Background(), []Record{rec}); err != nil {
			t.Fatal(err)
		}
		q := dayQuery(r, start)
		result, err := r.Query(context.Background(), "series", 0, q)
		if err != nil {
			t.Fatal(err)
		}
		rows := result["data"].([]map[string]any)
		if len(rows) != 1 || rows[0]["time"] != start.UnixMilli() || rows[0]["endTime"] != start.AddDate(0, 0, 1).UnixMilli() || q.To-q.From != int64(test.hours)*int64(time.Hour/time.Millisecond) {
			t.Fatal(result)
		}
		q.From++
		if _, err = r.Query(context.Background(), "summary", 0, q); err == nil {
			t.Fatal("accepted partial day")
		}
	}
	q := dayQuery(r, time.Date(2026, 1, 1, 0, 0, 0, 0, loc))
	q.To = time.UnixMilli(q.From).In(loc).AddDate(0, 0, 366).UnixMilli()
	if _, err := r.Query(context.Background(), "summary", 0, q); err != nil {
		t.Fatal(err)
	}
	q.To = time.UnixMilli(q.From).In(loc).AddDate(0, 0, 367).UnixMilli()
	if _, err := r.Query(context.Background(), "summary", 0, q); err == nil {
		t.Fatal("accepted367 days")
	}
}

func TestLocalTimezoneSnapshotSurvivesChanges(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	data := snapshotLocalTimezone(loc)
	saved, err := time.LoadLocationFromTZData("saved", data)
	if err != nil {
		t.Fatal(err)
	}
	for _, at := range []time.Time{time.Date(2026, 1, 10, 1, 0, 0, 0, time.UTC), time.Date(2026, 7, 10, 1, 0, 0, 0, time.UTC), time.Date(2026, 11, 1, 6, 0, 0, 0, time.UTC)} {
		_, a := at.In(loc).Zone()
		_, b := at.In(saved).Zone()
		if a != b {
			t.Fatalf("offset %d != %d at %v", a, b, at)
		}
	}
}

func TestDailyStatusCoverageAfterClose(t *testing.T) {
	r := testRecorder(t)
	rec := testRecord(r, "one", 1, 2)
	if err := r.writeBatch(context.Background(), []Record{rec}); err != nil {
		t.Fatal(err)
	}
	before := r.Status()
	r.reader.Close()
	r.db.Close()
	after := r.Status()
	if before.AggregateAvailableFrom == nil || after.AggregateAvailableFrom == nil || *before.AggregateAvailableFrom != *after.AggregateAvailableFrom {
		t.Fatalf("coverage lost: %v %v", before, after)
	}
}

func TestDailyCoalescingKeepsDayAndDimensionBoundaries(t *testing.T) {
	r := dailyRecorder(t, "America/New_York")
	start := time.Date(2026, 3, 7, 0, 0, 0, 0, r.aggregationLocation)
	r.started = start
	first := testRecord(r, "long", 10, 20)
	first.Start = start.Add(time.Hour)
	first.Observed = start.Add(2 * time.Hour)
	second := first
	second.Observed = start.AddDate(0, 0, 1).Add(time.Hour)
	second.Upload = 30
	second.Download = 50
	other := testRecord(r, "short", 5, 7)
	other.Start = second.Observed
	other.Observed = second.Observed
	other.Metadata.Host = "different.example"
	batch := []Record{first, second, other}
	for range 2 {
		if err := r.writeBatch(context.Background(), batch); err != nil {
			t.Fatal(err)
		}
	}
	if scalar(t, r, "SELECT COUNT(*) FROM samples") != 3 || scalar(t, r, "SELECT COUNT(*) FROM daily_usage") != 3 {
		t.Fatal("coalescing removed raw samples or merged distinct days/dimensions")
	}
	if scalar(t, r, "SELECT SUM(upload) FROM daily_usage WHERE domain='example.com'") != 30 || scalar(t, r, "SELECT SUM(connections) FROM daily_usage WHERE domain='example.com'") != 1 {
		t.Fatal("flow crossing midnight counted twice")
	}
	if scalar(t, r, "SELECT SUM(upload) FROM daily_usage WHERE domain='different.example'") != 5 || scalar(t, r, "SELECT SUM(connections) FROM daily_usage") != 2 {
		t.Fatal("dimensions lost")
	}
}

func TestCalendarDaysWithSkippedOrRepeatedMidnight(t *testing.T) {
	for _, test := range []struct {
		zone, date string
		hours      int
	}{{"America/Sao_Paulo", "2018-11-04", 23}, {"America/Havana", "2026-11-01", 25}, {"America/Santiago", "2026-09-06", 23}} {
		t.Run(test.zone, func(t *testing.T) {
			r := dailyRecorder(t, test.zone)
			loc := r.aggregationLocation
			noon, err := time.ParseInLocation("2006-01-02 15:04", test.date+" 12:00", loc)
			if err != nil {
				t.Fatal(err)
			}
			start, end := calendarDayBounds(noon, loc)
			if end.Sub(start) != time.Duration(test.hours)*time.Hour {
				t.Fatalf("%v..%v length=%v", start, end, end.Sub(start))
			}
			if start.In(loc).Format("2006-01-02") != test.date || start.Add(-time.Nanosecond).In(loc).Format("2006-01-02") == test.date {
				t.Fatalf("not the first instant of %s: %v", test.date, start)
			}
			r.started = start
			rec := testRecord(r, "midnight-transition", 5, 7)
			rec.Start = start
			rec.Observed = noon
			if err = r.writeBatch(context.Background(), []Record{rec}); err != nil {
				t.Fatal(err)
			}
			q := DefaultQuery()
			q.Resolution = "day"
			q.Interval = 24 * time.Hour
			q.From = start.UnixMilli()
			q.To = end.UnixMilli()
			result, err := r.Query(context.Background(), "series", 0, q)
			if err != nil {
				t.Fatal(err)
			}
			rows := result["data"].([]map[string]any)
			if len(rows) != 1 || rows[0]["time"] != q.From || rows[0]["endTime"] != q.To || rows[0]["upload"] != int64(5) {
				t.Fatal(result)
			}
		})
	}
}
