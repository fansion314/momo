package traffic_history

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrInvalidQuery = errors.New("invalid traffic history query")
	ErrUnavailable  = errors.New("traffic history is not available")
	ErrBusy         = errors.New("traffic history query concurrency limit reached")
	ErrNotFound     = errors.New("traffic history record not found")
)

// SQL identifiers are exclusively selected from this registry, never user SQL.
var dimensions = map[string]string{
	"domain": "f.domain", "destinationIP": "f.destination_ip", "sourceIP": "f.source_ip",
	"process": "COALESCE(NULLIF(f.process_path,''),f.process)", "processPath": "f.process_path",
	"network": "f.network", "inbound": "f.inbound", "rule": "f.rule", "rulePayload": "f.rule_payload",
	"policy": "f.policy", "proxy": "f.proxy", "chain": "f.chains", "country": "f.country", "asn": "f.asn",
}

type Query struct {
	Resolution      string
	From, To        int64
	Limit           int
	Cursor          int64
	Interval        time.Duration
	GroupBy         []string
	Filters         map[string]string
	IncludeInternal bool
}

func DefaultQuery() Query {
	now := time.Now()
	return Query{From: now.Add(-24 * time.Hour).UnixMilli(), To: now.UnixMilli(), Limit: 100, Interval: time.Minute}
}

func (q Query) Validate() error {
	maxRange := int64(31 * 24 * time.Hour / time.Millisecond)
	if q.Resolution != "" && q.Resolution != "raw" && q.Resolution != "day" {
		return fmt.Errorf("resolution must be raw or day")
	}
	if q.Resolution == "day" {
		maxRange = int64(367 * 24 * time.Hour / time.Millisecond)
		if q.Interval != 24*time.Hour {
			return fmt.Errorf("day resolution requires interval=1d")
		}
	}
	if q.From < 0 || q.To <= q.From || q.To-q.From > maxRange {
		return fmt.Errorf("invalid time range (raw maximum31 days; day maximum366 calendar days)")
	}

	if q.Limit < 1 || q.Limit > 1000 || q.Cursor < 0 {
		return fmt.Errorf("limit must be 1..1000 and cursor nonnegative")
	}
	if q.Interval != time.Minute && q.Interval != time.Hour && q.Interval != 24*time.Hour {
		return fmt.Errorf("interval must be 1m, 1h or 1d")
	}
	if len(q.GroupBy) > 3 {
		return fmt.Errorf("at most three group_by dimensions are allowed")
	}
	seen := map[string]bool{}
	for _, key := range q.GroupBy {
		if _, ok := dimensions[key]; !ok || seen[key] {
			return fmt.Errorf("invalid or duplicate group_by dimension %q", key)
		}
		seen[key] = true
	}
	for key := range q.Filters {
		if _, ok := dimensions[key]; !ok {
			return fmt.Errorf("unknown filter %q", key)
		}
	}
	return nil
}

func (q Query) where(samples bool) (string, []any) {
	where := " WHERE "
	args := []any{q.From, q.To}
	if samples {
		where += "s.at_ms>=? AND s.at_ms<?"
	} else {
		where += "(f.state_at_ms>=? OR f.state='active') AND f.start_at_ms<?"
	}
	if !q.IncludeInternal {
		where += " AND f.accounted=1"
	}
	for key, value := range q.Filters {
		where += " AND " + dimensions[key] + "=?"
		args = append(args, value)
	}
	return where, args
}

const totals = `COALESCE(SUM(s.upload),0) AS upload,COALESCE(SUM(s.download),0) AS download,COALESCE(SUM(s.connections),0) AS connections,COUNT(DISTINCT f.id) AS participating_connections`

