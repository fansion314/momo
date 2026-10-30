package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type snapshotFile struct {
	Path       string `json:"path"`
	Data       string `json:"data"`
	ImportOnly bool   `json:"importOnly,omitempty"`
}
type snapshot struct {
	Config       string         `json:"config"`
	Files        []snapshotFile `json:"files"`
	AgeSecretKey string         `json:"ageSecretKey,omitempty"`
}
type snapshotChange struct {
	target, backup string
	existed        bool
}
type snapshotTransaction struct {
	dir          string
	changes      []snapshotChange
	manifestPath string
	manifest     map[string]string
}

func (t *snapshotTransaction) finish(commit bool) error {
	var errs []error
	if commit && t.manifestPath != "" {
		if err := writeJSON(t.manifestPath, t.manifest); err != nil {
			return err
		}
	}
	if !commit {
		for i := len(t.changes) - 1; i >= 0; i-- {
			c := t.changes[i]
			if e := os.Remove(c.target); e != nil && !errors.Is(e, os.ErrNotExist) {
				errs = append(errs, e)
			}
			if c.existed {
				if e := os.Rename(c.backup, c.target); e != nil {
					errs = append(errs, e)
				}
			}
		}
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return os.RemoveAll(t.dir)
}

func (s *service) stageSnapshot(input snapshot) (*snapshotTransaction, error) {
	if len(input.Config) == 0 || len(input.Config) > 16<<20 || len(input.Files) > 20000 || len(input.AgeSecretKey) > 1<<20 {
		return nil, errors.New("snapshot exceeds limits")
	}
	if err := protectedTree(s.work); err != nil {
		return nil, err
	}
	tmp, err := os.MkdirTemp(s.root, ".momo-snapshot-")
	if err != nil {
		return nil, err
	}
	t := &snapshotTransaction{dir: tmp, manifestPath: filepath.Join(s.root, "imports.json"), manifest: map[string]string{}}
	if previous, e := os.ReadFile(t.manifestPath); e == nil {
		if e = json.Unmarshal(previous, &t.manifest); e != nil {
			_ = t.finish(false)
			return nil, errors.New("invalid import manifest")
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		_ = t.finish(false)
		return nil, e
	}
	seen := map[string]bool{}
	files := append([]snapshotFile{}, input.Files...)
	files = append(files, snapshotFile{Path: "config.yaml", Data: base64.StdEncoding.EncodeToString([]byte(input.Config))})
	var total int64
	for i, f := range files {
		if s.operationContext != nil {
			if err := s.operationContext.Err(); err != nil {
				_ = t.finish(false)
				return nil, err
			}
		}
		if i < len(input.Files) && !safeRelative(f.Path) {
			_ = t.finish(false)
			return nil, errors.New("invalid snapshot path")
		}
		if seen[f.Path] {
			_ = t.finish(false)
			return nil, errors.New("duplicate snapshot path")
		}
		seen[f.Path] = true
		target := filepath.Join(s.work, f.Path)
		if strings.HasSuffix(target, ".sock") {
			_ = t.finish(false)
			return nil, errors.New("socket paths cannot be imported")
		}
		info, e := os.Lstat(target)
		if e == nil && f.ImportOnly {
			continue
		}
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			_ = t.finish(false)
			return nil, e
		}
		if info != nil && !info.Mode().IsRegular() {
			_ = t.finish(false)
			return nil, errors.New("snapshot target is not a regular file")
		}
		data, e := base64.StdEncoding.DecodeString(f.Data)
		if e != nil {
			_ = t.finish(false)
			return nil, errors.New("invalid snapshot base64")
		}
		total += int64(len(data))
		if len(data) > 512<<20 || total > 576<<20 {
			_ = t.finish(false)
			return nil, errors.New("decoded snapshot exceeds limits")
		}
		if f.Path != "config.yaml" {
			hash := fmt.Sprintf("%x", sha256.Sum256(data))
			previous := t.manifest[f.Path]
			t.manifest[f.Path] = hash
			if info != nil && previous == hash {
				continue
			}
		}
		if e = os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			_ = t.finish(false)
			return nil, e
		}
		// Ancestors cannot be user-mutated, and preflight rejected existing symlinks.
		if e = protectedAncestors(filepath.Dir(target)); e != nil {
			_ = t.finish(false)
			return nil, e
		}
		change := snapshotChange{target: target, backup: filepath.Join(tmp, fmt.Sprintf("%d", i)), existed: info != nil}
		if change.existed {
			if e = os.Rename(target, change.backup); e != nil {
				_ = t.finish(false)
				return nil, e
			}
		}
		t.changes = append(t.changes, change)
		if e = atomicWrite(target, data, 0600); e != nil {
			_ = t.finish(false)
			return nil, e
		}
	}
	return t, nil
}

