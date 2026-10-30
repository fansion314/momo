package constant

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMomoManagedRequiresDarwinRoot(t *testing.T) {
	if runtime.GOOS == "darwin" && os.Geteuid() == 0 {
		t.Skip("requires an unprivileged or non-Darwin process")
	}
	if err := EnableMomoManaged(MomoManagedRoot+"/test", MomoManagedRoot+"/test/core.sock"); err == nil {
		t.Fatal("managed mode accepted an unsupported process")
	}
	if MomoManaged() {
		t.Fatal("failed activation changed process policy")
	}
}

func TestManagedSubpath(t *testing.T) {
	for _, test := range []struct {
		path    string
		allowed bool
	}{
		{"/protected/work", true}, {"/protected/work/config.yaml", true},
		{"/protected/work-new/config.yaml", false}, {"/protected/work/../outside", false},
		{"/etc/passwd", false},
	} {
		if got := managedSubpath("/protected/work", filepath.Clean(test.path)); got != test.allowed {
			t.Errorf("%s: allowed=%v, want %v", test.path, got, test.allowed)
		}
	}
}

func TestManagedNTPNeverWritesSystemClock(t *testing.T) {
	oldRoot := momoManagedRoot
	t.Cleanup(func() { momoManagedRoot = oldRoot })
	for _, managed := range []bool{false, true} {
		momoManagedRoot = ""
		if managed {
			momoManagedRoot = MomoManagedRoot + "/test"
		}
		for _, requested := range []bool{false, true} {
			if got := MomoAllowSystemTimeWrite(requested); got != (requested && !managed) {
				t.Errorf("managed=%v requested=%v: clock write allowed=%v", managed, requested, got)
			}
		}
	}
}

// These tests run in the root-owned Linux CI container. Using a protected home
// rather than /tmp also exercises the protection of all ancestor directories.
func managedTestRoot(t *testing.T) string {
	t.Helper()
	if os.Geteuid() != 0 || runtime.GOOS == "windows" {
		t.Skip("requires root in isolated CI")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(home, "momo-managed-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if err := validateManagedPath(root, root); err != nil {
		t.Skipf("home ancestors are not protected: %v", err)
	}
	return root
}

func TestManagedPathsRejectEscapeSymlinksAndWritableAncestors(t *testing.T) {
	root := managedTestRoot(t)
	if err := validateManagedPath(root, filepath.Join(root, "new", "config.yaml")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(root, "..", "outside"), root + "-other/config.yaml"} {
		if err := validateManagedPath(root, path); err == nil {
			t.Fatalf("accepted escape: %s", path)
		}
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	if err := validateManagedPath(root, filepath.Join(link, "new")); err == nil {
		t.Fatal("accepted a symlink ancestor")
	}
	if err := validateManagedTree(root); err == nil {
		t.Fatal("accepted a symlink in work tree")
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "writable")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o770); err != nil {
		t.Fatal(err)
	}
	if err := validateManagedPath(root, filepath.Join(dir, "new")); err == nil {
		t.Fatal("accepted group-writable ancestor")
	}
}

func TestManagedPathsRejectHardlinksAndNonRootFiles(t *testing.T) {
	root := managedTestRoot(t)
	file := filepath.Join(root, "data")
	if err := os.WriteFile(file, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(file, filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	if err := validateManagedPath(root, file); err == nil {
		t.Fatal("accepted hardlinked file")
	}
	if err := os.Remove(filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(file, 501, -1); err != nil {
		t.Fatal(err)
	}
	if err := validateManagedPath(root, file); err == nil {
		t.Fatal("accepted non-root file")
	}
}

func TestManagedSafetyCannotBeDisabledByLegacyPathOptions(t *testing.T) {
	root := managedTestRoot(t)
	oldRoot, oldSocket, oldPath := momoManagedRoot, momoManagedSocket, Path
	t.Cleanup(func() { momoManagedRoot, momoManagedSocket, Path = oldRoot, oldSocket, oldPath })
	momoManagedRoot = root
	Path = &path{homeDir: root, allowUnsafePath: true, safePaths: []string{"/"}}
	if Path.IsSafePath("/etc/passwd") {
		t.Fatal("legacy options bypassed managed mode")
	}
	if !Path.IsSafePath("config.yaml") {
		t.Fatal("rejected contained resource")
	}
	if err := ValidateMomoWorkTree(); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(root, "cache.db")); err != nil {
		t.Fatal(err)
	}
	if err := ValidateMomoWorkTree(); err == nil {
		t.Fatal("reload accepted a symlink database")
	}
	if Path.IsSafePath("cache.db") {
		t.Fatal("resource read accepted symlink after startup")
	}
}
