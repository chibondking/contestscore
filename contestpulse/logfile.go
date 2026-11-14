package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
)

// Logging to a file as well as the console (config "log_file").
//
// The console can't be relied on to get text out: QuickEdit is disabled on
// Windows (console_windows.go) because a stray click froze the whole relay,
// which also means nothing can be highlighted and copied out of the window.
// With log_file set, every line the agent prints -- startup, packet RX/SENT
// (log_contact_packets), hold/retry reports -- is also appended to that
// file, so it can be opened, searched and attached after the fact (e.g. to
// see whether N1MM sent anything at all for a WAE QTC).
//
// Opt-in: an existing config with no log_file keeps printing to the console
// only. A relative path is taken from the config file's own folder, not the
// working directory, so a shortcut that starts the agent from elsewhere
// still writes next to config.json. Append, never truncate: a restart
// mid-contest must not wipe the lines that explain why it was restarted.
// No rotation -- contact traffic is a few KB per hundred QSOs, and radio /
// score packets are never logged.

// resolveLogPath returns logFile as an absolute path, relative paths taken
// from configPath's directory. Empty in, empty out.
func resolveLogPath(logFile, configPath string) string {
	if logFile == "" || filepath.IsAbs(logFile) {
		return logFile
	}
	return filepath.Join(filepath.Dir(configPath), logFile)
}

// openLogFile points the standard logger at the console plus path. On
// failure the logger is left as it was (console only) and the error is
// returned for the caller to report -- a bad log path must never stop the
// relay itself.
func openLogFile(path string, console io.Writer) (*os.File, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("creating log folder: %w", err)
		}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("opening log file: %w", err)
	}
	log.SetOutput(io.MultiWriter(console, f))
	return f, nil
}
