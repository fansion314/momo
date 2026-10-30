//go:build linux

package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"syscall"
)

func clearPACURL(string) error { return errors.New("native PAC restoration requires macOS") }
func clearProxyAddress(string, string) error {
	return errors.New("native proxy restoration requires macOS")
}

// Linux implementation exists for unprivileged protocol/lifecycle tests only.
func peerUID(conn *net.UnixConn) (int, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, err
	}
	var cred *syscall.Ucred
	var inner error
	if err = raw.Control(func(fd uintptr) {
		cred, inner = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return 0, err
	}
	if inner != nil {
		return 0, inner
	}
	return int(cred.Uid), nil
}
func processIdentity(pid int) (string, error) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", err
	}
	i := strings.LastIndex(string(b), ") ")
	if i < 0 {
		return "", fmt.Errorf("invalid process stat")
	}
	f := strings.Fields(string(b[i+2:]))
	if len(f) < 20 {
		return "", fmt.Errorf("invalid process stat")
	}
	exe, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return "", err
	}
	return f[19] + ":" + exe, nil
}
