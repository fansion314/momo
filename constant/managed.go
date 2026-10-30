package constant

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const MomoManagedRoot = "/Library/Application Support/world.fansionia.clash-momo"

var momoManagedRoot, momoManagedSocket string

func MomoManaged() bool         { return momoManagedRoot != "" }
func MomoManagedSocket() string { return momoManagedSocket }

// MomoAllowSystemTimeWrite keeps NTP offsets local to the managed process.
// A profile may choose its time server but cannot change the host wall clock.
func MomoAllowSystemTimeWrite(requested bool) bool { return requested && !MomoManaged() }

// EnableMomoManaged is deliberately unavailable to ordinary CLI sessions. The
// dedicated, signed helper owns this tree; clients must copy resources into it.
func EnableMomoManaged(root, socket string) error {
	if runtime.GOOS != "darwin" || os.Geteuid() != 0 {
		return fmt.Errorf("momo managed mode requires macOS and root")
	}
	root = filepath.Clean(root)
	if !filepath.IsAbs(root) || !managedSubpath(MomoManagedRoot, root) || root == MomoManagedRoot {
		return fmt.Errorf("momo managed directory must be beneath %s", MomoManagedRoot)
	}
	if socket == "" || !filepath.IsAbs(socket) || !managedSubpath(root, socket) || socket == root {
		return fmt.Errorf("momo managed control socket must be inside the work directory")
	}
	if err := validateManagedPath(root, root); err != nil {
		return err
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
		return fmt.Errorf("momo managed work directory must exist with mode 0700")
	}
	if err := validateManagedTree(root); err != nil {
		return err
	}
	momoManagedRoot, momoManagedSocket = root, filepath.Clean(socket)
	SetHomeDir(root)
	momoRestrictUmask()
	return os.Chdir(root)
}

func managedSubpath(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && (rel == "." || filepath.IsLocal(rel))
}

// ValidateMomoPath checks every existing component with Lstat, including the
// ancestors above the work tree. No unprivileged writer can swap components
// between this check and use. Nonexistent leaves are allowed for new resources.
func ValidateMomoPath(path string) error {
	if !MomoManaged() {
		return nil
	}
	return validateManagedPath(momoManagedRoot, Path.Resolve(path))
}

func validateManagedPath(root, path string) error {
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) || !managedSubpath(root, path) {
		return fmt.Errorf("momo managed path escapes work directory: %s", path)
	}
	current := string(filepath.Separator)
	for _, part := range strings.Split(strings.TrimPrefix(path, current), current) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := validateManagedInfo(current, info); err != nil {
			return err
		}
	}
	return nil
}

func validateManagedInfo(path string, info fs.FileInfo) error {
	if info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || !momoRootOwned(info) {
		return fmt.Errorf("momo managed path must be root-owned, protected and not a symlink: %s", path)
	}
	if info.Mode().IsRegular() && momoMultipleLinks(info) {
		return fmt.Errorf("momo managed files must not be hard linked: %s", path)
	}
	if !info.IsDir() && !info.Mode().IsRegular() && info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("momo managed path has unsupported file type: %s", path)
	}
	return nil
}

func validateManagedTree(root string) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		return validateManagedInfo(path, info)
	})
}

// ValidateMomoWorkTree covers fixed database, geo and model paths as well as
// configuration-directed resources before each initial load or reload.
func ValidateMomoWorkTree() error {
	if !MomoManaged() {
		return nil
	}
	if err := ValidateMomoPath(momoManagedRoot); err != nil {
		return err
	}
	return validateManagedTree(momoManagedRoot)
}
