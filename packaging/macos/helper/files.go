package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// protectedTree checks every ancestor and every existing descendant before root I/O.
// A root-owned directory with no group/other writers cannot be raced by the client.
func protectedTree(path string) error {
	path = filepath.Clean(path)
	for p := path; ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if err = protectedInfo(p, info); err != nil {
			return err
		}
		if !info.IsDir() {
			return fmt.Errorf("not a directory: %s", p)
		}
		if p == "/" {
			break
		}
	}
	return filepath.Walk(path, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		return protectedInfo(p, info)
	})
}

func protectedInfo(path string, info os.FileInfo) error {
	s, ok := info.Sys().(*syscall.Stat_t)
	if !ok || s.Uid != 0 || info.Mode()&0022 != 0 || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("unsafe ownership or permissions: %s", path)
	}
	if info.Mode().IsRegular() && s.Nlink != 1 {
		return fmt.Errorf("hard-linked file: %s", path)
	}
	if !info.IsDir() && !info.Mode().IsRegular() && info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("unsupported file: %s", path)
	}
	return nil
}

func mkdirProtected(path string) error {
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		if err = os.Mkdir(path, 0700); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	return protectedTree(path)
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".momo-write-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	defer f.Close()
	if err = f.Chmod(mode); err != nil {
		return err
	}
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func writeJSON(path string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return atomicWrite(path, b, 0600)
}

func fileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func copyExecutable(source, target string) error {
	f, err := os.Open(source)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 512<<20 {
		return errors.New("invalid executable")
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".momo-executable-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if err = tmp.Chmod(0700); err != nil {
		return err
	}
	if _, err = io.Copy(tmp, io.LimitReader(f, (512<<20)+1)); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), target)
}

func safeRelative(path string) bool {
	if path == "" || filepath.IsAbs(path) || strings.ContainsAny(path, "\\\x00") {
		return false
	}
	if filepath.Clean(path) != path || path == "." || strings.HasPrefix(path, "../") {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if strings.HasPrefix(part, ".momo-") || part == "core.sock" || part == "config.yaml" || part == "core.log" {
			return false
		}
	}
	return true
}
