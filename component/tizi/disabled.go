//go:build !tizi

package tizi

import (
	"errors"
	"strings"
)

func runCommand(_ string, command string, _ map[string]any) (any, error) {
	if command == "status" {
		return map[string]any{"supported": false, "keyReady": false, "logged_in": false}, nil
	}
	return nil, errors.New("This core was built without tizi support")
}
func ExpandConfig(buf []byte) ([]byte, string, error) {
	if strings.Contains(string(buf), "tizi-managed:") {
		return nil, "", errors.New("This core was built without tizi support")
	}
	return buf, "", nil
}
func Configure(_ string, _ map[string]bool) error { return nil }
func Close()                                      {}
func Active() bool                                { return false }

type Meter struct{}

func Capture(_ []string, _ bool) *Meter { return nil }
func (*Meter) Add(_, _ int64)           {}

func (*Meter) BindClose(_ func()) func() { return nil }
