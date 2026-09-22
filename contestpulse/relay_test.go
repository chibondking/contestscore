package main

import (
	"bytes"
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestForwardSendsBytesAndAuthHeader(t *testing.T) {
	var gotBody []byte
	var gotAuth, gotContentType, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotMethod = req.Method
		gotAuth = req.Header.Get("Authorization")
		gotContentType = req.Header.Get("Content-Type")
		gotBody, _ = io.ReadAll(req.Body)
		w.WriteHeader(202)
	}))
	defer srv.Close()

	r := newRelay("radio", 0, srv.URL, "secret123")
	packet := []byte(`<RadioInfo><RadioNr>1</RadioNr></RadioInfo>`)
	if err := r.forward(packet); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if gotMethod != "POST" {
		t.Fatalf("method: got %q, want POST", gotMethod)
	}
	if gotAuth != "Bearer secret123" {
		t.Fatalf("Authorization: got %q, want %q", gotAuth, "Bearer secret123")
	}
	if gotContentType != "application/octet-stream" {
		t.Fatalf("Content-Type: got %q", gotContentType)
	}
	if string(gotBody) != string(packet) {
		t.Fatalf("body: got %q, want %q (bytes must pass through unmodified)", gotBody, packet)
	}
}

func TestForwardReturnsErrorOnNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.WriteHeader(401)
	}))
	defer srv.Close()

	r := newRelay("radio", 0, srv.URL, "wrong-token")
	if err := r.forward([]byte("x")); err == nil {
		t.Fatal("expected an error on HTTP 401, got nil")
	}
}

func TestForwardReturnsErrorWhenServerUnreachable(t *testing.T) {
	r := newRelay("radio", 0, "http://127.0.0.1:1", "secret123") // port 1: nothing listens there
	if err := r.forward([]byte("x")); err == nil {
		t.Fatal("expected an error when the server is unreachable, got nil")
	}
}

// A half-open keep-alive connection (the failure mode that once wedged
// ContestPulse) should heal on its own: the first post gets no response,
// forward() drops idle conns and retries once on a fresh connection.
func TestForwardRetriesOnceAfterATransportError(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if atomic.AddInt32(&hits, 1) == 1 {
			// Simulate a dead connection: take it and drop it, no response.
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Error("ResponseWriter is not a Hijacker")
				return
			}
			conn, _, err := hj.Hijack()
			if err != nil {
				t.Errorf("hijack: %v", err)
				return
			}
			conn.Close()
			return
		}
		w.WriteHeader(202)
	}))
	defer srv.Close()

	r := newRelay("score", 0, srv.URL, "secret123")
	if err := r.forward([]byte("<dynamicresults/>")); err != nil {
		t.Fatalf("expected success after one retry, got: %v", err)
	}
	if got := atomic.LoadInt32(&hits); got != 2 {
		t.Fatalf("server hits: got %d, want 2 (first failed, retried once)", got)
	}
}

// An actual HTTP error response means the pipe works -- don't retry it.
func TestForwardDoesNotRetryOnHTTPError(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(401)
	}))
	defer srv.Close()

	r := newRelay("score", 0, srv.URL, "wrong-token")
	if err := r.forward([]byte("x")); err == nil {
		t.Fatal("expected an error on HTTP 401")
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("server hits: got %d, want 1 (a 401 must not be retried)", got)
	}
}

// enqueue() is the core of the fix for a relay that stops making progress
// and needs a manual restart: once the queue between the reader and the
// forwarder is full, a new packet must displace the oldest one, never
// block. White-box on the channel directly -- deterministic, no timing.
func TestEnqueueDropsOldestPacketWhenQueueIsFull(t *testing.T) {
	r := newRelay("score", 0, "http://unused.invalid", "secret")
	for i := 0; i < forwardQueueDepth; i++ {
		r.packets <- []byte{byte(i)}
	}

	r.enqueue([]byte{99})

	var got [][]byte
	for len(r.packets) > 0 {
		got = append(got, <-r.packets)
	}
	if len(got) != forwardQueueDepth {
		t.Fatalf("queue length after enqueue: got %d, want %d (still full, not grown)", len(got), forwardQueueDepth)
	}
	if got[0][0] != 1 {
		t.Fatalf("expected packet 0 (the oldest) to have been dropped; front of queue is now %v", got[0])
	}
	if got[len(got)-1][0] != 99 {
		t.Fatalf("expected the newest packet to be at the back of the queue, got %v", got[len(got)-1])
	}
}

