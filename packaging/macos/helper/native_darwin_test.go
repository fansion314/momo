//go:build darwin && cgo

package main

import (
	"os"
	"strings"
	"testing"
)

// Disposable CI may create and disable this dedicated network service before
// invoking this test as root. Never touch the primary network service in tests.
func TestNativePACURLClear(t *testing.T) {
	const service = "Clash Momo CI PAC Test"
	if os.Getenv("MOMO_HELPER_TEST_NETWORK_SERVICE") != service || os.Geteuid() != 0 {
		t.Skip("requires explicitly provisioned disposable CI network service")
	}
	services, err := runNetworksetup("-listallnetworkservices")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, line := range strings.Split(services, "\n") {
		if strings.TrimSpace(line) == "*"+service {
			found = true
		}
	}
	if !found {
		t.Fatal("CI network service must exist and remain disabled")
	}
	for _, args := range [][]string{{"-setwebproxy", service, "127.0.0.1", "17891"}, {"-setwebproxystate", service, "off"}, {"-setautoproxyurl", service, "http://127.0.0.1:17892/proxy.pac"}, {"-setautoproxystate", service, "off"}} {
		if _, err = runNetworksetup(args...); err != nil {
			t.Fatal(err)
		}
	}
	before, err := runNetworksetup("-getwebproxy", service)
	if err != nil {
		t.Fatal(err)
	}
	if err = clearPACURL(service); err != nil {
		t.Fatal(err)
	}
	after, err := runNetworksetup("-getwebproxy", service)
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("native PAC clearing changed unrelated proxy values")
	}
	pac, err := runNetworksetup("-getautoproxyurl", service)
	if err != nil {
		t.Fatal(err)
	}
	f := fields(pac)
	if f["URL"] != "" && f["URL"] != "(null)" {
		t.Fatalf("PAC URL remains after native clear: %s", pac)
	}
	if f["Enabled"] != "No" {
		t.Fatal("native PAC clearing changed PAC enabled state")
	}
	for _, kind := range []string{"webproxy", "securewebproxy", "socksfirewallproxy"} {
		if _, err = runNetworksetup("-set"+kind, service, "127.0.0.1", "17893"); err != nil {
			t.Fatal(err)
		}
		if _, err = runNetworksetup("-set"+kind+"state", service, "off"); err != nil {
			t.Fatal(err)
		}
		pacBefore, err := runNetworksetup("-getautoproxyurl", service)
		if err != nil {
			t.Fatal(err)
		}
		if err = clearProxyAddress(service, kind); err != nil {
			t.Fatal(err)
		}
		value, err := runNetworksetup("-get"+kind, service)
		if err != nil {
			t.Fatal(err)
		}
		fields := fields(value)
		if fields["Server"] != "" && fields["Server"] != "(null)" {
			t.Fatalf("%s server was not cleared", kind)
		}
		if fields["Port"] != "0" || fields["Enabled"] != "No" {
			t.Fatalf("%s defaults or enabled flag differ after clearing: %s", kind, value)
		}
		pacAfter, err := runNetworksetup("-getautoproxyurl", service)
		if err != nil {
			t.Fatal(err)
		}
		if pacBefore != pacAfter {
			t.Fatal("manual address clearing changed unrelated PAC settings")
		}
	}
}
