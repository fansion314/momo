package route

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/metacubex/mihomo/component/traffic_history"
	"github.com/metacubex/mihomo/tunnel/statistic"

	"github.com/metacubex/chi"
	"github.com/metacubex/chi/render"
	"github.com/metacubex/http"
)

func trafficHistoryRouter() http.Handler {
	r := chi.NewRouter()
	r.Get("/status", func(w http.ResponseWriter, r *http.Request) {
		render.JSON(w, r, statistic.DefaultManager.History().Status())
	})
	for path, kind := range map[string]string{"/flows": "flows", "/flows/{id}": "flow", "/flows/{id}/samples": "samples", "/summary": "summary", "/series": "series", "/groups": "groups"} {
		r.Get(path, trafficHistoryHandler(kind))
	}
	return r
}

func parseHistoryQuery(r *http.Request) (traffic_history.Query, error) {
	q := traffic_history.DefaultQuery()
	values := r.URL.Query()
	q.Filters = map[string]string{}
	for key, v := range values {
		if len(v) != 1 {
			return q, fmt.Errorf("query parameter %q must appear once", key)
		}
		raw := v[0]
		var err error
		switch key {
		case "resolution":
			q.Resolution = raw
		case "from":
			q.From, err = strconv.ParseInt(raw, 10, 64)
		case "to":
			q.To, err = strconv.ParseInt(raw, 10, 64)
		case "limit":
			q.Limit, err = strconv.Atoi(raw)
		case "cursor":
			q.Cursor, err = strconv.ParseInt(raw, 10, 64)
		case "interval":
			if raw == "1d" {
				q.Interval = 24 * time.Hour
			} else {
				q.Interval, err = time.ParseDuration(raw)
			}
		case "group_by":
			q.GroupBy = strings.Split(raw, ",")
		case "include_internal":
			q.IncludeInternal, err = strconv.ParseBool(raw)
		default:
			q.Filters[key] = raw
		}
		if err != nil {
			return q, fmt.Errorf("invalid %s: %w", key, err)
		}
	}
	if q.Resolution == "day" && !values.Has("interval") {
		q.Interval = 24 * time.Hour
	}
	return q, q.Validate()
}

func trafficHistoryHandler(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fail := func(status int, err error) { render.Status(r, status); render.JSON(w, r, newError(err.Error())) }
		q, err := parseHistoryQuery(r)
		if err != nil {
			fail(http.StatusBadRequest, err)
			return
		}
		var id int64
		if raw := chi.URLParam(r, "id"); raw != "" {
			id, err = strconv.ParseInt(raw, 10, 64)
			if err != nil || id < 1 {
				fail(http.StatusBadRequest, fmt.Errorf("invalid record id"))
				return
			}
		}
		if q.Resolution == "day" && kind != "summary" && kind != "series" && kind != "groups" {
			fail(http.StatusBadRequest, fmt.Errorf("day resolution supports summary, series and groups only"))
			return
		}
		if kind == "groups" && len(q.GroupBy) == 0 {
			fail(http.StatusBadRequest, fmt.Errorf("group_by is required"))
			return
		}
		recorder := statistic.DefaultManager.History().Recorder()
		if recorder == nil {
			fail(http.StatusServiceUnavailable, traffic_history.ErrUnavailable)
			return
		}
		result, err := recorder.Query(r.Context(), kind, id, q)
		if err != nil {
			status := http.StatusInternalServerError
			switch {
			case errors.Is(err, traffic_history.ErrInvalidQuery):
				status = http.StatusBadRequest
			case errors.Is(err, traffic_history.ErrUnavailable):
				status = http.StatusServiceUnavailable
			case errors.Is(err, traffic_history.ErrBusy):
				status = http.StatusTooManyRequests
			case errors.Is(err, traffic_history.ErrNotFound):
				status = http.StatusNotFound
			case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
				status = http.StatusRequestTimeout
			}
			fail(status, err)
			return
		}
		render.JSON(w, r, result)
	}
}
