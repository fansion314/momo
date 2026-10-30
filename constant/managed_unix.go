//go:build darwin || linux || freebsd || openbsd || netbsd || dragonfly || android

package constant

import (
	"io/fs"
	"syscall"
)

func momoRestrictUmask() { syscall.Umask(0o077) }

func momoRootOwned(info fs.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == 0
}

func momoMultipleLinks(info fs.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return !ok || stat.Nlink > 1
}
