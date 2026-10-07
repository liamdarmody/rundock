// The demo workspace's settings state: its mode, the sandbox switch, a working
// folder, the answers already given to permission cards, and the connectors
// both runtimes can reach. Written as the files Rundock itself keeps them in,
// so the Settings pages read real state rather than a seeded screen.
//
// Connector credentials are named, never valued: every env entry is a
// placeholder the runtime would expand, so no shot can show a secret.

import fs from 'node:fs';
import path from 'node:path';

// The working folder, as it reads in Settings once the fake $HOME is
// collapsed back to `~`. Created, so the row never shows as missing.
export const WORKING_FOLDER = 'Projects';

// One ordinary standing allow and one remembered Code-mode rule, which
// Settings lists in words.
export const ALLOWED_TOOLS = ['WebFetch', 'Bash:git-push:default-branch'];

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

// `mode` is 'code' or 'knowledge' (the on-disk name for Notes).
export function writeSettingsState(workspace, home, { mode = 'code' } = {}) {
  fs.mkdirSync(path.join(home, WORKING_FOLDER), { recursive: true });
  // Stored as `~/...`, which Rundock expands against the server's home on
  // read: the build root's absolute path never lands in a file.
  writeJson(path.join(workspace, '.rundock', 'state.json'), {
    workspaceMode: mode,
    sandboxSwitch: 'on',
    workingFolders: [`~/${WORKING_FOLDER}`],
  });
  writeJson(path.join(workspace, '.rundock', 'permissions.json'), { allowedDirs: [], allowedTools: ALLOWED_TOOLS });
}

// A calendar connector both runtimes reach from the workspace, and a task
// manager Claude Code reaches from this machine only.
export function writeConnectors(workspace, home) {
  const calendar = { command: 'npx', args: ['-y', 'example-calendar-mcp'] };
  writeJson(path.join(workspace, '.mcp.json'), {
    mcpServers: { calendar: { ...calendar, env: { CALENDAR_TOKEN: '${CALENDAR_TOKEN}' } } },
  });
  fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.codex', 'config.toml'), [
    '[mcp_servers.calendar]',
    'command = "npx"',
    'args = ["-y", "example-calendar-mcp"]',
    'env_vars = ["CALENDAR_TOKEN"]',
    '',
  ].join('\n'));
  writeJson(path.join(home, '.claude.json'), {
    mcpServers: { tasks: { command: 'npx', args: ['-y', 'example-tasks-mcp'], env: { TASKS_API_KEY: '${TASKS_API_KEY}' } } },
  });
}