func (s *service) applySnapshot(input snapshot, start bool) (err error) {
	if start && s.cmd != nil {
		return errors.New("core already running")
	}
	if !start && s.cmd == nil {
		return errors.New("core is not running")
	}
	t, err := s.stageSnapshot(input)
	if err != nil {
		return err
	}
	commit := false
	defer func() {
		if e := t.finish(commit); e != nil {
			err = errors.Join(err, e)
		}
	}()
	parent := s.operationContext
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, filepath.Join(s.root, "mihomomo"), "--momo-managed", "-t", "-d", s.work, "-f", filepath.Join(s.work, "config.yaml"), "-ext-ctl-unix", filepath.Join(s.work, "core.sock"))
	cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=" + s.work}
	if input.AgeSecretKey != "" {
		cmd.Env = append(cmd.Env, "CLASH_AGE_SECRET_KEY="+input.AgeSecretKey)
	}
	// Core validation messages may contain profile credentials; return a fixed error.
	if e := cmd.Run(); e != nil {
		return errors.New("managed core rejected configuration snapshot")
	}
	if start {
		err = s.startCore(input.AgeSecretKey)
	} else if input.AgeSecretKey != s.ageKey {
		previousKey := s.ageKey
		if err = s.stopCore(); err == nil {
			err = s.startCore(input.AgeSecretKey)
		}
		if err != nil {
			if restoreErr := t.finish(false); restoreErr != nil {
				return errors.Join(err, restoreErr)
			}
			t.changes = nil
			if restartErr := s.startCore(previousKey); restartErr != nil {
				return errors.Join(err, restartErr)
			}
			return err
		}
	} else {
		body, _ := json.Marshal(map[string]string{"path": filepath.Join(s.work, "config.yaml")})
		req, _ := newCoreRequest(ctx, http.MethodPut, "/configs?force=true", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, e := s.coreClient.Do(req)
		if e != nil {
			err = e
		} else {
			defer resp.Body.Close()
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
			if resp.StatusCode >= 300 {
				err = errors.New("core rejected configuration reload")
			}
		}
	}
	if err != nil {
		return err
	}
	commit = true
	if err = atomicWrite(filepath.Join(s.root, "migrated"), []byte("1"), 0600); err != nil {
		return err
	}
	return nil
}

func (s *service) exportState() ([]snapshotFile, error) {
	if err := protectedTree(s.work); err != nil {
		return nil, err
	}
	files := []snapshotFile{}
	var total int64
	for _, name := range []string{"traffic-history.db", "traffic-history.db-wal", "traffic-history.db-shm", "cache.db", "cache.db-wal", "cache.db-shm"} {
		path := filepath.Join(s.work, name)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() {
			return nil, errors.New("invalid state file")
		}
		total += info.Size()
		if total > 512<<20 {
			return nil, errors.New("state export exceeds 512MiB")
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		files = append(files, snapshotFile{Path: name, Data: base64.StdEncoding.EncodeToString(b)})
	}
	return files, nil
}
