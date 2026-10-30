package traffic_history

import (
	"net/netip"
	"strconv"
	"strings"

	C "github.com/metacubex/mihomo/constant"

	"github.com/oschwald/maxminddb-golang"
)

type Geo struct {
	Country      string `json:"country"`
	CountryName  string `json:"countryName,omitempty"`
	Continent    string `json:"continent,omitempty"`
	City         string `json:"city,omitempty"`
	ASN          string `json:"asn,omitempty"`
	Organization string `json:"organization,omitempty"`
}

// Only the writer accesses the readers/cache. In particular, none of these
// lookups can invoke the global geodata initializers, downloads or fatal logs.
type geoReader struct {
	country, city, asn *maxminddb.Reader
	cache              map[netip.Addr]Geo
	warnings           []string
}

func openGeo(cfg GeoConfig) *geoReader {
	g := &geoReader{cache: make(map[netip.Addr]Geo)}
	if !cfg.Enable {
		return g
	}
	if cfg.CountryPath == "" {
		cfg.CountryPath = C.Path.MMDB()
	}
	if cfg.ASNPath == "" {
		cfg.ASNPath = C.Path.ASN()
	}
	open := func(path string) *maxminddb.Reader {
		if path == "" {
			return nil
		}
		if err := C.ValidateMomoPath(path); err != nil {
			g.warnings = append(g.warnings, err.Error())
			return nil
		}
		r, err := maxminddb.Open(C.Path.Resolve(path))
		if err != nil {
			g.warnings = append(g.warnings, err.Error())
			return nil
		}
		return r
	}
	g.country, g.city, g.asn = open(cfg.CountryPath), open(cfg.CityPath), open(cfg.ASNPath)
	return g
}

func (g *geoReader) close() {
	for _, r := range []*maxminddb.Reader{g.country, g.city, g.asn} {
		if r != nil {
			_ = r.Close()
		}
	}
}

func validIP(ip netip.Addr) string {
	if !ip.IsValid() {
		return ""
	}
	return ip.Unmap().String()
}

func (g *geoReader) lookup(m *C.Metadata) Geo {
	ip := m.DstIP.Unmap()
	geo, found := g.cache[ip]
	if !found {
		geo = g.lookupIP(ip)
		// A bounded wholesale eviction avoids a second linked-list allocation per
		// cached IP. Connection records already retain the resolved historical geo.
		if len(g.cache) >= 8192 {
			clear(g.cache)
		}
		if ip.IsValid() {
			g.cache[ip] = geo
		}
	}
	// Existing rule metadata wins without changing the cached database result.
	for _, code := range m.DstGeoIP {
		if len(code) == 2 {
			country := strings.ToUpper(code)
			if country != geo.Country {
				geo.CountryName, geo.Continent, geo.City = "", "", ""
			}
			geo.Country = country
			break
		}
	}
	if m.DstIPASN != "" {
		asn, org, _ := strings.Cut(m.DstIPASN, " ")
		geo.ASN = strings.TrimPrefix(asn, "AS")
		if org != "" {
			geo.Organization = org
		}
	}
	return geo
}

func (g *geoReader) lookupIP(ip netip.Addr) Geo {
	geo := Geo{Country: "UNKNOWN"}
	if !ip.IsValid() {
		return geo
	}
	if ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsMulticast() || ip.IsUnspecified() {
		return Geo{Country: "LOCAL", CountryName: "Local Network"}
	}
	type place struct {
		Country struct {
			Code  string            `maxminddb:"iso_code"`
			Names map[string]string `maxminddb:"names"`
		} `maxminddb:"country"`
		Continent struct {
			Code string `maxminddb:"code"`
		} `maxminddb:"continent"`
		City struct {
			Names map[string]string `maxminddb:"names"`
		} `maxminddb:"city"`
	}
	for _, reader := range []*maxminddb.Reader{g.country, g.city} {
		if reader == nil {
			continue
		}
		switch reader.Metadata.DatabaseType {
		case "sing-geoip":
			var code string
			if reader.Lookup(ip.AsSlice(), &code) == nil && len(code) == 2 {
				geo.Country = strings.ToUpper(code)
			}
		case "Meta-geoip0":
			var codes any
			if reader.Lookup(ip.AsSlice(), &codes) == nil {
				switch v := codes.(type) {
				case string:
					if len(v) == 2 {
						geo.Country = strings.ToUpper(v)
					}
				case []any:
					for _, c := range v {
						if s, ok := c.(string); ok && len(s) == 2 {
							geo.Country = strings.ToUpper(s)
							break
						}
					}
				}
			}
		default:
			var p place
			if reader.Lookup(ip.AsSlice(), &p) == nil {
				if p.Country.Code != "" {
					geo.Country = strings.ToUpper(p.Country.Code)
				}
				if n := p.Country.Names["en"]; n != "" {
					geo.CountryName = n
				}
				if p.Continent.Code != "" {
					geo.Continent = p.Continent.Code
				}
				if n := p.City.Names["en"]; n != "" {
					geo.City = n
				}
			}
		}
	}
	if g.asn != nil {
		var a struct {
			Number uint32 `maxminddb:"autonomous_system_number"`
			Org    string `maxminddb:"autonomous_system_organization"`
			ASN    string `maxminddb:"asn"`
			Name   string `maxminddb:"name"`
		}
		if g.asn.Lookup(ip.AsSlice(), &a) == nil {
			if a.Number != 0 {
				geo.ASN = strconv.FormatUint(uint64(a.Number), 10)
			} else {
				geo.ASN = strings.TrimPrefix(a.ASN, "AS")
			}
			geo.Organization = a.Org
			if geo.Organization == "" {
				geo.Organization = a.Name
			}
		}
	}
	return geo
}
