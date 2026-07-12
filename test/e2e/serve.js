'use strict';
// E2E server launcher, used by Playwright's webServer. Seeds a disposable
// workspace fixture, points HOME at the fixture's fake home (so the fake
// Claude Code session jsonl resolves and nothing touches the real one), and
// boots the real server.js in-process on the E2E port.
const { buildFixture } = require('./fixture.js');

const { workspace, home } = buildFixture();
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows equivalent
process.env.WORKSPACE = workspace;
process.env.RUNDOCK_ELECTRON = '1'; // keep recent-workspaces file inside the fake home

const PORT = Number(process.env.E2E_PORT || 34517);
require('../../server.js').startServer({ port: PORT });
