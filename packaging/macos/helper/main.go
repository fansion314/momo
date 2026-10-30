package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const (
	label         = "world.fansionia.clash-momo.helper"
	helperVersion = "1"
	stateRoot     = "/Library/Application Support/world.fansionia.clash-momo"
	helperPath    = "/Library/PrivilegedHelperTools/" + label
	plistPath     = "/Library/LaunchDaemons/" + label + ".plist"
	socketDir     = "/Library/PrivilegedHelperTools/world.fansionia.clash-momo.ipc"
	socketPath    = socketDir + "/helper.sock"
)

type installation struct {
	UID         int    `json:"uid"`
	HelperHash  string `json:"helperHash"`
	CoreHash    string `json:"coreHash"`
	CoreVersion string `json:"coreVersion"`
}

type capabilities struct {
	Protocol    int    `json:"protocol"`
	Version     string `json:"version"`
	ManagedMode bool   `json:"managedMode"`
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 1 && args[0] == "version" {
		fmt.Println(helperVersion)
		return nil
	}
	if len(args) == 1 && args[0] == "status" {
		transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socketPath)
		}}
		client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
		resp, err := client.Get("http://helper/v1/status")
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return errors.New("helper status unavailable")
		}
		_, err = io.Copy(os.Stdout, io.LimitReader(resp.Body, 16<<10))
		return err
	}
	if os.Geteuid() != 0 {
		return errors.New("administrator authorization required")
	}
	if len(args) == 0 {
		return errors.New("expected install, serve, or uninstall")
	}
	switch args[0] {
	case "install":
		f := flag.NewFlagSet("install", flag.ContinueOnError)
		uid := f.Int("uid", -1, "authorized application UID")
		core := f.String("core", "", "administrator-approved core executable")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if *uid <= 0 || *core == "" || f.NArg() != 0 {
			return errors.New("install requires --uid and --core")
		}
		return install(*uid, *core)
	case "serve":
		if len(args) != 1 {
			return errors.New("serve takes no arguments")
		}
		return serve()
	case "uninstall":
		if len(args) != 1 {
			return errors.New("uninstall takes no arguments")
		}
		return uninstall()
	default:
		return errors.New("unknown command")
	}
}

func coreCapabilities(path string) (capabilities, error) {
	var c capabilities
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--momo-capabilities")
	cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=" + stateRoot}
	out, err := cmd.Output()
	if err != nil {
		return c, fmt.Errorf("core capabilities: %w", err)
	}
	if err = json.Unmarshal(out, &c); err != nil {
		return c, err
	}
	if c.Protocol != 1 || !c.ManagedMode || c.Version == "" {
		return c, errors.New("core does not support managed protocol 1 on this platform")
	}
	return c, nil
}

func loadInstallation() (installation, error) {
	var i installation
	b, err := os.ReadFile(filepath.Join(stateRoot, "installation.json"))
	if err == nil {
		err = json.Unmarshal(b, &i)
	}
	if err == nil && i.UID <= 0 {
		err = errors.New("invalid installed UID")
	}
	return i, err
}
