package traffic_history

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	_ "time/tzdata"
)

// Keep every analysis dimension together in one row; no lossy top-N rollup.
var dailyColumns = []string{"accounted", "chains", "provider_chains", "rule", "rule_payload", "domain", "destination_ip", "source_ip", "process", "process_path", "network", "inbound", "policy", "proxy", "country", "asn", "geo"}

func localAggregationTimezone() (string, []byte, error) {
	name := os.Getenv("TZ")
	if name != "" && name != "Local" {
		if _, err := time.LoadLocation(name); err == nil {
			return name, nil, nil
		}
	}
	name = time.Local.String()
	if name != "Local" {
		if _, err := time.LoadLocation(name); err == nil {
			return name, nil, nil
		}
	}
	// Save the actual system rules, so changing the OS timezone cannot regroup data.
	data, err := os.ReadFile("/etc/localtime")
	if err != nil {
		return "system-local", snapshotLocalTimezone(time.Local), nil
	}
	name = "system-local"
	if target, err := filepath.EvalSymlinks("/etc/localtime"); err == nil {
		if i := strings.Index(target, "zoneinfo/"); i >= 0 {
			name = target[i+len("zoneinfo/"):]
		}
	}
	return name, data, nil
}

func loadAggregationTimezone(ctx context.Context, db *sql.DB) (string, *time.Location, error) {
	var name string
	var data []byte
	if err := db.QueryRowContext(ctx, "SELECT timezone,tzdata FROM aggregation_settings WHERE id=1").Scan(&name, &data); err != nil {
		return "", nil, err
	}
	var loc *time.Location
	var err error
	if len(data) > 0 {
		loc, err = time.LoadLocationFromTZData(name, data)
	} else {
		loc, err = time.LoadLocation(name)
	}
	return name, loc, err
}

// Schema creation, timezone choice and raw backfill commit together. A failed
// migration can be retried, and a successful migration never backfills twice.
func initializeDaily(ctx context.Context, db *sql.DB, requested string) (string, *time.Location, error) {
	var exists int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='aggregation_settings'").Scan(&exists); err != nil {
		return "", nil, err
	}
	if exists != 0 {
		name, loc, err := loadAggregationTimezone(ctx, db)
		if err == nil && requested != "" && requested != name {
			err = fmt.Errorf("traffic-history: aggregation timezone is fixed at %q; requested %q requires a new database", name, requested)
		}
		return name, loc, err
	}
	name := requested
	var data []byte
	var err error
	if name == "" {
		name, data, err = localAggregationTimezone()
		if err != nil {
			return "", nil, err
		}
	}
	var loc *time.Location
	if len(data) > 0 {
		loc, err = time.LoadLocationFromTZData(name, data)
	} else {
		loc, err = time.LoadLocation(name)
	}
	if err != nil {
		return "", nil, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return "", nil, err
	}
	defer tx.Rollback()
	columns := make([]string, len(dailyColumns))
	for i, col := range dailyColumns {
		typ := "TEXT"
		if col == "accounted" {
			typ = "INTEGER"
		}
		columns[i] = col + " " + typ + " NOT NULL"
	}
	_, err = tx.ExecContext(ctx, `CREATE TABLE aggregation_settings(id INTEGER PRIMARY KEY CHECK(id=1),timezone TEXT NOT NULL,tzdata BLOB);
 CREATE TABLE daily_usage(day_start_ms INTEGER NOT NULL,day_end_ms INTEGER NOT NULL,dimension_key TEXT NOT NULL,`+strings.Join(columns, ",")+`,upload INTEGER NOT NULL,download INTEGER NOT NULL,connections INTEGER NOT NULL,PRIMARY KEY(day_start_ms,dimension_key));
 CREATE INDEX daily_usage_time ON daily_usage(day_start_ms);
 PRAGMA user_version=3;`)
	if err != nil {
		return "", nil, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO aggregation_settings VALUES(1,?,?)", name, data); err != nil {
		return "", nil, err
	}
	aggregate, err := newDailyBatch(ctx, tx, loc)
	if err != nil {
		return "", nil, err
	}
	defer aggregate.close()
	var cursor int64
	for {
		rows, e := tx.QueryContext(ctx, "SELECT id,flow_id,at_ms,upload,download,connections FROM samples WHERE id>? ORDER BY id LIMIT 512", cursor)
		if e != nil {
			return "", nil, e
		}
		type sample struct {
			id, flow, at, up, down int64
			connections            int
		}
		batch := make([]sample, 0, 512)
		for rows.Next() {
			var s sample
			if e = rows.Scan(&s.id, &s.flow, &s.at, &s.up, &s.down, &s.connections); e != nil {
				break
			}
			batch = append(batch, s)
		}
		if e == nil {
			e = rows.Err()
		}
		rows.Close()
		if e != nil {
			return "", nil, e
		}
		for _, s := range batch {
			if e = aggregate.add(ctx, s.flow, s.at, s.up, s.down, s.connections); e != nil {
				return "", nil, e
			}
			cursor = s.id
		}
		if e = aggregate.flush(ctx); e != nil {
			return "", nil, e
		}
		if len(batch) < 512 {
			break
		}
	}
	if err = tx.Commit(); err != nil {
		return "", nil, err
	}
	return name, loc, nil
}

