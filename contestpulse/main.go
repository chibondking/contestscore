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
//	contestpulse config.json
package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

func main() {
	configPath, err := parseFlags(os.Args[1:])
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}

	cfg, err := loadConfig(configPath)
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	base := strings.TrimRight(cfg.ServerURL, "/") + "/api/ingest"
	relays := []*relay{
		newRelay("radio", cfg.RadioPort, base+"/radio", cfg.APIToken),
		newRelay("contact", cfg.ContactPort, base+"/contact", cfg.APIToken),
		newRelay("score", cfg.ScorePort, base+"/score", cfg.APIToken),
	}
	hb := newHeartbeat(
		cfg.StationID,
		base+"/heartbeat",
		cfg.APIToken,
		time.Duration(cfg.HeartbeatIntervalSeconds*float64(time.Second)),
	)

	log.Printf("ContestPulse starting: station=%q server=%s (radio :%d, contact :%d, score :%d, heartbeat every %.0fs)",
		cfg.StationID, cfg.ServerURL, cfg.RadioPort, cfg.ContactPort, cfg.ScorePort, cfg.HeartbeatIntervalSeconds)
	for _, r := range relays {
		go r.run()
	}
	go hb.run(make(chan struct{})) // never stopped; the process exits instead
	select {}                      // run forever; a relay only exits via log.Fatalf on bind failure
}
