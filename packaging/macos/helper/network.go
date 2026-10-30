package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"time"
)

type proxyRequest struct {
	Enabled bool     `json:"enabled"`
	Mode    string   `json:"mode"`
	Host    string   `json:"host"`
	Port    int      `json:"port"`
	URL     string   `json:"url"`
	Bypass  []string `json:"bypass"`
}
type dnsRequest struct {
	Enabled bool     `json:"enabled"`
	Servers []string `json:"servers"`
}
type networkValue struct {
	Enabled bool     `json:"enabled"`
	Host    string   `json:"host,omitempty"`
	Port    int      `json:"port,omitempty"`
	URL     string   `json:"url,omitempty"`
	List    []string `json:"list,omitempty"`
}
type networkEntry struct {
	Service string         `json:"service"`
	Kind    string         `json:"kind"`
	Before  networkValue   `json:"before"`
	Applied networkValue   `json:"applied"`
	Pending []networkValue `json:"pending,omitempty"`
}
type networkState struct {
	Entries []networkEntry `json:"entries"`
}
type networkManager struct {
	path         string
	run          func(...string) (string, error)
	state        networkState
	clearPAC     func(string) error
	clearAddress func(string, string) error
}

func runNetworksetup(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/sbin/networksetup", args...)
	cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=C", "LC_ALL=C"}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("networksetup %s: %w: %s", args[0], err, out)
	}
	return strings.TrimSpace(string(out)), nil
}
func newNetwork(root string, run func(...string) (string, error)) *networkManager {
	return &networkManager{path: filepath.Join(root, "network.json"), run: run, clearPAC: clearPACURL, clearAddress: clearProxyAddress}
}
func (n *networkManager) load() error {
	b, err := os.ReadFile(n.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(b, &n.state)
}
func (n *networkManager) save() error { return writeJSON(n.path, n.state) }
func (n *networkManager) services() ([]string, error) {
	out, err := n.run("-listallnetworkservices")
	if err != nil {
		return nil, err
	}
	lines := strings.Split(out, "\n")
	services := []string{}
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if i == 0 || line == "" || strings.HasPrefix(line, "*") {
			continue
		}
		services = append(services, line)
	}
	if len(services) == 0 {
		return nil, errors.New("no active network services")
	}
	return services, nil
}
func fields(out string) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(line, ": ")
		if ok {
			m[k] = v
		}
	}
	return m
}
func (n *networkManager) get(service, kind string) (networkValue, error) {
	var v networkValue
	out, err := n.run("-get"+kind, service)
	if err != nil {
		return v, err
	}
	f := fields(out)
	switch kind {
	case "webproxy", "securewebproxy", "socksfirewallproxy":
		if f["Authenticated Proxy Enabled"] == "1" {
			return v, errors.New("authenticated system proxies cannot be managed safely")
		}
		v.Enabled = f["Enabled"] == "Yes"
		v.Host = f["Server"]
		if v.Host == "(null)" {
			v.Host = ""
		}
		v.Port, _ = strconv.Atoi(f["Port"])
	case "autoproxyurl":
		v.Enabled = f["Enabled"] == "Yes"
		v.URL = f["URL"]
	case "proxyautodiscovery":
		v.Enabled = strings.Contains(out, "On") || strings.Contains(out, "Yes")
	case "dnsservers", "proxybypassdomains":
		if !strings.Contains(out, "There aren't any") && out != "" {
			v.List = strings.Split(out, "\n")
		}
	default:
		return v, errors.New("unsupported network setting")
	}
	return v, nil
}
func (n *networkManager) set(service, kind string, v networkValue) error {
	current, getErr := n.get(service, kind)
	if getErr != nil {
		return getErr
	}
	state := "off"
	if v.Enabled {
		state = "on"
	}
	var err error
	switch kind {
	case "webproxy", "securewebproxy", "socksfirewallproxy":
		if current.Host != v.Host || current.Port != v.Port {
			if v.Host == "" && v.Port == 0 {
				err = n.clearAddress(service, kind)
			} else {
				_, err = n.run("-set"+kind, service, v.Host, strconv.Itoa(v.Port))
			}
			if err != nil {
				return err
			}
		}
		_, err = n.run("-set"+kind+"state", service, state)
	case "autoproxyurl":
		if current.URL != v.URL {
			if v.URL == "" || v.URL == "(null)" {
				err = n.clearPAC(service)
			} else {
				_, err = n.run("-setautoproxyurl", service, v.URL)
			}
			if err != nil {
				return err
			}
		}
		_, err = n.run("-setautoproxystate", service, state)
	case "proxyautodiscovery":
		_, err = n.run("-setproxyautodiscovery", service, state)
	case "dnsservers", "proxybypassdomains":
		list := v.List
		if len(list) == 0 {
			list = []string{"Empty"}
		}
		_, err = n.run(append([]string{"-set" + kind, service}, list...)...)
	default:
		err = errors.New("unsupported network setting")
	}
	return err
}
func (n *networkManager) apply(service, kind string, value networkValue) error {
	if len(value.List) == 0 {
		value.List = nil
	}
	before, err := n.get(service, kind)
	if err != nil {
		return err
	}
	idx := -1
	for i, e := range n.state.Entries {
		if e.Service == service && e.Kind == kind {
			idx = i
			break
		}
	}
	// Do not silently take ownership over a setting changed by the user while active.
	if idx >= 0 && !reflect.DeepEqual(before, n.state.Entries[idx].Applied) {
		return errors.New("network setting changed outside Clash Momo; disable and retry")
	}
	if idx < 0 {
		n.state.Entries = append(n.state.Entries, networkEntry{Service: service, Kind: kind, Before: before, Applied: before})
		idx = len(n.state.Entries) - 1
	}
	n.state.Entries[idx].Pending = transitionValues(kind, before, value)
	// Journal before mutation, so crashes cannot lose the original values.
	if err = n.save(); err != nil {
		return err
	}
	if err = n.set(service, kind, value); err != nil {
		return err
	}
	n.state.Entries[idx].Applied = value
	n.state.Entries[idx].Pending = nil
	return n.save()
}