// Query only sees committed rows and never flushes the writer. The query pool,
// deadline and response limits also bound the lifetime of WAL read snapshots.
func (r *Recorder) Query(ctx context.Context, kind string, id int64, q Query) (map[string]any, error) {
	if err := q.Validate(); err != nil {
		return nil, err
	}
	if r.ctx.Err() != nil {
		return nil, ErrUnavailable
	}
	select {
	case <-r.done:
		return nil, ErrUnavailable
	default:
	}
	select {
	case r.queries <- struct{}{}:
		defer func() { <-r.queries }()
	default:
		return nil, ErrBusy
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	stop := context.AfterFunc(r.ctx, cancel)
	defer stop()
	where, args := q.where(true)
	var statement string
	single := false
	if q.Resolution == "day" {
		var err error
		statement, args, single, err = r.dailyQuery(kind, q)
		if err != nil {
			return nil, fmt.Errorf("%w: %s", ErrInvalidQuery, err)
		}
	} else {
		switch kind {
		case "summary":
			statement = "SELECT " + totals + " FROM samples s JOIN flows f ON f.id=s.flow_id" + where
			single = true
		case "series":
			interval := q.Interval.Milliseconds()
			statement = fmt.Sprintf("SELECT (s.at_ms/%d)*%d AS time,%s FROM samples s JOIN flows f ON f.id=s.flow_id", interval, interval, totals) + where + " GROUP BY time ORDER BY time LIMIT ?"
			args = append(args, q.Limit+1)
		case "groups":
			if len(q.GroupBy) == 0 {
				return nil, fmt.Errorf("group_by is required")
			}
			cols := make([]string, len(q.GroupBy))
			group := make([]string, len(cols))
			for i, key := range q.GroupBy {
				group[i] = dimensions[key]
				cols[i] = dimensions[key] + ` AS "` + key + `"`
			}
			statement = "SELECT " + strings.Join(cols, ",") + "," + totals + " FROM samples s JOIN flows f ON f.id=s.flow_id" + where + " GROUP BY " + strings.Join(group, ",") + " ORDER BY (SUM(s.upload)+SUM(s.download)) DESC," + strings.Join(group, ",") + " LIMIT ?"
			args = append(args, q.Limit+1)
		case "flows":
			where, args = q.where(false)
			statement = "SELECT f.* FROM flows f" + where + " AND f.id>? ORDER BY f.id LIMIT ?"
			args = append(args, q.Cursor, q.Limit+1)
		case "flow":
			statement = "SELECT f.* FROM flows f WHERE f.id=?"
			args = []any{id}
			single = true
		case "samples":
			// Resource existence is independent of sample range, pagination and
			// dimension filters: an existing flow can legitimately have no matches.
			var exists int
			if err := r.reader.QueryRowContext(ctx, "SELECT 1 FROM flows WHERE id=?", id).Scan(&exists); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return nil, ErrNotFound
				}
				return nil, err
			}
			statement = "SELECT s.* FROM samples s JOIN flows f ON f.id=s.flow_id" + where + " AND f.id=? AND s.id>? ORDER BY s.id LIMIT ?"
			args = append(args, id, q.Cursor, q.Limit+1)
		default:
			return nil, fmt.Errorf("unknown traffic history query")
		}
	}
	rows, err := r.reader.QueryContext(ctx, statement, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	data, err := readRows(rows)
	if err != nil {
		return nil, err
	}
	resolution := q.Resolution
	if resolution == "" {
		resolution = "raw"
	}
	result := map[string]any{"resolution": resolution, "aggregationTimezone": r.aggregationTimezone, "from": q.From, "to": q.To, "lastCommitAt": r.lastCommit.Load(), "data": data, "truncated": false}
	if single {
		if len(data) == 0 {
			return nil, ErrNotFound
		}
		result["data"] = data[0]
		return result, nil
	}
	if len(data) > q.Limit {
		data = data[:q.Limit]
		result["data"] = data
		result["truncated"] = true
		if kind == "flows" || kind == "samples" {
			result["nextCursor"] = data[len(data)-1]["id"]
		}
	}
	return result, nil
}

func readRows(rows *sql.Rows) ([]map[string]any, error) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0)
	values := make([]any, len(cols))
	dest := make([]any, len(cols))
	for i := range values {
		dest[i] = &values[i]
	}
	for rows.Next() {
		if err = rows.Scan(dest...); err != nil {
			return nil, err
		}
		item := make(map[string]any, len(cols))
		for i, col := range cols {
			value := values[i]
			switch col {
			case "metadata", "chains", "provider_chains", "geo", "chain":
				var raw []byte
				switch v := value.(type) {
				case string:
					raw = []byte(v)
				case []byte:
					raw = v
				}
				var decoded any
				if err = json.Unmarshal(raw, &decoded); err != nil {
					return nil, err
				}
				value = decoded
			case "accounted", "preexisting":
				if v, ok := value.(int64); ok {
					value = v != 0
				}
			}
			parts := strings.Split(col, "_")
			for i := 1; i < len(parts); i++ {
				if parts[i] != "" {
					parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
				}
			}
			item[strings.Join(parts, "")] = value
		}
		result = append(result, item)
	}
	return result, rows.Err()
}
