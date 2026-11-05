'use strict';
// HOW CLAUDE CODE READS AN AGENT FILE, for tests that cannot run Claude Code.
//
// CI has no Claude Code, and the question these tests ask is one only Claude
// Code can settle: would it load this file? It drops an agent file it cannot
// read with no error anybody sees, and a --print run started with --agent
// naming that agent then stops at once, before any session exists, with one
// line on stderr and exit code 1:
//
//   --agent 'lead' not found. Available agents: claude, Explore, ...
//
// It says exactly that for each of the three reasons a file does not load: no
// `name:`, no `description:`, or frontmatter its YAML reader cannot read. This
// module models all three, and the line.
//
// WHAT THE MODEL IS. A strict reader for the part of YAML agent frontmatter
// uses: block mappings and sequences, plain, single-quoted and double-quoted
// values, flow lists of plain or quoted items, block scalars, and comments. It
// refuses what a YAML reader refuses: a colon and a space inside a plain
// value, a value that starts with a backtick or an @, a quoted value with more
// text after its closing quote, a duplicated key, a tab in the indentation.
// And it refuses anything outside that subset (an anchor, a tag, a flow
// mapping, a quoted value over several lines) rather than guess at it. So it
// can call a file unreadable that Claude Code would load, which a test author
// meets as a loud failure, and it does not call a file loadable that Claude
// Code would drop, which is the direction a test of loading has to trust.
//
// ONE LENIENCY IS CLAUDE CODE'S OWN, as observed against the real CLI: a value
// on a top-level line that breaks the YAML is retried in quotes, so a stray
// colon in `description:` costs nothing, and only a value nested under another
// key (a routine's prompt, a starter prompt) loses the whole file.
//
// The reading itself is lib/agents/claude-code-load.js, which the scheduler
// uses too, and which test/unit/claude-cli-agent-load.test.js holds to a
// record of the real CLI. This adds what only the stub needs: the names
// Claude Code would accept in a workspace, and the line it writes for the
// rest.

const fs = require('node:fs');
const path = require('node:path');
const { readYaml, readAgentFile, YamlError } = require('../../lib/agents/claude-code-load.js');

// The agents Claude Code ships with, which it lists beside a workspace's own.
const BUILT_IN_AGENTS = ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'];

/** The names Claude Code would accept for --agent, run in this workspace. */
function loadableAgentNames(workspaceDir) {
  const dir = path.join(workspaceDir, '.claude', 'agents');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch (e) { /* no agents */ }
  const names = new Set(BUILT_IN_AGENTS);
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch (e) { continue; }
    const read = readAgentFile(text);
    if (read.loads) names.add(read.name);
  }
  return [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** What Claude Code writes to stderr for an --agent it has not loaded. */
function agentNotFoundLine(name, available) {
  return `--agent '${name}' not found. Available agents: ${available.join(', ')}`;
}

module.exports = { readYaml, readAgentFile, loadableAgentNames, agentNotFoundLine, YamlError, BUILT_IN_AGENTS };
