// ContestPulse relays N1MM's UDP broadcasts (RadioInfo, ContactInfo/
// ContactReplace/ContactDelete/lookupinfo, and Score/dynamicresults) from a
// shack computer to a contestscore instance that isn't reachable directly
// over LAN broadcast -- e.g. a VPS. It forwards raw bytes over authenticated
// HTTPS rather than trusting UDP over a VPN: contestscore's ingest API never
// accepts unauthenticated broadcast traffic directly, matching the same
// design used for the sibling station-status agent.
//
// Alongside relaying, ContestPulse sends a heartbeat on a fixed interval
// (default 10s) so contestscore's dashboard can show whether a station's
// feed is realtime, stale, or offline -- see heartbeat.go's header comment
// for why that can't be inferred from relayed traffic alone.
//
// Usage:
//
//	contestscore-agent config.json
package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

// version is stamped at build time by CI (-ldflags "-X main.version=...",
// see .github/workflows/contestscore-agent-build.yml) with the contestscore
// version from package.json plus the commit, so a running binary can be
// matched to a release. A local `go build` reports "dev".
var version = "dev"

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "-version" || os.Args[1] == "--version") {
		fmt.Println("contestscore-agent", version)
		return
	}

	disableQuickEdit()

	configPath, err := parseFlags(os.Args[1:])
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}

	cfg, err := loadConfig(configPath)
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	// Before anything else logs, so the file has the startup line too.
	logPath := resolveLogPath(cfg.LogFile, configPath)
	if logPath != "" {
		if f, err := openLogFile(logPath, os.Stderr); err != nil {
			log.Printf("log_file %q: %v -- logging to the console only", logPath, err)
		} else {
			defer f.Close()
		}
	}

	base := strings.TrimRight(cfg.ServerURL, "/") + "/api/ingest"
	// Contact traffic (QSOs, edits, deletes) is held until the server
	// takes it, so a server restart or a network blip doesn't lose QSOs --
	// see hold.go. Radio/score are snapshots and don't need it.
	contactRelay := newRelay("contact", cfg.ContactPort, base+"/contact", cfg.APIToken).holdPackets()
	contactRelay.logPackets = *cfg.LogContactPackets
	relays := []*relay{
		newRelay("radio", cfg.RadioPort, base+"/radio", cfg.APIToken),
		contactRelay,
		newRelay("score", cfg.ScorePort, base+"/score", cfg.APIToken),
	}
	hb := newHeartbeat(
		cfg.StationID,
		base+"/heartbeat",
		cfg.APIToken,
		time.Duration(cfg.HeartbeatIntervalSeconds*float64(time.Second)),
	)

	log.Printf("ContestPulse %s starting: station=%q server=%s (radio :%d, contact :%d, score :%d, heartbeat every %.0fs)",
		version, cfg.StationID, cfg.ServerURL, cfg.RadioPort, cfg.ContactPort, cfg.ScorePort, cfg.HeartbeatIntervalSeconds)
	if logPath != "" {
		log.Printf("also logging to %s", logPath)
	}
	for _, r := range relays {
		go r.run()
	}
	go hb.run(make(chan struct{})) // never stopped; the process exits instead
	select {}                      // run forever; a relay only exits via log.Fatalf on bind failure
}
