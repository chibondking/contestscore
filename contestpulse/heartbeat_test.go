package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHeartbeatSendPostsStationIDAndAuthHeader(t *testing.T) {
	var gotAuth, gotContentType string
	var gotPayload heartbeatPayload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotAuth = req.Header.Get("Authorization")
		gotContentType = req.Header.Get("Content-Type")
		body, _ := io.ReadAll(req.Body)
		_ = json.Unmarshal(body, &gotPayload)
		w.WriteHeader(202)
	}))
	defer srv.Close()

	h := newHeartbeat("shack1", srv.URL, "secret123", time.Second)
	if err := h.send(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if gotAuth != "Bearer secret123" {
		t.Fatalf("Authorization: got %q, want %q", gotAuth, "Bearer secret123")
	}
	if gotContentType != "application/json" {
		t.Fatalf("Content-Type: got %q, want application/json", gotContentType)
	}
	if gotPayload.StationID != "shack1" {
		t.Fatalf("station_id: got %q, want shack1", gotPayload.StationID)
	}
}

func TestHeartbeatSendReturnsErrorOnNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.WriteHeader(401)
	}))
	defer srv.Close()

	h := newHeartbeat("shack1", srv.URL, "wrong-token", time.Second)
	if err := h.send(); err == nil {
		t.Fatal("expected an error on HTTP 401, got nil")
	}
}

func TestHeartbeatRunSendsImmediatelyThenOnEachTick(t *testing.T) {
	hits := make(chan struct{}, 10)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		hits <- struct{}{}
		w.WriteHeader(202)
	}))
	defer srv.Close()

	h := newHeartbeat("shack1", srv.URL, "secret123", 30*time.Millisecond)
	stop := make(chan struct{})
	go h.run(stop)
	defer close(stop)

	// Immediate send on start, then at least one more tick within a couple
	// of intervals -- generous margin to avoid CI timing flakiness.
	for i := 0; i < 2; i++ {
		select {
		case <-hits:
		case <-time.After(500 * time.Millisecond):
			t.Fatalf("expected at least 2 heartbeats, only got %d", i)
		}
	}
}

func TestHeartbeatRunStopsOnStopChannel(t *testing.T) {
	hits := make(chan struct{}, 100)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		hits <- struct{}{}
		w.WriteHeader(202)
	}))
	defer srv.Close()

	h := newHeartbeat("shack1", srv.URL, "secret123", 10*time.Millisecond)
	stop := make(chan struct{})
	go h.run(stop)

	time.Sleep(50 * time.Millisecond)
	close(stop)
	time.Sleep(50 * time.Millisecond)

	// Drain whatever arrived before stop, then confirm nothing more shows
	// up afterwards.
	drained := 0
	draining := true
	for draining {
		select {
		case <-hits:
			drained++
		default:
			draining = false
		}
	}
	if drained == 0 {
		t.Fatal("expected at least one heartbeat before stop")
	}
	select {
	case <-hits:
		t.Fatal("received a heartbeat after stop() was closed")
	case <-time.After(100 * time.Millisecond):
		// good: no further sends
	}
}
