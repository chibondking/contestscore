package main

import (
	"bytes"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
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

	mu   sync.Mutex
	conn *net.UDPConn
}

func newRelay(label string, port int, targetURL, apiToken string) *relay {
	return &relay{
		label:     label,
		port:      port,
		targetURL: targetURL,
		apiToken:  apiToken,
		client:    &http.Client{Timeout: 5 * time.Second},
	}
}

// forward posts one datagram's bytes upstream. Split out from run() so a
// test can drive it directly against an httptest.Server, without a real UDP
// socket in the loop.
func (r *relay) forward(packet []byte) error {
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
	addr := &net.UDPAddr{Port: r.port, IP: net.IPv4zero}
	conn, err := net.ListenUDP("udp4", addr)
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
		n, _, err := conn.ReadFromUDP(buf)
		if err != nil {
			return // socket closed via stop(), or a real error -- either way, stop
		}
		packet := make([]byte, n) // copy before the next read reuses buf
		copy(packet, buf[:n])

		if err := r.forward(packet); err != nil {
			log.Printf("[%s :%d] %v", r.label, r.port, err)
		}
	}
}

// stop closes the listening socket, unblocking run()'s ReadFromUDP so it
// can return. Used by tests; a real deployment just runs until the process
// exits.
func (r *relay) stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conn != nil {
		r.conn.Close()
	}
}
