// Deploy metadata for the dashboard's "deployed at" footer, so a viewer can
// tell at a glance whether they're looking at a cached/stale page: the
// timestamp only changes when a real deploy happens, never on its own.
//
// deploy-info.json is written by deploy/contestscore-deploy.sh at the
// moment of each deploy (not tracked in git -- it's environment-specific
// and generated fresh every time). Falls back to this process's own start
// time when the file doesn't exist, which covers a plain `npm start` (a
// local/Pi install that never runs the deploy script) -- still accurate
// there, since starting the process *is* the deploy in that case.
const fs = require('fs');
const path = require('path');

const DEPLOY_INFO_PATH = path.join(__dirname, '../deploy-info.json');
const processStartedAt = new Date().toISOString();

function getVersionInfo() {
  try {
    const data = JSON.parse(fs.readFileSync(DEPLOY_INFO_PATH, 'utf8'));
    return {
      commit: data.commit || null,
      deployedAt: data.deployedAt || processStartedAt,
    };
  } catch {
    return { commit: null, deployedAt: processStartedAt };
  }
}

module.exports = { getVersionInfo };
