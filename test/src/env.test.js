const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnv, loadEnvFile } = require('../../src/env');

describe('.env loader', () => {
  it('parses KEY=VALUE, comments, quotes and export', () => {
    assert.deepEqual(parseEnv([
      '# comment', '', 'LOOKUP_PROVIDER=hamqth', 'export HTTP_PORT = 3001',
      'HAMQTH_PASSWORD="p#ss word"', "NAME='x'", 'TRAILING=yes # note', 'not a line', 'EMPTY=',
    ].join('\n')), {
      LOOKUP_PROVIDER: 'hamqth', HTTP_PORT: '3001', HAMQTH_PASSWORD: 'p#ss word', NAME: 'x', TRAILING: 'yes', EMPTY: '',
    });
  });

  it('never overrides what the environment already has', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envtest-'));
    const f = path.join(dir, '.env');
    fs.writeFileSync(f, 'A=from-file\nB=from-file\n');
    const env = { A: 'from-systemd' };
    assert.deepEqual(loadEnvFile(f, env), ['B']);
    assert.deepEqual(env, { A: 'from-systemd', B: 'from-file' });
  });

  it('a missing file is fine', () => {
    assert.deepEqual(loadEnvFile('/nonexistent/.env', {}), []);
  });
});

describe('.env loader in tenant mode', () => {
  it('loads nothing for a hosted tenant (shared checkout)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envtest-'));
    const f = path.join(dir, '.env');
    fs.writeFileSync(f, 'SOLAR_ENABLED=false\n');
    const env = { CONTESTSCORE_TENANT: 'k9ct' };
    assert.deepEqual(loadEnvFile(f, env), []);
    assert.equal(env.SOLAR_ENABLED, undefined);
  });
});
