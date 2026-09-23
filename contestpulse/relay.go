package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// forwardQueueDepth bounds how many not-yet-forwarded packets a relay will
// buffer between its UDP read loop and its forwarder goroutine (see run()/
// forwarder() below). Deliberately small: this is a queue for smoothing
// over a slow-but-progressing forward, not a store for an actually-stuck
// one -- once it's full, the read loop starts dropping rather than
// blocking, which is the entire point of decoupling the two in the first
// place.
const forwardQueueDepth = 16

// udpReadBufferSize is big enough for any UDP datagram (max payload is
// 65,507 bytes), so a read can never come up short. That matters more on
// Windows than it looks: there, a datagram bigger than the buffer isn't
// silently truncated the way it is on Linux -- ReadFrom returns
// WSAEMSGSIZE as an error. With the old 8 KB buffer, one oversized Score
// packet (the largest thing N1MM sends, and it grows with every band/mode
// in the breakdown) was enough to trip that.
const udpReadBufferSize = 65536

// readErrorBackoff paces readLoop's retries after a read error that isn't
// the socket being closed, so a persistent one can't spin the CPU. A var,
// not a const, so a test can shrink it.
var readErrorBackoff = 100 * time.Millisecond

// relay listens on one local UDP port for N1MM broadcast traffic and
// forwards every datagram, byte for byte, to a contestscore ingest endpoint
// over HTTPS with a bearer token. It never inspects or understands the
// payload -- contestscore's own parsers (the same ones its UDP listeners
// use for a LAN install) do that server-side, so this stays correct even if
// N1MM's packet schema changes, and there's nothing here to keep in sync
// with contestscore's XML handling.
type relay struct {
	label     string // for log lines only, e.g. "radio"
	port      int
	targetURL string
	apiToken  string
	client    *http.Client

	// logPackets gates the RX/SENT packet logging in run() below. Only
	// meaningful when label == "contact" -- set directly by main.go from
	// config.LogContactPackets rather than a newRelay() parameter, so the
	// existing radio/score construction (and every test that doesn't care
	// about this) stays untouched; it defaults to false (Go's zero value),
	// same as "not logging" until something opts in.
	logPackets bool

	// packets decouples reading a UDP datagram from forwarding it over
	// HTTP -- see run()'s and forwarder()'s comments for why. Buffered
	// per forwardQueueDepth; run() never blocks writing to it.
	packets chan []byte

	mu   sync.Mutex
	conn net.PacketConn
}

func newRelay(label string, port int, targetURL, apiToken string) *relay {
	return &relay{
		label:     label,
		port:      port,
		targetURL: targetURL,
		apiToken:  apiToken,
		client:    newIngestClient(),
		packets:   make(chan []byte, forwardQueueDepth),
	}
}

// forward posts one datagram's bytes upstream. Split out from run() so a
// test can drive it directly against an httptest.Server, without a real UDP
// socket in the loop.
//
// A transport error (no HTTP response came back at all -- timeout, reset,
// connection refused) gets one retry after dropping idle connections, so a
// single half-open keep-alive socket heals itself instead of wedging every
// subsequent post. An actual HTTP response, even a 4xx/5xx, is not retried:
// the pipe works, the server just said no.
//
// Wrapped in watchDo (httpclient.go) so a call that runs unexpectedly long
// -- past what the client's own timeout budget should ever allow -- leaves
// a log line here instead of just silently not returning; see watchDo's
// own comment for the incident that motivated this.
func (r *relay) forward(packet []byte) error {
	return watchDo(fmt.Sprintf("%s :%d", r.label, r.port), func() error {
		err := r.postOnce(packet)
		var ue *url.Error
		if errors.As(err, &ue) {
			r.client.CloseIdleConnections()
			err = r.postOnce(packet)
		}
		return err
	})
}

func (r *relay) postOnce(packet []byte) error {
	req, err := http.NewRequest("POST", r.targetURL, bytes.NewReader(packet))
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Authorization", "Bearer "+r.apiToken)

	resp, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("posting to %s: %w", r.targetURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s rejected: HTTP %d", r.targetURL, resp.StatusCode)
	}
	return nil
}

