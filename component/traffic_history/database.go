package traffic_history

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	C "github.com/metacubex/mihomo/constant"

	_ "modernc.org/sqlite"
)

const schemaVersion = 3

const flowSchema = `CREATE TABLE flows (
 id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
 tracker_id TEXT NOT NULL, start_at_ms INTEGER NOT NULL, last_at_ms INTEGER NOT NULL,
 end_at_ms INTEGER, state TEXT NOT NULL, accounted INTEGER NOT NULL,
 state_at_ms INTEGER NOT NULL, baseline_at_ms INTEGER NOT NULL,
 upload_total INTEGER NOT NULL, download_total INTEGER NOT NULL,
 baseline_upload INTEGER NOT NULL, baseline_download INTEGER NOT NULL,
 recorded_upload INTEGER NOT NULL DEFAULT 0, recorded_download INTEGER NOT NULL DEFAULT 0,
 preexisting INTEGER NOT NULL, metadata TEXT NOT NULL, chains TEXT NOT NULL,
 provider_chains TEXT NOT NULL, rule TEXT NOT NULL, rule_payload TEXT NOT NULL,
 domain TEXT NOT NULL, destination_ip TEXT NOT NULL, source_ip TEXT NOT NULL,
 process TEXT NOT NULL, process_path TEXT NOT NULL, network TEXT NOT NULL,
 inbound TEXT NOT NULL, policy TEXT NOT NULL, proxy TEXT NOT NULL,
 country TEXT NOT NULL, asn TEXT NOT NULL, geo TEXT NOT NULL,
 UNIQUE(session_id, tracker_id)
);`

const sampleSchema = `CREATE TABLE samples (
 id INTEGER PRIMARY KEY AUTOINCREMENT, flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
 at_ms INTEGER NOT NULL, from_ms INTEGER NOT NULL,
 upload INTEGER NOT NULL, download INTEGER NOT NULL, connections INTEGER NOT NULL
);`

const historyIndexes = `
CREATE INDEX samples_time ON samples(at_ms, flow_id);
CREATE INDEX samples_flow ON samples(flow_id, id);
CREATE INDEX flows_time ON flows(last_at_ms, id);
CREATE INDEX flows_state ON flows(session_id, state, id);
CREATE INDEX flows_retention ON flows(state_at_ms, id) WHERE state!='active';
`

const schema = `
CREATE TABLE sessions (
 id TEXT PRIMARY KEY, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
 state TEXT NOT NULL, dropped_records INTEGER NOT NULL DEFAULT 0,
 skipped_samples INTEGER NOT NULL DEFAULT 0, write_errors INTEGER NOT NULL DEFAULT 0
);
` + flowSchema + sampleSchema + historyIndexes + `
PRAGMA user_version=2;
`

func databaseURL(path string) (url.URL, error) {
	path = filepath.ToSlash(path)
	if strings.HasPrefix(path, "//") {
		return url.URL{}, fmt.Errorf("traffic-history: UNC and device paths are unsupported; WAL requires a local database path")
	}
	// file:///C:/... is a local Windows drive, whereas file://C:/... makes
	// the drive an authority that SQLite rejects. Keep URI escaping for ?/#.
	if len(path) >= 2 && path[1] == ':' {
		path = "/" + path
	}
	return url.URL{Scheme: "file", Path: path}, nil
}

func openDatabase(ctx context.Context, path string, timezone ...string) (*sql.DB, *sql.DB, error) {
	path, err := filepath.Abs(C.Path.Resolve(path))
	if err != nil {
		return nil, nil, err
	}
	u, err := databaseURL(path)
	if err != nil {
		return nil, nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, nil, err
	}
	// Precreate with private permissions; SQLite's WAL/SHM inherit the DB mode.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, nil, err
	}
	_ = f.Close()
	q := u.Query()
	q.Add("_pragma", "busy_timeout(1000)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "cache_size(-8192)")
	q.Add("_pragma", "synchronous(NORMAL)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, nil, err
	}
	db.SetMaxOpenConns(1)
	fail := func(err error) (*sql.DB, *sql.DB, error) { _ = db.Close(); return nil, nil, err }
	if _, err = db.ExecContext(ctx, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;"); err != nil {
		return fail(err)
	}
	var version int
	if err = db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return fail(err)
	}
	if version > schemaVersion {
		return fail(fmt.Errorf("traffic-history: unsupported schema version %d", version))
	}
	if version == 0 {
		// Refuse to adopt an unrelated SQLite file with user_version=0.
		var tables int
		if err = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").Scan(&tables); err != nil {
			return fail(err)
		}
		if tables != 0 {
			return fail(fmt.Errorf("traffic-history: database is not empty"))
		}
		tx, e := db.BeginTx(ctx, nil)
		if e != nil {
			return fail(e)
		}
		if _, e = tx.ExecContext(ctx, schema); e != nil {
			_ = tx.Rollback()
			return fail(e)
		}
		if e = tx.Commit(); e != nil {
			return fail(e)
		}
	}
	if version == 1 {
		if err = migrateV1(ctx, db); err != nil {
			return fail(err)
		}
	}
	requested := ""
	if len(timezone) > 0 {
		requested = timezone[0]
	}
	if _, _, err = initializeDaily(ctx, db, requested); err != nil {
		return fail(err)
	}
	q.Set("mode", "ro")
	q.Add("_pragma", "query_only(1)")
	u.RawQuery = q.Encode()
	reader, err := sql.Open("sqlite", u.String())
	if err != nil {
		return fail(err)
	}
	reader.SetMaxOpenConns(2)
	if err = reader.PingContext(ctx); err != nil {
		_ = reader.Close()
		return fail(err)
	}
	return db, reader, nil
}

