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
