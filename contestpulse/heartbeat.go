package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

type heartbeatPayload struct {
	StationID string `json:"station_id"`
}

// heartbeat posts a small liveness ping to the server on a fixed interval,
// independent of whatever N1MM traffic is or isn't flowing through the
// relays. This is the signal contestscore uses to tell "ContestPulse is
// running and reachable" apart from "the contest is just quiet right now" --
// Contact/Score packets only happen when something actually occurs, so they
// can't be trusted alone as a liveness signal, and RadioInfo's own ~10s
// cadence isn't guaranteed either (N1MM only sends it while a radio entry
// window has focus). The heartbeat is unconditional.
type heartbeat struct {
	stationID string
	targetURL string
	apiToken  string
	interval  time.Duration
	client    *http.Client
}

func newHeartbeat(stationID, targetURL, apiToken string, interval time.Duration) *heartbeat {
	return &heartbeat{
		stationID: stationID,
		targetURL: targetURL,
		apiToken:  apiToken,
		interval:  interval,
		client:    &http.Client{Timeout: 5 * time.Second},
	}
}

// send posts one heartbeat. Split out from run() for the same testability
// reason as relay.forward().
func (h *heartbeat) send() error {
	body, err := json.Marshal(heartbeatPayload{StationID: h.stationID})
	if err != nil {
		return fmt.Errorf("marshal heartbeat: %w", err)
	}
	req, err := http.NewRequest("POST", h.targetURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("building request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.apiToken)

	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("posting heartbeat to %s: %w", h.targetURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s rejected heartbeat: HTTP %d", h.targetURL, resp.StatusCode)
	}
	return nil
}

// run sends a heartbeat immediately (so the dashboard doesn't wait a full
// interval after startup to show "realtime"), then on every tick of the
// configured interval, until stop is closed.
func (h *heartbeat) run(stop <-chan struct{}) {
	if err := h.send(); err != nil {
		log.Printf("[heartbeat] %v", err)
	}
	ticker := time.NewTicker(h.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := h.send(); err != nil {
				log.Printf("[heartbeat] %v", err)
			}
		case <-stop:
			return
		}
	}
}
