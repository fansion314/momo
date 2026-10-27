package traffic_history

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDatabaseURLs(t *testing.T) {
	for _, test := range []struct{ path, want string }{
		{"/tmp/traffic #1?.db", "file:///tmp/traffic%20%231%3F.db"},
		{"C:/Users/Example User/traffic #1?.db", "file:///C:/Users/Example%20User/traffic%20%231%3F.db"},
	} {
		u, err := databaseURL(test.path)
		if err != nil || u.String() != test.want {
			t.Fatalf("%q: got %s, %v; want %s", test.path, u.String(), err, test.want)
		}
	}
	if _, err := databaseURL("//server/share/history.db"); err == nil {
		t.Fatal("accepted network database path")
	}
}

// This test uses the host's actual filesystem and driver, including Windows
// drive paths on the release-platform CI matrix. Escaping must not change filenames.
func TestDatabaseInitializesOnNativePath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "space #history.db")
	db, reader, err := openDatabase(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	defer reader.Close()
	var version int
	if err := reader.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("version=%d err=%v", version, err)
	}
}

func TestSchemaV1MigrationPreservesIDsAndAccounting(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Path = filepath.Join(t.TempDir(), "history.db")
	cfg.GeoIP.Enable = false
	db, err := sql.Open("sqlite", cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	legacy := strings.ReplaceAll(schema, " PRIMARY KEY AUTOINCREMENT", " PRIMARY KEY")
	legacy = strings.ReplaceAll(legacy, " state_at_ms INTEGER NOT NULL, baseline_at_ms INTEGER NOT NULL,", "")
	legacy = strings.ReplaceAll(legacy, "CREATE INDEX flows_retention ON flows(state_at_ms, id) WHERE state!='active';", "")
	legacy = strings.ReplaceAll(legacy, "PRAGMA user_version=2;", "PRAGMA user_version=1;")
	if _, err = db.Exec(legacy); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO sessions(id,started_at_ms,state) VALUES('legacy',100,'stopped');
	 INSERT INTO flows(id,session_id,tracker_id,start_at_ms,last_at_ms,end_at_ms,state,accounted,
	 upload_total,download_total,baseline_upload,baseline_download,recorded_upload,recorded_download,
	 preexisting,metadata,chains,provider_chains,rule,rule_payload,domain,destination_ip,source_ip,process,process_path,network,inbound,policy,proxy,country,asn,geo)
	 VALUES(42,'legacy','legacy-tracker',100,300,300,'closed',1,15,25,10,20,5,5,
	 1,'{}','[]','[]','','','','','','','','tcp','','','','UNKNOWN','','{}');
	 INSERT INTO samples(id,flow_id,at_ms,from_ms,upload,download,connections) VALUES(99,42,300,200,5,5,0);`)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	r, err := newRecorder(cfg, emptySource{})
	if err != nil {
		t.Fatal(err)
	}
	defer r.cancel()
	defer r.db.Close()
	defer r.reader.Close()
	defer r.geo.close()
	for query, want := range map[string]int64{
		"PRAGMA user_version": schemaVersion,
		"SELECT id FROM flows WHERE tracker_id='legacy-tracker'": 42,
		"SELECT id FROM samples WHERE flow_id=42":                99,
		"SELECT recorded_upload FROM flows WHERE id=42":          5,
		"SELECT baseline_at_ms FROM flows WHERE id=42":           200,
		"SELECT state_at_ms FROM flows WHERE id=42":              300,
	} {
		if got := scalar(t, r, query); got != want {
			t.Fatalf("%s = %d want %d", query, got, want)
		}
	}
	if err = r.writeBatch(context.Background(), []Record{testRecord(r, "new", 1, 2)}); err != nil {
		t.Fatal(err)
	}
	if scalar(t, r, "SELECT MAX(id) FROM flows") <= 42 || scalar(t, r, "SELECT MAX(id) FROM samples") <= 99 {
		t.Fatal("migration reset the ID sequences")
	}
	if scalar(t, r, "PRAGMA foreign_keys") != 1 {
		t.Fatal("migration did not restore foreign key checks")
	}
}

func TestPreexistingBaselineCoverageIsExplicit(t *testing.T) {
	r := testRecorder(t)
	rec := testRecord(r, "preexisting-final", 100, 200)
	rec.Start = r.started.Add(-time.Hour)
	rec.Observed = r.started.Add(5 * time.Second)
	rec.Closed = true
	if err := r.writeBatch(context.Background(), []Record{rec}); err != nil {
		t.Fatal(err)
	}
	if got := scalar(t, r, "SELECT baseline_at_ms FROM flows"); got != rec.Observed.UnixMilli() {
		t.Fatalf("baseline at %d does not expose first-observation blind interval", got)
	}
	if scalar(t, r, "SELECT recorded_upload FROM flows") != 0 {
		t.Fatal("backfilled traffic preceding the first baseline")
	}
}
