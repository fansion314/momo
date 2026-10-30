package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

func launchctl(args ...string) error {
	cmd := exec.Command("/bin/launchctl", args...)
	cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin"}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl: %w: %s", err, out)
	}
	return nil
}

func install(uid int, core string) (err error) {
	if !filepath.IsAbs(core) {
		return errors.New("core must be an absolute administrator-approved path")
	}
	// Never create/chmod through a pre-existing symlink. Parent trees are checked first.
	for _, parent := range []string{"/Library/Application Support", "/Library/PrivilegedHelperTools", "/Library/LaunchDaemons"} {
		if _, e := os.Lstat(parent); errors.Is(e, os.ErrNotExist) {
			if e = os.Mkdir(parent, 0755); e != nil {
				return e
			}
		}
		if e := protectedAncestors(parent); e != nil {
			return e
		}
	}
	if err = mkdirProtected(stateRoot); err != nil {
		return err
	}
	if err = mkdirProtected(filepath.Join(stateRoot, "data")); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	stage, err := os.MkdirTemp(stateRoot, ".momo-install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err = copyExecutable(self, filepath.Join(stage, "helper")); err != nil {
		return err
	}
	if err = copyExecutable(core, filepath.Join(stage, "core")); err != nil {
		return err
	}
	cap, err := coreCapabilities(filepath.Join(stage, "core"))
	if err != nil {
		return err
	}
	i := installation{UID: uid, CoreVersion: cap.Version}
	if i.HelperHash, err = fileHash(filepath.Join(stage, "helper")); err != nil {
		return err
	}
	if i.CoreHash, err = fileHash(filepath.Join(stage, "core")); err != nil {
		return err
	}
	if err = writeJSON(filepath.Join(stage, "installation.json"), i); err != nil {
		return err
	}
	plist := []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>` + label + `</string>
<key>ProgramArguments</key><array><string>` + helperPath + `</string><string>serve</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ExitTimeOut</key><integer>25</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>`)
	if err = atomicWrite(filepath.Join(stage, "daemon.plist"), plist, 0644); err != nil {
		return err
	}
	// Stop the old daemon before replacement: its signal handler restores network state
	// and terminates its sole managed child. launchd waits up to ExitTimeOut.
	_ = launchctl("bootout", "system/"+label)
	type change struct {
		target, backup string
		existed        bool
	}
	changes := []change{}
	committed := false
	defer func() {
		if committed {
			return
		}
		_ = launchctl("bootout", "system/"+label)
		for n := len(changes) - 1; n >= 0; n-- {
			c := changes[n]
			_ = os.Remove(c.target)
			if c.existed {
				_ = os.Rename(c.backup, c.target)
			}
		}
		if _, e := os.Stat(plistPath); e == nil {
			_ = launchctl("bootstrap", "system", plistPath)
		}
	}()
	for n, pair := range [][2]string{{"helper", helperPath}, {"core", filepath.Join(stateRoot, "mihomomo")}, {"installation.json", filepath.Join(stateRoot, "installation.json")}, {"daemon.plist", plistPath}} {
		c := change{target: pair[1], backup: filepath.Join(stage, fmt.Sprintf("old-%d", n))}
		if info, e := os.Lstat(c.target); e == nil {
			if e = protectedInfo(c.target, info); e != nil {
				return e
			}
			if e = os.Rename(c.target, c.backup); e != nil {
				return e
			}
			c.existed = true
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		changes = append(changes, c)
		// stage and target may be on different mount points; use copy + same-dir rename.
		if pair[0] == "helper" || pair[0] == "core" {
			if err = copyExecutable(filepath.Join(stage, pair[0]), c.target); err != nil {
				return err
			}
			// Read-only status is also usable by the bound UID; the executable
			// remains root-owned and not writable by any other user.
			if pair[0] == "helper" {
				if err = os.Chmod(c.target, 0755); err != nil {
					return err
				}
			}
		} else {
			b, e := os.ReadFile(filepath.Join(stage, pair[0]))
			if e != nil {
				return e
			}
			mode := os.FileMode(0600)
			if pair[0] == "daemon.plist" {
				mode = 0644
			}
			if err = atomicWrite(c.target, b, mode); err != nil {
				return err
			}
		}
	}
	if err = launchctl("enable", "system/"+label); err != nil {
		return err
	}
	if err = launchctl("bootstrap", "system", plistPath); err != nil {
		return err
	}
	deadline := time.Now().Add(15 * time.Second)
	ready := false
	for time.Now().Before(deadline) {
		// Run the fixed read-only probe as the selected UID: readiness exercises
		// socket permissions, getpeereid and the actual installed HTTP handler.
		probe := exec.Command(helperPath, "status")
		probe.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin"}
		probe.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(uid)}}
		out, e := probe.Output()
		var status struct {
			Protocol   int    `json:"protocol"`
			HelperHash string `json:"helperHash"`
			CoreHash   string `json:"coreHash"`
			UID        int    `json:"uid"`
		}
		if e == nil && json.Unmarshal(out, &status) == nil && status.Protocol == 1 && status.HelperHash == i.HelperHash && status.CoreHash == i.CoreHash && status.UID == uid {
			ready = true
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !ready {
		return errors.New("installed helper did not pass its socket readiness probe")
	}
	committed = true
	return nil
}

func protectedAncestors(path string) error {
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		i, e := os.Lstat(p)
		if e != nil {
			return e
		}
		if e = protectedInfo(p, i); e != nil {
			return e
		}
		if !i.IsDir() {
			return fmt.Errorf("not a directory: %s", p)
		}
		if p == "/" {
			return nil
		}
	}
}

func uninstall() error {
	if err := protectedTree(stateRoot); err != nil {
		return err
	}
	_ = launchctl("bootout", "system/"+label)
	// A previous daemon crash may have left journaled settings or a live core.
	if err := recoverOwnedProcess(stateRoot); err != nil {
		return err
	}
	n := newNetwork(stateRoot, runNetworksetup)
	if err := n.restore(); err != nil {
		return err
	}
	for _, p := range []string{plistPath, helperPath, socketPath} {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil // User data, migration state, logs and protected core remain recoverable.
}
