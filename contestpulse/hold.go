package main

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// Holding QSOs while the server is unreachable (contact relay only).
//
// A server restart (a deploy, a VPS reboot) used to cost QSOs: a forward
// that failed was logged and dropped, and through Cloudflare a down origin
// answers 502 -- an HTTP error, which wasn't retried at all. N1MM never
// re-sends an old broadcast, so a QSO logged during the blip was simply
// missing from the dashboard. The contact relay now holds every packet in
// memory, in order, and keeps retrying the oldest one until the server
// takes it; the backlog then drains in arrival order (an edit or delete
// can't overtake the QSO it applies to).
//
// Resending is safe: the server upserts QSOs by N1MM's own <ID>, so a
// packet that did arrive but whose response was lost isn't double-counted.
//
// Radio and score relays don't hold: each packet is a full snapshot that
// the next broadcast (seconds later) replaces, so replaying stale ones
// would only add noise.
//
// Memory only, by design: a ContestPulse restart loses what's held. The
// cap (maxHeldPackets) keeps a very long outage from growing without
// bound; past it the oldest is dropped, loudly.

// maxHeldPackets: ~10,000 QSOs' worth of contact traffic (a few packets
// per QSO, each a KB or two) -- far beyond any realistic outage. A var so
// a test can shrink it.
var maxHeldPackets = 20000

// Retry pacing for the oldest held packet: start fast (a deploy restart is
// a few seconds), back off to a gentle steady state for a longer outage.
// Vars so tests can shrink them.
var (
	holdRetryStart = 1 * time.Second
	holdRetryMax   = 30 * time.Second
	holdReportEach = 60 * time.Second // "still holding N" reminder while down
)

// heldQueue is an unbounded-until-cap FIFO between the UDP reader (push,
// never blocks) and the forwarder (wait/ack).
type heldQueue struct {
	mu      sync.Mutex
	items   [][]byte
	dropped int // packets lost to the cap since the last report
	closed  bool
	notify  chan struct{} // capacity 1: "something changed"
}

func newHeldQueue() *heldQueue {
	return &heldQueue{notify: make(chan struct{}, 1)}
}

func (q *heldQueue) push(p []byte) {
	q.mu.Lock()
	if len(q.items) >= maxHeldPackets {
		q.items = q.items[1:]
		q.dropped++
	}
	q.items = append(q.items, p)
	q.mu.Unlock()
	q.poke()
}

func (q *heldQueue) poke() {
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

// head blocks until there's a packet (returned, not removed) or the queue
// is closed and empty (ok=false).
func (q *heldQueue) head() ([]byte, bool) {
	for {
		q.mu.Lock()
		if len(q.items) > 0 {
			p := q.items[0]
			q.mu.Unlock()
			return p, true
		}
		closed := q.closed
		q.mu.Unlock()
		if closed {
			return nil, false
		}
		<-q.notify
	}
}

// ack removes the head (delivered, or permanently rejected).
func (q *heldQueue) ack() {
	q.mu.Lock()
	if len(q.items) > 0 {
		q.items[0] = nil
		q.items = q.items[1:]
	}
	q.mu.Unlock()
}

func (q *heldQueue) len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

func (q *heldQueue) takeDropped() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	n := q.dropped
	q.dropped = 0
	return n
}

func (q *heldQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	q.poke()
}

func (q *heldQueue) isClosed() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.closed
}

// httpStatusError is an HTTP response the server actually sent.
type httpStatusError struct {
	url  string
	code int
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("%s rejected: HTTP %d", e.url, e.code)
}

// retryable: worth holding the packet and trying again. Everything is,
// except an HTTP answer that says this packet will never be accepted (a
// malformed packet, a wrong path) -- holding that one would block every QSO
// behind it forever. Auth failures (401/403) ARE retried: they mean the
// server's token doesn't match right now (e.g. mid-redeploy, or being
// fixed), and the held QSOs should go through once it does.
func retryable(err error) bool {
	var he *httpStatusError
	if !errors.As(err, &he) {
		return true // no response at all: network, timeout, watchdog abandon
	}
	switch {
	case he.code >= 500, he.code == http.StatusRequestTimeout, he.code == http.StatusTooManyRequests,
		he.code == http.StatusUnauthorized, he.code == http.StatusForbidden:
		return true
	default:
		return false
	}
}

// holdForwarder is the contact relay's forwarder: deliver the oldest held
// packet, retrying with backoff until the server takes it.
func (r *relay) holdForwarder() {
	tag := fmt.Sprintf("[%s :%d]", r.label, r.port)
	backoff := holdRetryStart
	var downSince, lastReport time.Time
	for {
		p, ok := r.hold.head()
		if !ok {
			return
		}
		err := r.forward(p)
		if err == nil || !retryable(err) {
			if err != nil {
				log.Printf("%s %v -- the server won't accept this packet; dropping it so it can't block the QSOs behind it", tag, err)
			} else if r.label == "contact" && r.logPackets {
				log.Printf("%s SENT ok", tag)
			}
			r.hold.ack()
			if !downSince.IsZero() {
				log.Printf("%s server reachable again after %s -- sending %d held packet(s)", tag, time.Since(downSince).Round(time.Second), r.hold.len())
				downSince = time.Time{}
			}
			backoff = holdRetryStart
			if r.hold.len() == 0 && !lastReport.IsZero() {
				log.Printf("%s all held packets delivered", tag)
				lastReport = time.Time{}
			}
			continue
		}

		now := time.Now()
		if downSince.IsZero() {
			downSince, lastReport = now, now
			log.Printf("%s %v -- holding QSOs in memory and retrying until the server is back", tag, err)
		} else if now.Sub(lastReport) >= holdReportEach {
			lastReport = now
			msg := fmt.Sprintf("%s still unreachable after %s (%v) -- holding %d packet(s)", tag, now.Sub(downSince).Round(time.Second), err, r.hold.len())
			if d := r.hold.takeDropped(); d > 0 {
				msg += fmt.Sprintf("; %d oldest dropped at the %d-packet limit", d, maxHeldPackets)
			}
			log.Print(msg)
		}
		if r.hold.isClosed() {
			return // shutting down (tests): stop retrying
		}
		time.Sleep(backoff)
		if backoff *= 2; backoff > holdRetryMax {
			backoff = holdRetryMax
		}
	}
}
