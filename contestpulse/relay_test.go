package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
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

