'use strict';
// E2E server launcher, used by Playwright's webServer. Seeds a disposable
// workspace fixture, points HOME at the fixture's fake home (so the fake
// Claude Code session jsonl resolves and nothing touches the real one), and
// boots the real server.js in-process on the E2E port.
const path = require('node:path');
const { buildFixture } = require('./fixture.js');

// The stub runtime first on PATH, so a spec that presses Run on a routine
// spawns the stub and never a real agent CLI with permissions skipped.
process.env.PATH = path.join(__dirname, '..', 'helpers', 'stub-claude') + path.delimiter + process.env.PATH;

const { workspace, home } = buildFixture();
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows equivalent
process.env.WORKSPACE = workspace;
process.env.RUNDOCK_ELECTRON = '1'; // keep recent-workspaces file inside the fake home

const PORT = Number(process.env.E2E_PORT || 34517);
require('../../server.js').startServer({ port: PORT });