// The real-world regression this whole change targets: a forward that's
// stuck (a slow or non-responding server) must not stop run()'s ReadFrom
// loop from picking up the next UDP packet. Before decoupling the two, this
// is exactly what made the score relay look dead until ContestPulse was
// restarted by hand -- one stuck send blocked the read loop for that port
// entirely, whether or not the reason it was stuck ever got confirmed.
func TestRunKeepsReadingWhileAForwardIsStuck(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	var bodies [][]byte
	first := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		mu.Lock()
		isFirst := first
		first = false
		mu.Unlock()
		if isFirst {
			<-release // held open until the test says the "stuck" request may finish
		}
		mu.Lock()
		bodies = append(bodies, body)
		mu.Unlock()
		w.WriteHeader(202)
	}))
	defer srv.Close()

	probe, err := net.ListenUDP("udp4", &net.UDPAddr{Port: 0, IP: net.IPv4zero})
	if err != nil {
		t.Fatalf("failed to find a free UDP port: %v", err)
	}
	port := probe.LocalAddr().(*net.UDPAddr).Port
	probe.Close()

	r := newRelay("score", port, srv.URL, "secret123")
	go r.run()
	defer r.stop()
	time.Sleep(50 * time.Millisecond)

	conn, err := net.Dial("udp4", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Fatalf("failed to dial relay's UDP port: %v", err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte("first")); err != nil {
		t.Fatalf("failed to send first packet: %v", err)
	}
	time.Sleep(20 * time.Millisecond) // let the relay pick it up and start (and block on) forwarding it
	if _, err := conn.Write([]byte("second")); err != nil {
		t.Fatalf("failed to send second packet: %v", err)
	}

	// Before the fix, run()'s ReadFrom wouldn't be called again until the
	// first forward returned -- "second" would never even be read off the
	// socket, let alone queued. It landing in r.packets proves the read
	// loop kept going despite the stuck forward.
	deadline := time.Now().Add(time.Second)
	for len(r.packets) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if len(r.packets) == 0 {
		t.Fatal("expected the second packet to have been read and queued while the first forward was still stuck")
	}

	close(release)

	deadline = time.Now().Add(time.Second)
	for {
		mu.Lock()
		n := len(bodies)
		mu.Unlock()
		if n >= 2 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 2 {
		t.Fatalf("expected both packets to eventually be forwarded, got %d: %v", len(bodies), bodies)
	}
	if string(bodies[0]) != "first" || string(bodies[1]) != "second" {
		t.Fatalf("expected forward order to be preserved (first, second), got: %v", bodies)
	}
}

// End-to-end: a real UDP packet sent to the relay's port should arrive at
// the HTTP server byte-for-byte, exercising run()'s socket handling too,
// not just forward().
func TestRunRelaysRealUDPPacketToHTTPServer(t *testing.T) {
	received := make(chan []byte, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		received <- body
		w.WriteHeader(202)
	}))
	defer srv.Close()

	// Bind to an ephemeral port ourselves first so the test doesn't need a
	// fixed port (which could collide in CI) -- then hand that port to the
	// relay after releasing it. Small TOCTOU race in theory; fine for a test.
	probe, err := net.ListenUDP("udp4", &net.UDPAddr{Port: 0, IP: net.IPv4zero})
	if err != nil {
		t.Fatalf("failed to find a free UDP port: %v", err)
	}
	port := probe.LocalAddr().(*net.UDPAddr).Port
	probe.Close()

	r := newRelay("radio", port, srv.URL, "secret123")
	go r.run()
	defer r.stop()

	// Give run() a moment to bind before sending.
	time.Sleep(50 * time.Millisecond)

	conn, err := net.Dial("udp4", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Fatalf("failed to dial relay's UDP port: %v", err)
	}
	defer conn.Close()

	packet := []byte(`<RadioInfo><RadioNr>1</RadioNr><Freq>352211</Freq></RadioInfo>`)
	if _, err := conn.Write(packet); err != nil {
		t.Fatalf("failed to send UDP packet: %v", err)
	}

	select {
	case body := <-received:
		if string(body) != string(packet) {
			t.Fatalf("relayed body: got %q, want %q", body, packet)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the relay to forward the packet")
	}
}

// Regression test for the real-world "N1MMSpot Port: Port In Use Error":
// N1MM's own process also binds its Contact/Score/Radio ports (for its
// networked multi-op sync) on the same machine ContestPulse runs on. If
// run() doesn't set SO_REUSEADDR, whichever of the two starts first
// exclusively locks the port and the other fails to bind at all.
func TestRunAllowsAnotherProcessToBindTheSamePort(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.WriteHeader(202)
	}))
	defer srv.Close()

	probe, err := net.ListenUDP("udp4", &net.UDPAddr{Port: 0, IP: net.IPv4zero})
	if err != nil {
		t.Fatalf("failed to find a free UDP port: %v", err)
	}
	port := probe.LocalAddr().(*net.UDPAddr).Port
	probe.Close()

	r := newRelay("radio", port, srv.URL, "secret123")
	go r.run()
	defer r.stop()
	time.Sleep(50 * time.Millisecond) // let run() bind first

	// Stand-in for N1MM's own listener binding the same port afterwards --
	// same reuseaddr mechanism a second real process on the OS would need.
	lc := net.ListenConfig{Control: setReuseAddr}
	second, err := lc.ListenPacket(context.Background(), "udp4", ":"+strconv.Itoa(port))
	if err != nil {
		t.Fatalf("a second listener should be able to bind the same port (SO_REUSEADDR): %v", err)
	}
	second.Close()
}

