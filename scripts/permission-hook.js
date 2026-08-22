#!/usr/bin/env node
/**
 * Rundock Permission Hook
 *
 * Runs as a Claude Code PreToolUse hook. When Claude wants to use a tool
 * that requires permission (e.g. Bash), this script:
 *
 * 1. POSTs the tool request to the Rundock server
 * 2. Rundock shows a permission card in the browser
 * 3. User clicks Allow or Deny
 * 4. This script receives the decision and tells Claude Code
 *
 * If not running inside Rundock (no RUNDOCK env var), passes through silently.
 * If the Rundock server is unreachable, allows by default to avoid blocking.
 */

const http = require('http');
const os = require('os');
const path = require('path');

// MCP read/write classification. Read-style MCP tools auto-approve; writes,
// destructive actions, and anything unrecognised get a permission card.
// Destructive verbs are checked first, so a name like `delete-after-search` can
// never auto-approve; read verbs are checked before defaulting to card, so a name
// like `API-post-search` (a search) is correctly treated as a read.
const MCP_DESTRUCTIVE_VERBS = new Set(['delete','remove','destroy','drop','cancel','abort','archive','trash','purge','clear','uninstall']);
const MCP_READ_VERBS = new Set(['get','list','search','find','read','fetch','retrieve','query','export','view','describe','show','info','overview','status','count','available','daily','review','recent','collaborators','comments','activity']);
function isMcpReadTool(toolName) {
  const action = String(toolName).split('__').slice(2).join('_');
  if (!action) return false;
  const tokens = action
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase
    .split(/[_\-\s]+/)
    .map(t => t.toLowerCase())
    .filter(Boolean);
  if (tokens.some(t => MCP_DESTRUCTIVE_VERBS.has(t))) return false;
  if (tokens.some(t => MCP_READ_VERBS.has(t))) return true;
  return false;
}

// Deny a direct file edit to the GLOBAL Claude Code agent/skill config
// (~/.claude/agents, ~/.claude/skills). Rundock never reads the global folder,
// so such an edit would silently succeed somewhere invisible to the app: the
// reported bug where an agent "updated" and nothing changed, surviving a
// restart. Workspace .claude edits are deliberately NOT blocked (the workspace
// is the agent's own domain, and those land in the file the app reads); the
// SAVE_AGENT / SAVE_SKILL markers remain the way to get a live UI refresh.
const CLAUDE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
function isProtectedClaudeEdit(toolName, toolInput) {
  if (!CLAUDE_EDIT_TOOLS.has(toolName)) return false;
  const ti = toolInput || {};
  const target = ti.file_path || ti.notebook_path || ti.path;
  if (typeof target !== 'string') return false;
  const resolved = path.resolve(target);
  const under = (root) => resolved === root || resolved.startsWith(root + path.sep);
  return under(path.join(os.homedir(), '.claude', 'agents'))
      || under(path.join(os.homedir(), '.claude', 'skills'));
}

// Workspace file-access boundary (spec: anything outside the workspace
// requires a permission card unless a standing per-workspace folder grant
// covers it; the server owns the grants). This function only CLASSIFIES:
// inside targets are allowed instantly with no server round-trip, outside
// targets flow to the permission card with the resolved path attached.
// Grep/Glob with no explicit path scan the working directory and are inside
// by construction. Symlinked escapes are not chased here (path resolution
// only); Bash can also reach outside but is already carded on every call.
const FILE_TOOL_PATH_FIELD = {
  Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path', Glob: 'path', Grep: 'path',
};
function classifyFileAccess(toolName, toolInput, workspaceRoot, extraDirs = []) {
  const field = FILE_TOOL_PATH_FIELD[toolName];
  if (!field) return null;
  const ti = toolInput || {};
  const target = ti[field];
  if (typeof target !== 'string' || !target) {
    // Glob/Grep default to the working directory: inside by construction.
    // A path-less Write/Edit is malformed; let the generic card handle it.
    return (toolName === 'Glob' || toolName === 'Grep') ? { where: 'inside' } : null;
  }
  const resolvedPath = path.resolve(workspaceRoot, target);
  const roots = [path.resolve(workspaceRoot), ...extraDirs.map(d => path.resolve(d))];
  const under = (root) => resolvedPath === root || resolvedPath.startsWith(root + path.sep);
  const inside = roots.some(under);
  // The folder a standing grant would cover: the directory itself for the
  // directory-scanning tools, the parent directory for file targets.
  const grantDir = (toolName === 'Glob' || toolName === 'Grep') ? resolvedPath : path.dirname(resolvedPath);
  return { where: inside ? 'inside' : 'outside', resolvedPath, grantDir };
}

