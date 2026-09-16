package main

import (
	"log"
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

// watchdogThreshold is comfortably above the worst case a healthy relay
// forward or heartbeat send should ever take: one attempt plus one retry,
// each bounded by the client's own 5s Timeout, so ~10s under normal
// operation (including the ordinary "server unreachable" case, which
// surfaces as a returned error well inside this window, not a hang). A var,
// not a const, so a test can shrink it instead of taking 15+ real seconds.
//
// This exists because of a live incident (2026-09-16, scoreboard.wt2p.us
// during CW-OPS): the score relay produced nothing for 11+ minutes while
// the contact relay and the heartbeat -- built from the exact same client
// code -- kept working the whole time, and nothing reached the server to
// leave a trace there either (an auth failure or a bad packet would have
// logged something server-side; this logged nothing at all, consistent
// with the request never leaving this process). Root cause was never
// confirmed -- by the time it was investigated the gap had already closed
// on its own, and net/http's Client.Timeout is documented to bound the
// whole round trip, so a genuine hang past it shouldn't be possible under
// normal operation. This watchdog doesn't fix a known bug; it exists so
// that if this happens again, ContestPulse's own log shows a relay stuck
// mid-request instead of just going quiet, which is what actually made the
// first incident hard to diagnose after the fact.
var watchdogThreshold = 15 * time.Second

// watchDo runs fn (a relay's forward or a heartbeat's send), logging once
// if it's still running past watchdogThreshold and again when it finally
// returns. The "still running" line is the point -- a call that never
// returns at all would never produce an after-the-fact log on its own, so
// this has to fire from a separate goroutine while fn is still in flight.
func watchDo(label string, fn func() error) error {
	start := time.Now()
	done := make(chan struct{})
	go func() {
		select {
		case <-done:
		case <-time.After(watchdogThreshold):
			log.Printf("[%s] still waiting on a request after %s -- may be stuck past the client's own timeout budget", label, watchdogThreshold)
		}
	}()

	err := fn()
	close(done)

	if elapsed := time.Since(start); elapsed > watchdogThreshold {
		log.Printf("[%s] request finally returned after %s (err=%v)", label, elapsed.Round(time.Second), err)
	}
	return err
}
