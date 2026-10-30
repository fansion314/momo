package config

import "testing"

func TestHelperControllerPolicyClearsInheritedSecrets(t *testing.T) {
	for _, secret := range []string{"sealed-source-controller-secret", "ordinary-wrapper-controller-secret"} {
		raw := DefaultRawConfig()
		raw.Secret = secret
		raw.ExternalController = "0.0.0.0:9090"
		raw.ExternalControllerTLS = "0.0.0.0:9443"
		raw.ExternalControllerPipe = "arbitrary-pipe"
		raw.ExternalControllerUnix = "arbitrary-socket"
		raw.ExternalUI = "panel"
		raw.ExternalUIURL = "https://example.invalid/panel"
		raw.ExternalUIName = "private-panel"
		enforceHelperControllerPolicy(raw, "/private/protected/core.sock")
		if raw.Secret != "" || raw.ExternalController != "" || raw.ExternalControllerTLS != "" || raw.ExternalControllerPipe != "" || raw.ExternalUI != "" || raw.ExternalUIURL != "" || raw.ExternalUIName != "" {
			t.Fatal("helper core retained a remote controller or inherited bearer secret")
		}
		if raw.ExternalControllerUnix != "/private/protected/core.sock" {
			t.Fatal("helper Unix authorization boundary changed")
		}
	}
}

func TestOrdinaryControllerSecretRemainsConfigured(t *testing.T) {
	raw, err := UnmarshalRawConfig([]byte("secret: ordinary-local-controller-secret\n"))
	if err != nil {
		t.Fatal(err)
	}
	if raw.Secret != "ordinary-local-controller-secret" {
		t.Fatal("ordinary profile controller secret changed")
	}
}