// Rebuild the two ID tables transactionally to make cursors stable across
// retention. Preserve every existing ID and derive missing observation times.
func migrateV1(ctx context.Context, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "PRAGMA foreign_keys=OFF"); err != nil {
		return err
	}
	defer func() {
		restoreCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_, _ = conn.ExecContext(restoreCtx, "PRAGMA foreign_keys=ON")
	}()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	const oldColumns = `id,session_id,tracker_id,start_at_ms,last_at_ms,end_at_ms,state,accounted,upload_total,download_total,baseline_upload,baseline_download,recorded_upload,recorded_download,preexisting,metadata,chains,provider_chains,rule,rule_payload,domain,destination_ip,source_ip,process,process_path,network,inbound,policy,proxy,country,asn,geo`
	_, err = tx.ExecContext(ctx, `ALTER TABLE samples RENAME TO samples_v1; ALTER TABLE flows RENAME TO flows_v1;`+flowSchema+sampleSchema+
		`INSERT INTO flows(`+oldColumns+`,state_at_ms,baseline_at_ms) SELECT `+oldColumns+`,COALESCE(end_at_ms,last_at_ms),CASE WHEN preexisting THEN COALESCE((SELECT MIN(from_ms) FROM samples_v1 WHERE flow_id=flows_v1.id),last_at_ms) ELSE start_at_ms END FROM flows_v1;`+
		`INSERT INTO samples SELECT * FROM samples_v1; DROP TABLE samples_v1; DROP TABLE flows_v1;`+historyIndexes+`PRAGMA user_version=2;`)
	if err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	invalid := rows.Next()
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	if invalid {
		return fmt.Errorf("traffic-history: migration found invalid foreign keys")
	}
	return tx.Commit()
}

