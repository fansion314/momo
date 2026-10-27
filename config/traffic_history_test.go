package config

import (
	"testing"
	"time"

	"github.com/metacubex/mihomo/common/yaml"
)

func TestTrafficHistoryDefaultsAndYAML(t *testing.T) {
	cfg := DefaultRawConfig()
	if cfg.TrafficHistory.Enable || cfg.TrafficHistory.SampleInterval != 30*time.Second || cfg.TrafficHistory.RetentionDays != 30 {
		t.Fatal(cfg.TrafficHistory)
	}
	if err := yaml.Unmarshal([]byte("traffic-history:\n  enable: true\n  sample-interval: 5s\n  geoip:\n    enable: false\n"), cfg); err != nil {
		t.Fatal(err)
	}
	if err := cfg.TrafficHistory.Validate(); err != nil {
		t.Fatal(err)
	}
	if cfg.TrafficHistory.SampleInterval != 5*time.Second || cfg.TrafficHistory.GeoIP.Enable {
		t.Fatal(cfg.TrafficHistory)
	}
	cfg.TrafficHistory.QueueSize = 0
	if cfg.TrafficHistory.Validate() == nil {
		t.Fatal("accepted zero queue")
	}
}