// The shell-command half of the same boundary.
//
// classifyFileAccess above covers the seven FILE tools. A shell command is
// none of them, so it returned null, and at the code-mode branch in main()
// null means auto-approve. The result was that in the mode where coding
// agents run, a command writing to the home directory raised NO card, while
// an Edit of the same file did. The comment that used to sit above
// FILE_TOOL_PATH_FIELD said Bash "is already carded on every call": true in
// knowledge mode, false in code mode, and it is code mode where this matters.
//
// The seam is SHELL COMMANDS, not Bash. On Windows the same commands run
// through the PowerShell tool (registered as its own matcher by
// lib/workspace/scaffold.js), and it was equally unclassified.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// TWO SIGNALS, AND THEY ARE NOT EQUALLY GOOD. Only the first is a guarantee.
//
// 1. dangerouslyDisableSandbox. When the spawned runtime's command sandbox is
//    on, a command it denies is retried with this flag, and the retry arrives
//    here. The operating system already decided, at syscall time, that the
//    command reached outside; no text was read to establish it. Measured
//    against the CLI on 2026-08-22 rather than assumed.
//
// 2. A path in the command text that resolves outside. Deciding what a shell
//    command writes by reading it is undecidable, so this is an ESCALATION
//    HEURISTIC and never a containment guarantee. It exists because the
//    sandbox does not cover every platform this product ships on, and a
//    partial answer beats silence there. What actually holds the line is
//    signal 1, and where signal 1 is unavailable the seam is stated in the
//    product copy instead of papered over here.
//
// WHY THIS NEVER RETURNS 'inside'. main() allows an 'inside' classification
// instantly with no server round-trip. Returning 'inside' for an ordinary
// command would therefore delete the Bash card knowledge mode shows today.
// A crossing is reported; everything else returns null and keeps whatever
// card it already had.
function shellPathTokens(command) {
  const out = [];
  const rest = String(command)
    // Quoted segments are single tokens: a path with a space in it is one
    // path, and splitting it on whitespace would resolve two wrong ones.
    .replace(/'([^']*)'|"([^"]*)"/g, (m, a, b) => { out.push(a !== undefined ? a : b); return ' '; });
  for (const t of rest.split(/[\s;|&<>()`]+/)) if (t) out.push(t);
  return out;
}

function shellCrossing(command, workspaceRoot, roots) {
  for (const raw of shellPathTokens(command)) {
    let t = raw;
    if (t === '~' || t.startsWith('~/')) t = os.homedir() + t.slice(1);
    else if (t === '$HOME' || t.startsWith('$HOME/')) t = os.homedir() + t.slice(5);
    else if (t === '${HOME}' || t.startsWith('${HOME}/')) t = os.homedir() + t.slice(7);
    // Skip tokens that could not cross anyway: anything without a leading
    // slash and without a `..` segment.
    //
    // THIS IS A FILTER, NOT A GUARD, and the difference is recorded because
    // both lines that used to sit here read like guards. An explicit
    // `includes('://')` URL test was deleted when mutating it turned no test
    // red, and mutating THIS line turns none red either. Neither can: a
    // relative token resolves against the workspace root, so it lands inside
    // whatever it looks like, URL or Windows path or compiler flag. What
    // decides a crossing is the resolve base below and nothing here. Left in
    // for cost and legibility, labelled so it is never credited with safety.
    else if (!t.startsWith('/') && !/(^|\/)\.\.(\/|$)/.test(t)) continue;
    const resolved = path.resolve(workspaceRoot, t);
    const under = (root) => resolved === root || resolved.startsWith(root + path.sep);
    if (!roots.some(under)) return resolved;
  }
  return null;
}

function classifyShellAccess(toolName, toolInput, workspaceRoot, extraDirs = []) {
  if (!SHELL_TOOLS.has(toolName)) return null;
  const ti = toolInput || {};
  // Signal 1. No grant folder is offered: a sandbox escape is not about one
  // folder, so "always allow this folder" would remember nothing and the
  // button would be a lie.
  if (ti.dangerouslyDisableSandbox === true) {
    return { where: 'outside', resolvedPath: null, grantDir: null };
  }
  // Signal 2.
  if (typeof ti.command !== 'string' || !ti.command) return null;
  const roots = [path.resolve(workspaceRoot), ...extraDirs.map(d => path.resolve(d))];
  const resolvedPath = shellCrossing(ti.command, workspaceRoot, roots);
  if (!resolvedPath) return null;
  return { where: 'outside', resolvedPath, grantDir: path.dirname(resolvedPath) };
}

module.exports = { isProtectedClaudeEdit, isMcpReadTool, classifyFileAccess, classifyShellAccess };

if (require.main === module) main();
function main() {
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  // Not running in Rundock: pass through (no decision, Claude Code handles normally)
  if (!process.env.RUNDOCK) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(input);
  } catch (e) {
    // Bad input: pass through
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Workspace file-access boundary. Classified BEFORE the code-mode
  // short-circuit on purpose: code mode trusts commands inside the
  // workspace, it does not extend the workspace to the whole machine.
  const wsRoot = process.env.RUNDOCK_WORKSPACE || process.cwd();
  const extraDirs = (process.env.RUNDOCK_EXTRA_DIRS || '').split(path.delimiter).filter(Boolean);
  // File tools and shell commands are classified by the same boundary and
  // reach the same card. classifyShellAccess only ever answers 'outside' or
  // null, so an ordinary command keeps whatever card it already had: the
  // instant-allow branch below stays reachable only by file tools.
  const classified = (typeof data.tool_name === 'string' && !isProtectedClaudeEdit(data.tool_name, data.tool_input))
    ? classifyFileAccess(data.tool_name, data.tool_input, wsRoot, extraDirs)
      || classifyShellAccess(data.tool_name, data.tool_input, wsRoot, extraDirs)
    : null;
  const access = classified;
  if (access && access.where === 'inside') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'In-workspace file access'
      }
    }));
    process.exit(0);
  }

  // Code mode: auto-approve all commands (no permission card). Out-of-
  // workspace file access still cards above/below regardless of mode.
  if (process.env.RUNDOCK_CODE_MODE === '1' && !(access && access.where === 'outside')) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Auto-approved: workspace is in Code mode'
      }
    }));
    process.exit(0);
  }

  // MCP tools are routed through the hook (not pre-approved via --allowed-tools).
  // Read-style MCP calls auto-approve here, server-side, so they work even when no
  // browser tab is actively connected and never block on the card timeout.
  // Write/destructive/unrecognised MCP calls fall through to the permission card.
  if (typeof data.tool_name === 'string' && data.tool_name.startsWith('mcp__') && isMcpReadTool(data.tool_name)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Auto-approved: MCP read'
      }
    }));
    process.exit(0);
  }

  // Agents and skills are managed ONLY through the RUNDOCK:SAVE_AGENT /
  // RUNDOCK:SAVE_SKILL markers, which write into THIS workspace's .claude folder
  // and refresh the UI. Deterministically deny any direct file edit to a
  // .claude/agents or .claude/skills path, in the workspace OR the global
  // ~/.claude (Claude Code's native default). Without this, a direct edit
  // silently succeeds in the wrong place: an edit to the global agents folder
  // that Rundock never reads, leaving the user told "done" while the workspace
  // file, and the profile panel, never changed. This is enforcement, not a
  // prompt: the wrong path can no longer look like a success.
  if (isProtectedClaudeEdit(data.tool_name, data.tool_input)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: "This edits the global ~/.claude agent or skill config, which Rundock does not use. Manage this workspace's agents and skills through the RUNDOCK:SAVE_AGENT / RUNDOCK:SAVE_SKILL markers (which write into this workspace and refresh the app), or edit the workspace's own .claude file."
      }
    }));
    process.exit(0);
  }

  const port = process.env.RUNDOCK_PORT || 3000;
  const convoId = process.env.RUNDOCK_CONVO_ID || '';

  const payload = JSON.stringify({
    tool_name: data.tool_name,
    tool_input: data.tool_input || {},
    session_id: data.session_id,
    conversation_id: convoId,
    ...(access && access.where === 'outside'
      ? { boundary: true, resolved_path: access.resolvedPath || null, grant_dir: access.grantDir || null }
      : {})
  });

  const req = http.request({
    hostname: '127.0.0.1',
    port: port,
    path: '/api/permission-request',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 300000 // 5 min: server-side timeout (120s) handles the real cutoff
  }, res => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => {
      try {
        const result = JSON.parse(body);
        let reason = 'Approved in Rundock';
        if (!result.allow) {
          reason = result.reason === 'timeout'
            ? 'The permission request was not completed within the time limit. Try the command again if it is still needed.'
            : 'This command was not approved. Acknowledge and move on.';
        }
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: result.allow ? 'allow' : 'deny',
            permissionDecisionReason: reason
          }
        }));
      } catch (e) {
        // Parse error: allow to avoid blocking
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Rundock hook: could not parse server response'
          }
        }));
      }
      process.exit(0);
    });
  });

  req.on('error', () => {
    // Server unreachable: allow to avoid blocking the user
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Rundock server unreachable, allowing by default'
      }
    }));
    process.exit(0);
  });

  req.on('timeout', () => {
    req.destroy();
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'The permission request was not completed within the time limit. Try the command again if it is still needed.'
      }
    }));
    process.exit(0);
  });

  req.write(payload);
  req.end();
});
}