func (r *Recorder) writeBatch(ctx context.Context, batch []Record) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	lookup, err := tx.PrepareContext(ctx, `SELECT id,upload_total,download_total,last_at_ms,state FROM flows WHERE session_id=? AND tracker_id=?`)
	if err != nil {
		return err
	}
	defer lookup.Close()
	update, err := tx.PrepareContext(ctx, `UPDATE flows SET upload_total=?,download_total=?,last_at_ms=?,end_at_ms=?,state=?,state_at_ms=?,recorded_upload=recorded_upload+?,recorded_download=recorded_download+? WHERE id=?`)
	if err != nil {
		return err
	}
	defer update.Close()
	sample, err := tx.PrepareContext(ctx, `INSERT INTO samples(flow_id,at_ms,from_ms,upload,download,connections) VALUES(?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer sample.Close()
	aggregate, err := newDailyBatch(ctx, tx, r.aggregationLocation)
	if err != nil {
		return err
	}
	defer aggregate.close()
	for _, rec := range batch {
		var id, up, down, previous int64
		var state string
		err = lookup.QueryRowContext(ctx, r.session, rec.TrackerID).Scan(&id, &up, &down, &previous, &state)
		first := err == sql.ErrNoRows
		if err != nil && !first {
			return err
		}
		if state == "closed" {
			continue
		} // A stale Range result cannot resurrect a final record.
		at := rec.Observed.UnixMilli()
		connections := 0
		if first {
			previous = rec.Start.UnixMilli()
			preexisting := rec.Start.Before(r.started)
			if preexisting {
				up, down = rec.Upload, rec.Download
				previous = at
			} else {
				connections = 1
			}
			id, err = r.insertFlow(ctx, tx, rec, up, down, preexisting)
			if err != nil {
				return err
			}
		}
		if at < previous {
			at = previous
		}
		newUp, newDown := max(up, rec.Upload), max(down, rec.Download)
		deltaUp, deltaDown := newUp-up, newDown-down
		if !first && deltaUp == 0 && deltaDown == 0 && !rec.Closed {
			continue
		}
		state = "active"
		var end any
		if rec.Closed {
			state = "closed"
			end = at
		}
		if _, err = sample.ExecContext(ctx, id, at, min(previous, at), deltaUp, deltaDown, connections); err != nil {
			return err
		}
		if err = aggregate.add(ctx, id, at, deltaUp, deltaDown, connections); err != nil {
			return err
		}
		if _, err = update.ExecContext(ctx, newUp, newDown, at, end, state, at, deltaUp, deltaDown, id); err != nil {
			return err
		}
	}
	if err = aggregate.flush(ctx); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE sessions SET dropped_records=?,skipped_samples=?,write_errors=? WHERE id=?`, r.dropped.Load(), r.skipped.Load(), r.writeErrors.Load(), r.session); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Recorder) insertFlow(ctx context.Context, tx *sql.Tx, rec Record, up, down int64, preexisting bool) (int64, error) {
	metadata, err := json.Marshal(rec.Metadata)
	if err != nil {
		return 0, err
	}
	chains, err := json.Marshal(rec.Chains)
	if err != nil {
		return 0, err
	}
	providers, err := json.Marshal(rec.ProviderChains)
	if err != nil {
		return 0, err
	}
	m := rec.Metadata
	if m == nil {
		m = &C.Metadata{}
	}
	domain := m.Host
	if domain == "" {
		domain = m.SniffHost
	}
	inbound := m.InName
	if inbound == "" {
		inbound = m.Type.String()
	}
	proxy, policy := "", ""
	if len(rec.Chains) > 0 {
		proxy = rec.Chains[0]
		policy = rec.Chains[len(rec.Chains)-1]
	}
	geo := r.geo.lookup(m)
	geoJSON, err := json.Marshal(geo)
	if err != nil {
		return 0, err
	}
	baselineAt := rec.Start.UnixMilli()
	if preexisting {
		baselineAt = rec.Observed.UnixMilli()
	}
	args := []any{r.session, rec.TrackerID, rec.Start.UnixMilli(), rec.Observed.UnixMilli(), "active", rec.Accounted, rec.Observed.UnixMilli(), baselineAt,
		up, down, up, down, preexisting, string(metadata), string(chains), string(providers), rec.Rule, rec.RulePayload,
		domain, validIP(m.DstIP), validIP(m.SrcIP), m.Process, m.ProcessPath, m.NetWork.String(), inbound, policy, proxy, geo.Country, geo.ASN, string(geoJSON)}
	res, err := tx.ExecContext(ctx, `INSERT INTO flows(session_id,tracker_id,start_at_ms,last_at_ms,state,accounted,state_at_ms,baseline_at_ms,
	 upload_total,download_total,baseline_upload,baseline_download,preexisting,metadata,chains,provider_chains,rule,rule_payload,
	 domain,destination_ip,source_ip,process,process_path,network,inbound,policy,proxy,country,asn,geo)
	 VALUES(?`+strings.Repeat(",?", len(args)-1)+`)`, args...)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (r *Recorder) reconcile(ctx context.Context) error {
	var cursor int64
	for {
		rows, err := r.db.QueryContext(ctx, `SELECT id,tracker_id FROM flows WHERE session_id=? AND state='active' AND id>? ORDER BY id LIMIT 512`, r.session, cursor)
		if err != nil {
			return err
		}
		var absent []int64
		count := 0
		for rows.Next() {
			var tracker string
			if err = rows.Scan(&cursor, &tracker); err != nil {
				break
			}
			count++
			if !r.source.HistoryAlive(tracker) {
				absent = append(absent, cursor)
			}
		}
		if err == nil {
			err = rows.Err()
		}
		_ = rows.Close()
		if err != nil {
			return err
		}
		for _, id := range absent {
			if _, err = r.db.ExecContext(ctx, `UPDATE flows SET state='unconfirmed',state_at_ms=? WHERE id=? AND state='active'`, time.Now().UnixMilli(), id); err != nil {
				return err
			}
		}
		if count < 512 {
			return nil
		}
	}
}

func (r *Recorder) cleanup(ctx context.Context) error {
	for {
		done, err := r.cleanupStep(ctx)
		if err != nil || done {
			return err
		}
	}
}

// Each step makes progress on samples AND metadata, so a large sample backlog
// cannot starve terminal-flow cleanup. The worker interleaves steps with writes.
func (r *Recorder) cleanupStep(ctx context.Context) (bool, error) {
	if r.cfg.RetentionDays == 0 {
		return true, nil
	}
	cutoff := time.Now().Add(-time.Duration(r.cfg.RetentionDays) * 24 * time.Hour).UnixMilli()
	done := true
	for _, statement := range []string{
		`DELETE FROM samples WHERE id IN (SELECT id FROM samples WHERE at_ms<? LIMIT 1000)`,
		`DELETE FROM flows WHERE id IN (SELECT f.id FROM flows f WHERE f.state!='active' AND f.state_at_ms<? AND NOT EXISTS(SELECT 1 FROM samples s WHERE s.flow_id=f.id) LIMIT 1000)`,
		`DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE state!='active' AND COALESCE(ended_at_ms,started_at_ms)<? AND NOT EXISTS(SELECT 1 FROM flows WHERE session_id=sessions.id) LIMIT 1000)`,
	} {
		res, err := r.db.ExecContext(ctx, statement, cutoff)
		if err != nil {
			return false, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return false, err
		}
		if n == 1000 {
			done = false
		}
	}
	return done, nil
}
