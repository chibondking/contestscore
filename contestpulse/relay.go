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
)

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
func (r *relay) forward(packet []byte) error {
	err := r.postOnce(packet)
	var ue *url.Error
	if errors.As(err, &ue) {
		r.client.CloseIdleConnections()
		err = r.postOnce(packet)
	}
	return err
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

// run listens until the socket is closed. Forwarding happens synchronously
// in the read loop, not in a spawned goroutine per packet: N1MM broadcasts
// are infrequent (at most a few per second even mid-pileup) and a POST
// normally completes in well under a second, so this keeps datagrams
// forwarded in the order they arrived without needing to reconstruct that
// ordering server-side. A forward failure (network blip, contestscore
// restarting) is logged and dropped -- exactly like a lost UDP packet would
// have been on a real LAN, not a reason to stop relaying the rest.
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
	defer conn.Close()

	log.Printf("[%s :%d] relaying to %s", r.label, r.port, r.targetURL)
	buf := make([]byte, 8192)
	for {
		n, _, err := conn.ReadFrom(buf)
		if err != nil {
			return // socket closed via stop(), or a real error -- either way, stop
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
