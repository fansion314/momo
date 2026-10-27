package traffic_history

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestSampleQueryDistinguishesMissingFlowFromEmptyResults(t *testing.T) {
	r := testRecorder(t)
	rec := testRecord(r, "sample-query-contract", 10, 20)
	if err := r.writeBatch(context.Background(), []Record{rec}); err != nil {
		t.Fatal(err)
	}
	id := scalar(t, r, "SELECT id FROM flows")
	base := DefaultQuery()
	base.From = r.started.UnixMilli()
	base.To = rec.Observed.Add(time.Second).UnixMilli()

	if _, err := r.Query(context.Background(), "samples", id+1, base); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing flow: got %v, want ErrNotFound", err)
	}

	for _, test := range []struct {
		name   string
		change func(*Query)
	}{
		{"time range", func(q *Query) { q.From = rec.Observed.Add(time.Millisecond).UnixMilli() }},
		{"dimension filter", func(q *Query) { q.Filters = map[string]string{"domain": "unmatched.example"} }},
		{"pagination cursor", func(q *Query) { q.Cursor = scalar(t, r, "SELECT MAX(id) FROM samples") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			q := base
			test.change(&q)
			result, err := r.Query(context.Background(), "samples", id, q)
			if err != nil {
				t.Fatalf("existing flow with no matching samples: %v", err)
			}
			data, ok := result["data"].([]map[string]any)
			if !ok || len(data) != 0 || result["truncated"] != false {
				t.Fatalf("expected untruncated empty sample array, got %#v", result)
			}
		})
	}

	result, err := r.Query(context.Background(), "samples", id, base)
	if err != nil || len(result["data"].([]map[string]any)) != 1 {
		t.Fatalf("existing matching sample: result=%#v err=%v", result, err)
	}
}

func TestFlowJSONIPAndSmartMetadataCasing(t *testing.T) {
	r := testRecorder(t)
	rec := testRecord(r, "casing", 1, 2)
	rec.Metadata.SmartTarget = "example.com"
	rec.Metadata.SmartBlock = "node"
	if err := r.writeBatch(context.Background(), []Record{rec}); err != nil {
		t.Fatal(err)
	}
	result, err := r.Query(context.Background(), "flow", scalar(t, r, "SELECT id FROM flows"), DefaultQuery())
	if err != nil {
		t.Fatal(err)
	}
	data := result["data"].(map[string]any)
	if data["sourceIp"] != "192.168.1.2" || data["destinationIp"] != "1.1.1.1" {
		t.Fatal(data)
	}
	metadata := data["metadata"].(map[string]any)
	if metadata["smartTarget"] != "example.com" || metadata["smartBlock"] != "node" {
		t.Fatal(metadata)
	}
}
