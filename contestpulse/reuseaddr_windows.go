//go:build windows

package main

import "syscall"

// setReuseAddr lets another process bind the same UDP port ContestPulse is
// listening on, so both receive a copy of every broadcast instead of
// whichever one binds first exclusively locking the other out. This is
// exactly the situation on a networked N1MM setup: N1MM's own process also
// listens on its Contact/Score/Radio ports to sync with other stations on
// the network, on the very same machine ContestPulse runs on -- without
// this, N1MM fails to start with "Port In Use Error" once ContestPulse has
// already bound the port.
func setReuseAddr(_, _ string, c syscall.RawConn) error {
	var sockErr error
	if err := c.Control(func(fd uintptr) {
		sockErr = syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1)
	}); err != nil {
		return err
	}
	return sockErr
}
