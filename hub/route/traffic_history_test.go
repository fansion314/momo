package route

import (
	"testing"
	"time"

	"github.com/metacubex/http"
)

type historyResponse struct {
	header http.Header
	status int
	body   []byte
}

func (w *historyResponse) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}
func (w *historyResponse) WriteHeader(status int) { w.status = status }
func (w *historyResponse) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	w.body = append(w.body, data...)
	return len(data), nil
}

func TestTrafficHistoryAuthenticationAndDisabled(t *testing.T) {
	handler := router(false, "history-secret", "", Cors{})
	for _, test := range []struct {
		path, token string
		want        int
	}{
		{"/traffic-history/status", "", 401}, {"/traffic-history/status", "history-secret", 200},
		{"/traffic-history/summary", "history-secret", 503},
		{"/traffic-history/summary?from=bad", "history-secret", 400},
		{"/traffic-history/groups?group_by=bad", "history-secret", 400},
		{"/traffic-history/flows/-1", "history-secret", 400},
		{"/traffic-history/flows?resolution=day", "history-secret", 400},
		{"/traffic-history/summary?resolution=week", "history-secret", 400},
		{"/traffic-history/summary?resolution=day&interval=1h", "history-secret", 400},
	} {
		req, err := http.NewRequest("GET", "http://localhost"+test.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if test.token != "" {
			req.Header.Set("Authorization", "Bearer "+test.token)
		}
		res := &historyResponse{}
		handler.ServeHTTP(res, req)
		if res.status != test.want {
			t.Fatalf("%s: status=%d want=%d body=%s", test.path, res.status, test.want, res.body)
		}
	}
}

func TestTrafficHistoryQueryValidation(t *testing.T) {
	for _, params := range []string{"limit=1001", "cursor=-1", "from=1&to=1", "interval=3s", "domain=a&domain=b", "group_by=rule,rule", "group_by=domain,proxy,country,asn", "unknown=sql", "include_internal=invalid"} {
		req, _ := http.NewRequest("GET", "http://localhost/traffic-history/flows?"+params, nil)
		if _, err := parseHistoryQuery(req); err == nil {
			t.Fatalf("accepted %q", params)
		}
	}
	req, _ := http.NewRequest("GET", "http://localhost/traffic-history/groups?group_by=policy,chain&sourceIP=192.168.1.2&interval=1d", nil)
	if _, err := parseHistoryQuery(req); err != nil {
		t.Fatal(err)
	}
}

func TestDailyQueryDefaultsCalendarInterval(t *testing.T) {
	req, _ := http.NewRequest("GET", "http://localhost/traffic-history/summary?resolution=day", nil)
	q, err := parseHistoryQuery(req)
	if err != nil || q.Resolution != "day" || q.Interval != 24*time.Hour {
		t.Fatalf("%+v %v", q, err)
	}
}