type dailyDimension struct {
	key    string
	values []any
}
type dailyKey struct {
	start      int64
	dimensions string
}
type dailyTotal struct {
	end                           int64
	dimension                     dailyDimension
	upload, download, connections int64
}

// Coalesce only inside the existing raw transaction. No checkpoint is delayed
// or discarded, and accumulator state is discarded on both commit and rollback.
// The maps are bounded by the raw batch (512 by default), including migration.
type dailyBatch struct {
	location         *time.Location
	lookup, upsert   *sql.Stmt
	flows            map[int64]dailyDimension
	totals           map[dailyKey]*dailyTotal
	dayStart, dayEnd int64
}

func newDailyBatch(ctx context.Context, tx *sql.Tx, loc *time.Location) (*dailyBatch, error) {
	if loc == nil {
		return nil, fmt.Errorf("traffic-history: aggregation timezone unavailable")
	}
	lookup, err := tx.PrepareContext(ctx, "SELECT "+strings.Join(dailyColumns, ",")+" FROM flows WHERE id=?")
	if err != nil {
		return nil, err
	}
	columns := strings.Join(dailyColumns, ",")
	upsert, err := tx.PrepareContext(ctx, "INSERT INTO daily_usage(day_start_ms,day_end_ms,dimension_key,"+columns+",upload,download,connections) VALUES(?"+strings.Repeat(",?", len(dailyColumns)+5)+") ON CONFLICT(day_start_ms,dimension_key) DO UPDATE SET upload=upload+excluded.upload,download=download+excluded.download,connections=connections+excluded.connections")
	if err != nil {
		lookup.Close()
		return nil, err
	}
	return &dailyBatch{location: loc, lookup: lookup, upsert: upsert, flows: make(map[int64]dailyDimension), totals: make(map[dailyKey]*dailyTotal)}, nil
}
func (b *dailyBatch) close() { b.lookup.Close(); b.upsert.Close() }
func (b *dailyBatch) add(ctx context.Context, flow, at, up, down int64, connections int) error {
	dimension, ok := b.flows[flow]
	if !ok {
		values := make([]any, len(dailyColumns))
		dest := make([]any, len(values))
		for i := range values {
			dest[i] = &values[i]
		}
		if err := b.lookup.QueryRowContext(ctx, flow).Scan(dest...); err != nil {
			return err
		}
		key, err := json.Marshal(values)
		if err != nil {
			return err
		}
		dimension = dailyDimension{key: string(key), values: values}
		b.flows[flow] = dimension
	}
	if at < b.dayStart || at >= b.dayEnd {
		start, end := calendarDayBounds(time.UnixMilli(at), b.location)
		b.dayStart, b.dayEnd = start.UnixMilli(), end.UnixMilli()
	}
	key := dailyKey{start: b.dayStart, dimensions: dimension.key}
	total := b.totals[key]
	if total == nil {
		total = &dailyTotal{end: b.dayEnd, dimension: dimension}
		b.totals[key] = total
	}
	total.upload += up
	total.download += down
	total.connections += int64(connections)
	return nil
}
func (b *dailyBatch) flush(ctx context.Context) error {
	for key, total := range b.totals {
		args := make([]any, 0, len(dailyColumns)+6)
		args = append(args, key.start, total.end, key.dimensions)
		args = append(args, total.dimension.values...)
		args = append(args, total.upload, total.download, total.connections)
		if _, err := b.upsert.ExecContext(ctx, args...); err != nil {
			return err
		}
	}
	clear(b.totals)
	clear(b.flows)
	return nil
}

