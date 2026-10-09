package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fastHold shrinks the hold retry pacing for the duration of a test.
func fastHold(t *testing.T) {
	t.Helper()
	start, max, report, cap := holdRetryStart, holdRetryMax, holdReportEach, maxHeldPackets
	holdRetryStart, holdRetryMax, holdReportEach = 5*time.Millisecond, 20*time.Millisecond, time.Hour
	t.Cleanup(func() { holdRetryStart, holdRetryMax, holdReportEach, maxHeldPackets = start, max, report, cap })
}

// flakyServer answers with `down` (an HTTP status, or 0 = drop the
// connection with no response -- a transport error) while down is set, and
// records every body it accepts once it's back up.
type flakyServer struct {
	*httptest.Server
	down     atomic.Int32
	mu       sync.Mutex
	accepted []string
	attempts atomic.Int32
	reject   map[string]int // body -> permanent status, regardless of down
}

func newFlakyServer(t *testing.T, downStatus int) *flakyServer {
	t.Helper()
	fs := &flakyServer{reject: map[string]int{}}
	fs.down.Store(int32(downStatus))
	fs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		fs.attempts.Add(1)
		body, _ := io.ReadAll(req.Body)
		if code, ok := fs.reject[string(body)]; ok {
			w.WriteHeader(code)
			return
		}
		switch d := fs.down.Load(); {
		case d == -1: // transport error: hang up without answering
			hj, _ := w.(http.Hijacker)
			conn, _, _ := hj.Hijack()
			conn.Close()
			return
		case d > 0:
			w.WriteHeader(int(d))
			return
		}
		fs.mu.Lock()
		fs.accepted = append(fs.accepted, string(body))
		fs.mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(fs.Close)
	return fs
}

func (fs *flakyServer) got() []string {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return append([]string(nil), fs.accepted...)
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// The point of the whole feature: QSOs logged while the server is down
// (a restart behind Cloudflare answers 502) are held and delivered, in
// order, once it's back -- not dropped.
func TestHeldContactPacketsSurviveAServerOutage(t *testing.T) {
	for name, down := range map[string]int{"502 from the tunnel": 502, "503": 503, "connection dropped": -1, "auth mismatch while redeploying": 401} {
		t.Run(name, func(t *testing.T) {
			fastHold(t)
			srv := newFlakyServer(t, down)
			r := newRelay("contact", 0, srv.URL, "secret").holdPackets()
			go r.holdForwarder()
			defer r.hold.close()

			want := []string{"<contactinfo>1</contactinfo>", "<contactreplace>1</contactreplace>", "<contactinfo>2</contactinfo>", "<contactdelete>1</contactdelete>"}
			for _, p := range want {
				r.enqueue([]byte(p))
			}
			waitFor(t, "a few failed attempts", func() bool { return srv.attempts.Load() >= 3 })
			if n := r.hold.len(); n != len(want) {
				t.Fatalf("held while down: got %d, want %d", n, len(want))
			}

			srv.down.Store(0) // server back
			waitFor(t, "the backlog to drain", func() bool { return r.hold.len() == 0 })
			if got := srv.got(); !equalStrings(got, want) {
				t.Fatalf("delivered: got %q, want %q (all of them, in order)", got, want)
			}
		})
	}
}

// A packet the server says it will never accept must not block every QSO
// behind it.
func TestPermanentlyRejectedPacketIsDroppedNotHeld(t *testing.T) {
	fastHold(t)
	srv := newFlakyServer(t, 0)
	srv.reject["bad"] = http.StatusBadRequest
	r := newRelay("contact", 0, srv.URL, "secret").holdPackets()
	go r.holdForwarder()
	defer r.hold.close()

	for _, p := range []string{"a", "bad", "b"} {
		r.enqueue([]byte(p))
	}
	waitFor(t, "the queue to empty", func() bool { return r.hold.len() == 0 })
	if got := srv.got(); !equalStrings(got, []string{"a", "b"}) {
		t.Fatalf("delivered: got %q, want [a b]", got)
	}
	if n := srv.attempts.Load(); n != 3 {
		t.Fatalf("attempts: got %d, want 3 (the 400 is not retried)", n)
	}
}

func TestRetryableClassification(t *testing.T) {
	for code, want := range map[int]bool{500: true, 502: true, 503: true, 530: true, 408: true, 429: true, 401: true, 403: true, 400: false, 404: false, 413: false, 415: false} {
		if got := retryable(&httpStatusError{url: "x", code: code}); got != want {
			t.Errorf("HTTP %d: retryable=%v, want %v", code, got, want)
		}
	}
	if !retryable(io.ErrUnexpectedEOF) {
		t.Error("a transport error must be retryable")
	}
}

// The cap keeps a very long outage from growing memory without bound: the
// oldest goes first, and it's counted for the log.
func TestHeldQueueCapDropsOldest(t *testing.T) {
	fastHold(t)
	maxHeldPackets = 3
	q := newHeldQueue()
	for i := 1; i <= 5; i++ {
		q.push([]byte{byte(i)})
	}
	if q.len() != 3 {
		t.Fatalf("len: got %d, want 3", q.len())
	}
	if p, _ := q.head(); p[0] != 3 {
		t.Fatalf("head: got %d, want 3 (1 and 2 dropped)", p[0])
	}
	if d := q.takeDropped(); d != 2 {
		t.Fatalf("dropped: got %d, want 2", d)
	}
}

// End to end through a real UDP socket: QSOs sent to the contact port
// while the server is down arrive once it's back.
func TestRunHoldsRealUDPContactPacketsThroughAnOutage(t *testing.T) {
	fastHold(t)
	srv := newFlakyServer(t, 502)

	probe, err := net.ListenUDP("udp4", &net.UDPAddr{Port: 0, IP: net.IPv4zero})
	if err != nil {
		t.Fatalf("free UDP port: %v", err)
	}
	port := probe.LocalAddr().(*net.UDPAddr).Port
	probe.Close()

	r := newRelay("contact", port, srv.URL, "secret").holdPackets()
	go r.run()
	defer r.stop()
	time.Sleep(50 * time.Millisecond)

	conn, err := net.Dial("udp4", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	want := []string{"<contactinfo>A</contactinfo>", "<contactinfo>B</contactinfo>", "<contactinfo>C</contactinfo>"}
	for _, p := range want {
		conn.Write([]byte(p))
		time.Sleep(5 * time.Millisecond)
	}
	waitFor(t, "all three to be held", func() bool { return r.hold.len() == 3 })

	srv.down.Store(0)
	waitFor(t, "delivery", func() bool { return len(srv.got()) == 3 })
	if got := srv.got(); !equalStrings(got, want) {
		t.Fatalf("delivered: got %q, want %q", got, want)
	}
}
