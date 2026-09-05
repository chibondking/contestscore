package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTempConfig(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadConfigValidWithDefaults(t *testing.T) {
	path := writeTempConfig(t, `{
		"station_id": "shack1",
		"server_url": "https://scoreboard.wt2p.us",
		"api_token": "secret123"
	}`)
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.RadioPort != defaultRadioPort {
		t.Fatalf("RadioPort: got %d, want default %d", cfg.RadioPort, defaultRadioPort)
	}
	if cfg.ContactPort != defaultContactPort {
		t.Fatalf("ContactPort: got %d, want default %d", cfg.ContactPort, defaultContactPort)
	}
	if cfg.ScorePort != defaultScorePort {
		t.Fatalf("ScorePort: got %d, want default %d", cfg.ScorePort, defaultScorePort)
	}
	if cfg.HeartbeatIntervalSeconds != defaultHeartbeatSeconds {
		t.Fatalf("HeartbeatIntervalSeconds: got %v, want default %v", cfg.HeartbeatIntervalSeconds, defaultHeartbeatSeconds)
	}
}

func TestLoadConfigCustomPorts(t *testing.T) {
	path := writeTempConfig(t, `{
		"station_id": "shack1",
		"server_url": "https://scoreboard.wt2p.us",
		"api_token": "secret123",
		"radio_port": 20060,
		"contact_port": 20061,
		"score_port": 20062,
		"heartbeat_interval_seconds": 15
	}`)
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.RadioPort != 20060 || cfg.ContactPort != 20061 || cfg.ScorePort != 20062 {
		t.Fatalf("custom ports not honored: got %+v", cfg)
	}
	if cfg.HeartbeatIntervalSeconds != 15 {
		t.Fatalf("HeartbeatIntervalSeconds: got %v, want 15", cfg.HeartbeatIntervalSeconds)
	}
}

func TestLoadConfigMissingStationID(t *testing.T) {
	path := writeTempConfig(t, `{
		"server_url": "https://scoreboard.wt2p.us",
		"api_token": "secret123"
	}`)
	_, err := loadConfig(path)
	if err == nil {
		t.Fatal("expected error for missing station_id, got nil")
	}
}

func TestLoadConfigMissingServerURL(t *testing.T) {
	path := writeTempConfig(t, `{"station_id": "shack1", "api_token": "secret123"}`)
	_, err := loadConfig(path)
	if err == nil {
		t.Fatal("expected error for missing server_url, got nil")
	}
}

func TestLoadConfigMissingAPIToken(t *testing.T) {
	path := writeTempConfig(t, `{"station_id": "shack1", "server_url": "https://scoreboard.wt2p.us"}`)
	_, err := loadConfig(path)
	if err == nil {
		t.Fatal("expected error for missing api_token, got nil")
	}
}

func TestLoadConfigMissingFile(t *testing.T) {
	_, err := loadConfig(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if err == nil {
		t.Fatal("expected error for a missing config file, got nil")
	}
}

func TestLoadConfigInvalidJSON(t *testing.T) {
	path := writeTempConfig(t, `{not valid json`)
	_, err := loadConfig(path)
	if err == nil {
		t.Fatal("expected error for invalid JSON, got nil")
	}
}

func TestParseFlagsRequiresExactlyOneArg(t *testing.T) {
	if _, err := parseFlags([]string{}); err == nil {
		t.Fatal("expected error with no args, got nil")
	}
	if _, err := parseFlags([]string{"a.json", "b.json"}); err == nil {
		t.Fatal("expected error with two args, got nil")
	}
}

func TestParseFlagsConfigPath(t *testing.T) {
	path, err := parseFlags([]string{"config.json"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if path != "config.json" {
		t.Fatalf("configPath: got %q, want config.json", path)
	}
}
