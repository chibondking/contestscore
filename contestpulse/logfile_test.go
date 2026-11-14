package main

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveLogPath(t *testing.T) {
	cfg := filepath.Join("shack", "agent", "config.json")
	if got := resolveLogPath("", cfg); got != "" {
		t.Fatalf("empty: got %q", got)
	}
	if got, want := resolveLogPath("agent.log", cfg), filepath.Join("shack", "agent", "agent.log"); got != want {
		t.Fatalf("relative: got %q, want %q", got, want)
	}
	abs := filepath.Join(t.TempDir(), "x.log")
	if got := resolveLogPath(abs, cfg); got != abs {
		t.Fatalf("absolute: got %q, want %q", got, abs)
	}
}

// Every log line lands on the console and in the file, and a reopen
// (agent restart) appends rather than truncating.
func TestOpenLogFileTeesAndAppends(t *testing.T) {
	prevOut, prevFlags := log.Writer(), log.Flags()
	t.Cleanup(func() { log.SetOutput(prevOut); log.SetFlags(prevFlags) })
	log.SetFlags(0)

	path := filepath.Join(t.TempDir(), "logs", "agent.log") // folder doesn't exist yet
	for _, line := range []string{"first run", "second run"} {
		var console bytes.Buffer
		f, err := openLogFile(path, &console)
		if err != nil {
			t.Fatalf("openLogFile: %v", err)
		}
		log.Print(line)
		f.Close()
		if !strings.Contains(console.String(), line) {
			t.Fatalf("console missing %q: %q", line, console.String())
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(data); got != "first run\nsecond run\n" {
		t.Fatalf("file: got %q", got)
	}
}

// A path that can't be opened returns an error and leaves the logger
// writing to the console only.
func TestOpenLogFileFailureKeepsConsole(t *testing.T) {
	prevOut := log.Writer()
	t.Cleanup(func() { log.SetOutput(prevOut) })
	var console bytes.Buffer
	log.SetOutput(&console)

	dir := t.TempDir()
	blocker := filepath.Join(dir, "file")
	if err := os.WriteFile(blocker, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := openLogFile(filepath.Join(blocker, "agent.log"), &console); err == nil {
		t.Fatal("expected an error opening a log under a regular file")
	}
	log.Print("still here")
	if !strings.Contains(console.String(), "still here") {
		t.Fatalf("logger no longer writes to the console: %q", console.String())
	}
}