func (r *Recorder) availability() (*int64, *int64) {
	r.coverageMu.Lock()
	defer r.coverageMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	var detail, aggregate sql.NullInt64
	if err := r.reader.QueryRowContext(ctx, "SELECT MIN(at_ms) FROM samples").Scan(&detail); err == nil {
		r.detailAvailableFrom = nil
		if detail.Valid {
			v := detail.Int64
			r.detailAvailableFrom = &v
		}
	}
	if err := r.reader.QueryRowContext(ctx, "SELECT MIN(day_start_ms) FROM daily_usage").Scan(&aggregate); err == nil {
		r.aggregateAvailableFrom = nil
		if aggregate.Valid {
			v := aggregate.Int64
			r.aggregateAvailableFrom = &v
		}
	}
	return r.detailAvailableFrom, r.aggregateAvailableFrom
}

// Daily ranges must name complete saved-zone calendar days. No implicit floor,
// partial-day inclusion or 24h arithmetic that mislabels DST days.
func (r *Recorder) dailyQuery(kind string, q Query) (string, []any, bool, error) {
	loc := r.aggregationLocation
	if loc == nil {
		return "", nil, false, fmt.Errorf("aggregation timezone unavailable")
	}
	from, to := time.UnixMilli(q.From).In(loc), time.UnixMilli(q.To).In(loc)
	boundary := func(t time.Time) bool { start, _ := calendarDayBounds(t, loc); return t.Equal(start) }
	civil := func(t time.Time) time.Time { y, m, d := t.Date(); return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }
	if !boundary(from) || !boundary(to) || civil(to).Sub(civil(from)) > 366*24*time.Hour {
		return "", nil, false, fmt.Errorf("day ranges require complete timezone calendar-day boundaries and at most366 calendar days")
	}
	where := " WHERE f.day_start_ms>=? AND f.day_start_ms<?"
	args := []any{q.From, q.To}
	if !q.IncludeInternal {
		where += " AND f.accounted=1"
	}
	for key, value := range q.Filters {
		where += " AND " + dimensions[key] + "=?"
		args = append(args, value)
	}
	total := `COALESCE(SUM(f.upload),0) AS upload,COALESCE(SUM(f.download),0) AS download,COALESCE(SUM(f.connections),0) AS connections,NULL AS participating_connections`
	switch kind {
	case "summary":
		return "SELECT " + total + " FROM daily_usage f" + where, args, true, nil
	case "series":
		return "SELECT f.day_start_ms AS time,f.day_end_ms AS end_time," + total + " FROM daily_usage f" + where + " GROUP BY f.day_start_ms,f.day_end_ms ORDER BY time LIMIT ?", append(args, q.Limit+1), false, nil
	case "groups":
		if len(q.GroupBy) == 0 {
			return "", nil, false, fmt.Errorf("group_by is required")
		}
		cols := make([]string, len(q.GroupBy))
		groups := make([]string, len(cols))
		for i, key := range q.GroupBy {
			groups[i] = dimensions[key]
			cols[i] = dimensions[key] + ` AS "` + key + `"`
		}
		return "SELECT " + strings.Join(cols, ",") + "," + total + " FROM daily_usage f" + where + " GROUP BY " + strings.Join(groups, ",") + " ORDER BY (SUM(f.upload)+SUM(f.download)) DESC," + strings.Join(groups, ",") + " LIMIT ?", append(args, q.Limit+1), false, nil
	default:
		return "", nil, false, fmt.Errorf("day resolution supports summary, series and groups only")
	}
}

