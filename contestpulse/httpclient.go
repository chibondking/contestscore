package main

import (
	"net"
	"net/http"
	"time"
)

// newIngestClient builds the HTTP client the relays and the heartbeat use.
// It differs from http.DefaultClient in the ways that matter for a
// long-running process posting to the server through a Cloudflare Tunnel:
//
//   - IdleConnTimeout is short (20s). A NAT on the shack's uplink, or the
//     tunnel itself, can silently drop an idle keep-alive connection after
//     a minute or two; recycling our own idle conns first means Go never
//     hands a caller a half-open "zombie" socket that then hangs "awaiting
//     headers" until the 5s deadline. That zombie-connection state is what
//     once wedged ContestPulse (every POST timing out) until it was
//     manually restarted.
//   - callers retry once, after CloseIdleConnections(), on a transport
//     error -- see relay.forward / heartbeat.send. One retry papers over a
//     single poisoned connection instantly; these packets are safe to
//     resend (the server dedupes QSOs by <ID>, a Score packet is a whole
//     snapshot, RadioInfo is last-write-wins, a heartbeat is idempotent).
func newIngestClient() *http.Client {
	t := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       20 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	return &http.Client{Timeout: 5 * time.Second, Transport: t}
}
