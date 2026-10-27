// Package traffic_history records existing tracker counters outside the network I/O path.
package traffic_history

import (
	"fmt"
	"time"

	C "github.com/metacubex/mihomo/constant"
)

type GeoConfig struct {
	Enable      bool   `yaml:"enable" json:"enable"`
	CountryPath string `yaml:"country-path" json:"country-path"`
	CityPath    string `yaml:"city-path" json:"city-path"`
	ASNPath     string `yaml:"asn-path" json:"asn-path"`
}

type Config struct {
	AggregationTimezone string        `yaml:"aggregation-timezone" json:"aggregation-timezone"`
	Enable              bool          `yaml:"enable" json:"enable"`
	Path                string        `yaml:"path" json:"path"`
	SampleInterval      time.Duration `yaml:"sample-interval" json:"sample-interval"`
	FlushInterval       time.Duration `yaml:"flush-interval" json:"flush-interval"`
	BatchSize           int           `yaml:"batch-size" json:"batch-size"`
	QueueSize           int           `yaml:"queue-size" json:"queue-size"`
	MaxPendingBytes     int64         `yaml:"max-pending-bytes" json:"max-pending-bytes"`
	RetentionDays       int           `yaml:"retention-days" json:"retention-days"`
	ShutdownTimeout     time.Duration `yaml:"shutdown-timeout" json:"shutdown-timeout"`
	GeoIP               GeoConfig     `yaml:"geoip" json:"geoip"`
}

func DefaultConfig() Config {
	return Config{Path: "traffic-history.db", SampleInterval: 30 * time.Second,
		FlushInterval: time.Second, BatchSize: 512, QueueSize: 8192,
		MaxPendingBytes: 32 << 20, RetentionDays: 30, ShutdownTimeout: 5 * time.Second,
		GeoIP: GeoConfig{Enable: true}}
}

// Validate only examines configuration; it never creates files or opens databases.
func (c Config) Validate() error {
	if c.AggregationTimezone != "" {
		if _, err := time.LoadLocation(c.AggregationTimezone); err != nil {
			return fmt.Errorf("traffic-history: invalid aggregation timezone: %w", err)
		}
	}
	if c.SampleInterval < time.Second || c.FlushInterval < time.Millisecond || c.ShutdownTimeout < time.Millisecond {
		return fmt.Errorf("traffic-history: invalid interval or shutdown timeout")
	}
	if c.QueueSize < 1 || c.QueueSize > 1<<20 || c.BatchSize < 1 || c.BatchSize > c.QueueSize || c.MaxPendingBytes < 1024 || c.RetentionDays < 0 || c.RetentionDays > 36500 {
		return fmt.Errorf("traffic-history: invalid queue, batch, memory budget or retention")
	}
	if c.Path == "" {
		return fmt.Errorf("traffic-history: path must not be empty")
	}
	for _, p := range []string{c.Path, c.GeoIP.CountryPath, c.GeoIP.CityPath, c.GeoIP.ASNPath} {
		if p != "" && !C.Path.IsSafePath(p) {
			return C.Path.ErrNotSafePath(p)
		}
	}
	return nil
}
