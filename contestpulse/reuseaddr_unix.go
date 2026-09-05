//go:build unix

package main

import "syscall"

// See reuseaddr_windows.go's header comment for why this exists -- same
// reasoning, split into a separate build-tagged file because the syscall's
// file descriptor type and constant set differ per OS (int vs.
// syscall.Handle), not because the behavior differs.
func setReuseAddr(_, _ string, c syscall.RawConn) error {
	var sockErr error
	if err := c.Control(func(fd uintptr) {
		sockErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1)
	}); err != nil {
		return err
	}
	return sockErr
}