// run listens until the socket is closed. Reading off the UDP socket and
// forwarding over HTTP happen in two separate goroutines (this one, and
// forwarder() below), connected by the bounded r.packets channel -- not
// synchronously in a single loop.
//
// That split exists because the synchronous version -- forward each packet
// inline, right here, before reading the next one -- has a sharp edge:
// this relay's own forward() already bounds one HTTP attempt to a few
// seconds (see httpclient.go), but the score relay has gone quiet on real
// deployments anyway, on more than one occasion, in a way that needed a
// manual restart of the whole process to clear. Whatever the exact cause,
// a synchronous loop means *any* stall in forward() -- a slow retry, a
// goroutine that doesn't return when it should -- stops this relay's
// ReadFrom from being called again too, which is indistinguishable from
// ContestPulse being dead for this port's traffic. Decoupling the two
// means a stuck forward can never again also mean a stuck reader: the read
// loop just keeps draining the OS socket into r.packets no matter how
// long a send is taking.
//
// The queue is intentionally small (forwardQueueDepth) and drops the
// *oldest* pending packet once full rather than blocking -- exactly like a
// lost UDP packet on a real LAN would be lost, which run()'s forwarding
// path was already documented to tolerate. For score/radio this is
// actively fine (Score is a full snapshot and RadioInfo is last-write-
// wins, so only the newest one queued matters); for contact it's a rare
// worst case (a backlog deep enough to fill 16 slots) rather than the
// default behavior.
func (r *relay) run() {
	// SO_REUSEADDR (via setReuseAddr, platform-specific -- see
	// reuseaddr_windows.go / reuseaddr_unix.go) so N1MM's own process can
	// still bind this same port for its networked multi-op sync, on the
	// same machine ContestPulse runs on. Without it, whichever of the two
	// starts first exclusively locks the port and the other fails to start.
	lc := net.ListenConfig{Control: setReuseAddr}
	conn, err := lc.ListenPacket(context.Background(), "udp4", fmt.Sprintf(":%d", r.port))
	if err != nil {
		log.Fatalf("[%s :%d] failed to listen: %v", r.label, r.port, err)
	}
	r.mu.Lock()
	r.conn = conn
	r.mu.Unlock()

	go r.forwarder()

	log.Printf("[%s :%d] relaying to %s", r.label, r.port, r.targetURL)
	r.readLoop(conn)
	conn.Close()
	close(r.packets) // lets forwarder() drain the rest and exit
}

// readLoop reads datagrams off conn and queues them for forwarder() until
// conn is closed. Split out from run() so a test can drive it with a fake
// PacketConn that returns errors on demand.
//
// Only a closed socket ends the loop. Any other read error is logged and
// the loop keeps reading: this used to break out on *every* error, which
// silently killed the relay for good -- no log line, and the heartbeat
// kept the dashboard showing the station as online the whole time. On
// Windows a single oversized datagram (see udpReadBufferSize) was enough
// to do it, and nothing short of restarting the process brought it back.
func (r *relay) readLoop(conn net.PacketConn) {
	buf := make([]byte, udpReadBufferSize)
	for {
		n, _, err := conn.ReadFrom(buf)
		if errors.Is(err, net.ErrClosed) {
			return // socket closed via stop()
		}
		if err != nil {
			log.Printf("[%s :%d] read error (continuing): %v", r.label, r.port, err)
			time.Sleep(readErrorBackoff)
			continue
		}
		packet := make([]byte, n) // copy before the next read reuses buf
		copy(packet, buf[:n])

		// contact only, not radio/score: those are frequent (radio on every
		// VFO tick, score on the RTC service's own interval) and printing
		// every one would drown out the log. Contact traffic is a few
		// packets per QSO -- worth seeing in full, e.g. to check whether
		// N1MM is actually broadcasting something for a given log entry
		// (a WAE QTC, say) at all, not just whether the forward succeeded.
		// logPackets (config.json's log_contact_packets) is the further,
		// user-facing on/off switch for this same contact-only logging.
		if r.label == "contact" && r.logPackets {
			log.Printf("[%s :%d] RX %d bytes: %s", r.label, r.port, n, packet)
		}

		r.enqueue(packet)
	}
}

// enqueue hands a packet to forwarder() without ever blocking the reader
// that calls it. A full queue means forwarding has fallen behind, not that
// the read loop should start waiting too -- so this drops the oldest
// queued packet to make room for the newest one instead. Best-effort: the
// two selects below aren't atomic together, so under concurrent pressure
// (which can't happen today -- run() is this channel's only writer -- but
// would if that ever changed) a slot could theoretically be taken by
// another goroutine between them; worst case is one extra retry of the
// same drop-and-insert, never a block.
func (r *relay) enqueue(packet []byte) {
	select {
	case r.packets <- packet:
		return
	default:
	}
	select {
	case <-r.packets:
	default:
	}
	select {
	case r.packets <- packet:
	default:
	}
}

// forwarder drains r.packets and forwards each one, one at a time --
// preserving arrival order the same way the old synchronous loop did.
// Run in its own goroutine by run(), and exits once r.packets is closed
// (after run()'s read loop returns) and drained.
func (r *relay) forwarder() {
	for packet := range r.packets {
		if err := r.forward(packet); err != nil {
			log.Printf("[%s :%d] %v", r.label, r.port, err)
		} else if r.label == "contact" && r.logPackets {
			log.Printf("[%s :%d] SENT ok", r.label, r.port)
		}
	}
}

// stop closes the listening socket, unblocking run()'s ReadFrom so it can
// return. Used by tests; a real deployment just runs until the process
// exits.
func (r *relay) stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conn != nil {
		r.conn.Close()
	}
}
