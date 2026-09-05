package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
)

// Config is ContestPulse's on-disk config.json shape. Unlike station-status's
// agent, there is no "source" field -- ContestPulse doesn't parse or
// understand any of N1MM's packet types, it just relays raw UDP bytes by
// port to contestscore's ingest API, which runs them through the exact same
// parsers the LAN UDP listeners use. One mode, nothing to choose.
type Config struct {
	// StationID identifies this ContestPulse instance to the server -- shown
	// on the dashboard's realtime/stale/offline indicator. Required so
	// multiple stations' heartbeats don't get merged into one status.
	StationID string `json:"station_id"`
	// ServerURL is the contestscore instance's base URL, e.g.
	// "https://scoreboard.wt2p.us". Ingest paths (/api/ingest/radio etc.)
	// are appended automatically -- don't include them here.
	ServerURL string `json:"server_url"`
	// APIToken must match the contestscore instance's CONTESTSCORE_API_TOKEN
	// env var. Ingest is refused entirely (HTTP 503) server-side if that
	// env var isn't set, so this can't silently degrade to "no auth".
	APIToken string `json:"api_token"`

	// Local UDP ports to listen on for N1MM's broadcasts on this machine.
	// Defaults match N1MM's own defaults (12060/12061/12062) if omitted --
	// confirm against N1MM's Broadcast Data tab if it's configured
	// differently on this station.
	RadioPort   int `json:"radio_port"`
	ContactPort int `json:"contact_port"`
	ScorePort   int `json:"score_port"`

	// HeartbeatIntervalSeconds controls how often ContestPulse pings the
	// server just to say "I'm still running and reachable," independent of
	// whatever N1MM traffic is or isn't flowing -- Contact/Score packets
	// only happen when the contest itself produces something, so they can't
	// be relied on as a liveness signal during a quiet stretch. Default 10s.
	HeartbeatIntervalSeconds float64 `json:"heartbeat_interval_seconds"`
}

const (
	defaultRadioPort        = 12060
	defaultContactPort      = 12061
	defaultScorePort        = 12062
	defaultHeartbeatSeconds = 10
)

func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parsing config: %w", err)
	}

	if cfg.StationID == "" {
		return nil, fmt.Errorf(`config requires "station_id" -- identifies this station on the dashboard's realtime/stale/offline indicator`)
	}
	if cfg.ServerURL == "" {
		return nil, fmt.Errorf(`config requires "server_url", e.g. "https://scoreboard.wt2p.us"`)
	}
	if cfg.APIToken == "" {
		return nil, fmt.Errorf(`config requires "api_token" -- must match the contestscore instance's CONTESTSCORE_API_TOKEN`)
	}
	if cfg.RadioPort == 0 {
		cfg.RadioPort = defaultRadioPort
	}
	if cfg.ContactPort == 0 {
		cfg.ContactPort = defaultContactPort
	}
	if cfg.ScorePort == 0 {
		cfg.ScorePort = defaultScorePort
	}
	if cfg.HeartbeatIntervalSeconds <= 0 {
		cfg.HeartbeatIntervalSeconds = defaultHeartbeatSeconds
	}
	return &cfg, nil
}

// parseFlags is separated from main() so it's testable without touching
// os.Args in every test.
func parseFlags(args []string) (configPath string, err error) {
	fs := flag.NewFlagSet("contestpulse", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return "", err
	}
	if fs.NArg() != 1 {
		return "", fmt.Errorf("usage: contestpulse config.json")
	}
	return fs.Arg(0), nil
}
