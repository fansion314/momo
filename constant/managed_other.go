//go:build !darwin && !linux && !freebsd && !openbsd && !netbsd && !dragonfly && !android

package constant

import "io/fs"

func momoRestrictUmask() {}

func momoRootOwned(info fs.FileInfo) bool     { return false }
func momoMultipleLinks(info fs.FileInfo) bool { return true }
