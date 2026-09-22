package main

import (
	"bytes"
	"errors"
	"log"
	"os"
	"strings"
	"testing"
	"time"
)

// If a call runs past watchdogThreshold, watchDo must log that it's still
// in flight (the whole point -- a call that never returns at all would
// never produce an after-the-fact log on its own) and, once it finally
// does return, log how long it took.
func TestWatchDoLogsWhenACallOutlastsTheThreshold(t *testing.T) {
	orig := watchdogThreshold
	watchdogThreshold = 20 * time.Millisecond
	defer func() { watchdogThreshold = orig }()

	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- watchDo("test", func() error {
			<-release
			return errors.New("boom")
		})
	}()

	// Give the watchdog goroutine time to fire its "still waiting" line
	// before the call is allowed to return.
	time.Sleep(80 * time.Millisecond)
	close(release)

	select {
	case err := <-done:
		if err == nil || err.Error() != "boom" {
			t.Fatalf("expected the wrapped error to pass through unchanged, got: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("watchDo did not return after its fn did")
	}

	out := buf.String()
	if !strings.Contains(out, "still waiting on a request") {
		t.Fatalf("expected a \"still waiting\" line while the call was in flight, got:\n%s", out)
	}
	if !strings.Contains(out, "finally returned") || !strings.Contains(out, "boom") {
		t.Fatalf("expected a \"finally returned\" line including the error, got:\n%s", out)
	}
}

// If fn never returns at all, watchDo must not wait on it forever -- past
// hardAbandonAfter it gives up and returns an error, so whatever called it
// (relay.forwarder()'s loop, in production) can move on instead of staying
// wedged. This is the actual fix for the "had to restart the app by hand"
// failure mode: even in the worst case where net/http's own Client.Timeout
// somehow doesn't bound a call, watchDo now does.
func TestWatchDoAbandonsACallThatNeverReturns(t *testing.T) {
	origThreshold, origAbandon := watchdogThreshold, hardAbandonAfter
	watchdogThreshold = 10 * time.Millisecond
	hardAbandonAfter = 40 * time.Millisecond
	defer func() { watchdogThreshold, hardAbandonAfter = origThreshold, origAbandon }()

	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	block := make(chan struct{}) // deliberately never closed -- fn hangs forever
	done := make(chan error, 1)
	go func() {
		done <- watchDo("test", func() error {
			<-block
			return nil
		})
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected an error from an abandoned call, got nil")
		}
	case <-time.After(time.Second):
		t.Fatal("watchDo did not abandon a call that never returns -- it's still blocked")
	}

	if !strings.Contains(buf.String(), "abandoning after") {
		t.Fatalf("expected an \"abandoning after\" log line, got:\n%s", buf.String())
	}
}

// A call that returns comfortably inside the threshold should produce
// neither log line -- the normal, quiet case.
func TestWatchDoStaysQuietWhenACallFinishesInTime(t *testing.T) {
	orig := watchdogThreshold
	watchdogThreshold = time.Second
	defer func() { watchdogThreshold = orig }()

	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	if err := watchDo("test", func() error { return nil }); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if buf.Len() != 0 {
		t.Fatalf("expected no watchdog logging for a fast call, got:\n%s", buf.String())
	}
}
