// Loads <app root>/.env into process.env at startup -- the simple way to
// configure a LAN/Pi install (docs/SETUP.md). README has always said "copy
// .env.example to .env", but nothing read the file until 2026-10-09; a
// systemd install with an EnvironmentFile (deploy/*.service) never noticed.
//
// Never overrides a variable that's already set, so a service's
// EnvironmentFile (VPS installs, every tenant) always wins over a stray
// .env in the shared checkout. No dependency: KEY=VALUE lines, # comments,
// optional surrounding quotes, `export ` prefix tolerated.

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', '.env');

function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, ''); // trailing comment on an unquoted value
    }
    out[m[1]] = value;
  }
  return out;
}

// Returns the names it set (for a startup log line).
function loadEnvFile(file = DEFAULT_PATH, env = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const set = [];
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (env[k] === undefined) { env[k] = v; set.push(k); }
  }
  return set;
}

module.exports = { parseEnv, loadEnvFile };