// The contact relay logs every packet's raw bytes on receipt and confirms
// each successful forward -- useful to see live whether N1MM is actually
// broadcasting anything for a given log entry at all (a WAE QTC, say), not
// just whether an already-received packet made it upstream. radio/score
// stay silent: those are frequent enough (every VFO tick, every RTC
// interval) that logging each one would drown this out.
func TestRunLogsContactPacketsButNotRadioOrScore(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		io.ReadAll(req.Body)
		w.WriteHeader(202)
	}))
	defer srv.Close()

	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	for _, label := range []string{"contact", "radio", "score"} {
		probe, err := net.ListenUDP("udp4", &net.UDPAddr{Port: 0, IP: net.IPv4zero})
		if err != nil {
			t.Fatalf("failed to find a free UDP port: %v", err)
		}
		port := probe.LocalAddr().(*net.UDPAddr).Port
		probe.Close()

		r := newRelay(label, port, srv.URL, "secret123")
		r.logPackets = true // exercises the config-on case; the off case is covered below
		go r.run()
		time.Sleep(50 * time.Millisecond)

		conn, err := net.Dial("udp4", "127.0.0.1:"+strconv.Itoa(port))
		if err != nil {
			t.Fatalf("[%s] failed to dial relay's UDP port: %v", label, err)
		}
		if _, err := conn.Write([]byte("<contactinfo><call>W1AW</call></contactinfo>")); err != nil {
			t.Fatalf("[%s] failed to send UDP packet: %v", label, err)
		}
		conn.Close()
		time.Sleep(100 * time.Millisecond) // let run() log before we stop it
		r.stop()
	}

	lines := strings.Split(buf.String(), "\n")
	var contactHasRX, contactHasSENT bool
	for _, line := range lines {
		if !strings.Contains(line, "[contact :") {
			continue
		}
		if strings.Contains(line, "RX") && strings.Contains(line, "W1AW") {
			contactHasRX = true
		}
		if strings.Contains(line, "SENT ok") {
			contactHasSENT = true
		}
	}
	if !contactHasRX || !contactHasSENT {
		t.Fatalf("expected the contact relay to log an RX line (with the packet contents) and a SENT ok line, got:\n%s", buf.String())
	}

	for _, label := range []string{"radio", "score"} {
		for _, line := range lines {
			if strings.Contains(line, "["+label+" :") && (strings.Contains(line, "RX") || strings.Contains(line, "SENT ok")) {
				t.Fatalf("expected no RX/SENT logging for the %s relay, got line:\n%s", label, line)
			}
		}
	}
}

// config.json's log_contact_packets: false (main.go wires this into
// relay.logPackets) must silence the contact relay too, not just
// radio/score -- logPackets is the user-facing override on top of the
// label=="contact" gate above.
func TestRunDoesNotLogContactPacketsWhenLogPacketsIsFalse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		io.ReadAll(req.Body)
		w.WriteHeader(202)
	}))
	defer srv.Close()

	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	probe, err := net.ListenUDP("udp4", &net.UDPAddr{Port: 0, IP: net.IPv4zero})
	if err != nil {
		t.Fatalf("failed to find a free UDP port: %v", err)
	}
	port := probe.LocalAddr().(*net.UDPAddr).Port
	probe.Close()

	r := newRelay("contact", port, srv.URL, "secret123") // logPackets left false (the zero value)
	go r.run()
	defer r.stop()
	time.Sleep(50 * time.Millisecond)

	conn, err := net.Dial("udp4", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Fatalf("failed to dial relay's UDP port: %v", err)
	}
	if _, err := conn.Write([]byte("<contactinfo><call>W1AW</call></contactinfo>")); err != nil {
		t.Fatalf("failed to send UDP packet: %v", err)
	}
	conn.Close()
	time.Sleep(100 * time.Millisecond)

	if strings.Contains(buf.String(), "RX") || strings.Contains(buf.String(), "SENT ok") {
		t.Fatalf("expected no RX/SENT logging with logPackets left false, got:\n%s", buf.String())
	}
}