// networksetup has no transaction API. Persist all intermediate states BEFORE
// its first command, preserving the original Before and previously Applied state.
// Recovery recognizes only these exact values, including a failed second command.
func transitionValues(kind string, from, to networkValue) []networkValue {
	values := []networkValue{from, to}
	if kind == "webproxy" || kind == "securewebproxy" || kind == "socksfirewallproxy" || kind == "autoproxyurl" {
		v := to
		v.Enabled = from.Enabled
		values = append(values, v)
		v.Enabled = true
		values = append(values, v)
		v.Enabled = false
		values = append(values, v)
	}
	return values
}
func matchesEntry(current networkValue, e networkEntry) bool {
	if reflect.DeepEqual(current, e.Applied) {
		return true
	}
	for _, v := range e.Pending {
		if reflect.DeepEqual(current, v) {
			return true
		}
	}
	return false
}
func (n *networkManager) restoreKinds(dnsOnly *bool) error {
	if err := n.load(); err != nil {
		return err
	}
	remaining := []networkEntry{}
	errs := []error{}
	for idx, e := range n.state.Entries {
		isDNS := e.Kind == "dnsservers"
		if dnsOnly != nil && isDNS != *dnsOnly {
			remaining = append(remaining, e)
			continue
		}
		current, err := n.get(e.Service, e.Kind)
		if err != nil {
			remaining = append(remaining, e)
			errs = append(errs, err)
			continue
		}
		if matchesEntry(current, e) {
			e.Pending = append(e.Pending, transitionValues(e.Kind, current, e.Before)...)
			n.state.Entries[idx] = e
			if err = n.save(); err != nil {
				remaining = append(remaining, e)
				errs = append(errs, err)
				continue
			}
			if err = n.set(e.Service, e.Kind, e.Before); err != nil {
				remaining = append(remaining, e)
				errs = append(errs, err)
				continue
			}
			verified, e2 := n.get(e.Service, e.Kind)
			if e2 != nil || !reflect.DeepEqual(verified, e.Before) {
				remaining = append(remaining, e)
				if e2 == nil {
					e2 = errors.New("network settings restoration did not match saved values")
				}
				errs = append(errs, e2)
			}
		}
		// Otherwise another program owns the value now; preserve it and drop our claim.
	}
	n.state.Entries = remaining
	if err := n.save(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}
func (n *networkManager) restore() error { return n.restoreKinds(nil) }
func (n *networkManager) proxy(p proxyRequest) error {
	if !p.Enabled {
		only := false
		return n.restoreKinds(&only)
	}
	if p.Mode != "auto" && p.Mode != "manual" && p.Mode != "" {
		return errors.New("invalid proxy mode")
	}
	if p.Mode == "auto" {
		u, err := url.Parse(p.URL)
		if err != nil || u.Scheme != "http" || net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback() || u.User != nil || len(p.URL) > 2048 {
			return errors.New("PAC must use a loopback HTTP URL")
		}
	} else if p.Host != "127.0.0.1" && p.Host != "::1" && p.Host != "localhost" {
		return errors.New("proxy must use a loopback host")
	} else if p.Port < 1 || p.Port > 65535 {
		return errors.New("invalid proxy port")
	}
	if len(p.Bypass) > 256 {
		return errors.New("too many proxy bypass domains")
	}
	for _, v := range p.Bypass {
		if len(v) > 255 || strings.ContainsAny(v, "\r\n\x00") || strings.HasPrefix(v, "-") {
			return errors.New("invalid bypass domain")
		}
	}
	services, err := n.services()
	if err != nil {
		return err
	}
	for _, s := range services {
		for _, kind := range []string{"webproxy", "securewebproxy", "socksfirewallproxy", "autoproxyurl", "proxyautodiscovery", "proxybypassdomains"} {
			v, e := n.get(s, kind)
			if e != nil {
				only := false
				_ = n.restoreKinds(&only)
				return e
			}
			switch kind {
			case "webproxy", "securewebproxy", "socksfirewallproxy":
				v.Enabled = p.Mode != "auto"
				if v.Enabled {
					v.Host = p.Host
					v.Port = p.Port
				}
			case "autoproxyurl":
				v.Enabled = p.Mode == "auto"
				if v.Enabled {
					v.URL = p.URL
				}
			case "proxyautodiscovery":
				v.Enabled = false
			case "proxybypassdomains":
				v.List = p.Bypass
			}
			if e = n.apply(s, kind, v); e != nil {
				only := false
				_ = n.restoreKinds(&only)
				return e
			}
		}
	}
	return nil
}
func (n *networkManager) dns(d dnsRequest) error {
	if !d.Enabled {
		only := true
		return n.restoreKinds(&only)
	}
	if len(d.Servers) == 0 || len(d.Servers) > 8 {
		return errors.New("DNS requires one to eight IP addresses")
	}
	for _, server := range d.Servers {
		if net.ParseIP(server) == nil {
			return errors.New("invalid DNS IP")
		}
	}
	services, err := n.services()
	if err != nil {
		return err
	}
	for _, s := range services {
		if err = n.apply(s, "dnsservers", networkValue{List: d.Servers}); err != nil {
			only := true
			_ = n.restoreKinds(&only)
			return err
		}
	}
	return nil
}
func (n *networkManager) status() map[string]bool {
	status := map[string]bool{"proxy": false, "dns": false}
	for _, e := range n.state.Entries {
		if e.Kind == "dnsservers" {
			status["dns"] = true
		} else {
			status["proxy"] = true
		}
	}
	return status
}