// Windows exposes the local zone through the native API instead of a TZif
// file. Persist its actual transition rules as TZif so reloads remain independent
// of the OS setting. This covers the application's practical 1800..2600 range.
func snapshotLocalTimezone(loc *time.Location) []byte {
	type zone struct {
		name   string
		offset int
	}
	zones := []zone{}
	indices := map[zone]byte{}
	zoneIndex := func(t time.Time) byte {
		name, offset := t.In(loc).Zone()
		z := zone{name, offset}
		if i, ok := indices[z]; ok {
			return i
		}
		i := byte(len(zones))
		indices[z] = i
		zones = append(zones, z)
		return i
	}
	start := time.Date(1800, 1, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2600, 1, 1, 0, 0, 0, 0, time.UTC)
	previous := zoneIndex(start)
	var times []int64
	var types []byte
	for next := start.Add(24 * time.Hour); next.Before(end); next = next.Add(24 * time.Hour) {
		current := zoneIndex(next)
		if current != previous {
			low, high := next.Add(-24*time.Hour).Unix(), next.Unix()
			for high-low > 1 {
				mid := (low + high) / 2
				if zoneIndex(time.Unix(mid, 0)) == previous {
					low = mid
				} else {
					high = mid
				}
			}
			times = append(times, high)
			types = append(types, current)
			previous = current
		}
	}
	var abbreviations []byte
	offsets := make([]byte, len(zones))
	for i, z := range zones {
		offsets[i] = byte(len(abbreviations))
		abbreviations = append(abbreviations, []byte(z.name)...)
		abbreviations = append(abbreviations, 0)
	}
	var out bytes.Buffer
	header := func(transitions, zoneCount, chars int) {
		out.WriteString("TZif2")
		out.Write(make([]byte, 15))
		for _, n := range []int{0, 0, 0, transitions, zoneCount, chars} {
			_ = binary.Write(&out, binary.BigEndian, int32(n))
		}
	}
	header(0, 1, 4)
	out.Write(make([]byte, 6))
	out.WriteString("UTC\x00")
	header(len(times), len(zones), len(abbreviations))
	for _, at := range times {
		_ = binary.Write(&out, binary.BigEndian, at)
	}
	out.Write(types)
	for i, z := range zones {
		_ = binary.Write(&out, binary.BigEndian, int32(z.offset))
		out.WriteByte(0)
		out.WriteByte(offsets[i])
	}
	out.Write(abbreviations)
	out.WriteString("\n\n")
	return out.Bytes()
}

// A calendar date can start at 01:00 when DST skips midnight. Midnight can
// also repeat. Verify Date's candidate is the first instant of the date;
// otherwise locate the boundary instead of silently picking an offset.
func calendarBoundary(year int, month time.Month, day int, loc *time.Location) time.Time {
	normalized := time.Date(year, month, day, 12, 0, 0, 0, time.UTC)
	year, month, day = normalized.Date()
	dateKey := func(t time.Time) int { y, m, d := t.In(loc).Date(); return y*372 + int(m)*31 + d }
	target := year*372 + int(month)*31 + day
	candidate := time.Date(year, month, day, 0, 0, 0, 0, loc)
	if dateKey(candidate) == target && dateKey(candidate.Add(-time.Nanosecond)) < target {
		return candidate
	}
	low, high := candidate.Add(-48*time.Hour).Unix(), candidate.Add(48*time.Hour).Unix()
	for high-low > 1 {
		mid := low + (high-low)/2
		if dateKey(time.Unix(mid, 0)) < target {
			low = mid
		} else {
			high = mid
		}
	}
	return time.Unix(high, 0).In(loc)
}
func calendarDayBounds(at time.Time, loc *time.Location) (time.Time, time.Time) {
	y, m, d := at.In(loc).Date()
	return calendarBoundary(y, m, d, loc), calendarBoundary(y, m, d+1, loc)
}
