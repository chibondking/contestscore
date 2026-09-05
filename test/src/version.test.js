const fs = require('fs');
const path = require('path');
const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getVersionInfo } = require('../../src/version');

// Same hardcoded path src/version.js reads -- gitignored, deploy-time-only.
const DEPLOY_INFO_PATH = path.join(__dirname, '../../deploy-info.json');

function removeDeployInfo() {
  try { fs.unlinkSync(DEPLOY_INFO_PATH); } catch { /* already absent */ }
}

beforeEach(removeDeployInfo);
after(removeDeployInfo);

describe('getVersionInfo', () => {
  it('falls back to a process-start timestamp when deploy-info.json is absent', () => {
    const info = getVersionInfo();
    assert.equal(info.commit, null);
    assert.ok(info.deployedAt);
    assert.ok(!Number.isNaN(Date.parse(info.deployedAt)));
  });

  it('reads commit/deployedAt from deploy-info.json when present', () => {
    fs.writeFileSync(DEPLOY_INFO_PATH, JSON.stringify({
      commit: 'abc1234',
      deployedAt: '2026-01-01T00:00:00.000Z',
    }));
    const info = getVersionInfo();
    assert.equal(info.commit, 'abc1234');
    assert.equal(info.deployedAt, '2026-01-01T00:00:00.000Z');
  });

  it('falls back gracefully instead of throwing on malformed JSON', () => {
    fs.writeFileSync(DEPLOY_INFO_PATH, 'not valid json');
    const info = getVersionInfo();
    assert.equal(info.commit, null);
    assert.ok(info.deployedAt);
  });
});
