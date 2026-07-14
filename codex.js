'use strict';
// Codex runtime adapter.
//
// Rundock agents can run on the OpenAI Codex CLI (a user's ChatGPT plan)
// alongside Claude Code. This module owns everything Codex-specific:
//
//   - buildCodexArgs():  argv for `codex exec --json` turns (fresh + resume)
//   - parseCodexLine():  one JSONL line -> one normalised event, or null
//   - detectCodex():     is the CLI installed / signed in / which version
//   - resolveCodexBin(): absolute binary path, Windows .cmd shim aware
//   - isCodexQuotaError(): classifies plan-limit errors for friendly surfacing
//
// Policy invariants (do not weaken):
//   - Only the official `codex` binary is ever spawned. No OpenAI/ChatGPT
//     endpoints are called directly and no OAuth material is read: auth
//     detection is the PRESENCE of auth.json, never its contents.
//   - workspace-write is REQUESTED on every spawn; effective enforcement is
//     platform-dependent. macOS (Seatbelt) and Linux (Landlock) enforce it;
//     native Windows cannot yet, and the CLI silently downgrades to a
//     read-only sandbox there (verified live: the native AppContainer
//     sandbox fails to initialise on ARM64). Windows writes therefore go
//     through WRITE_FILE markers + Rundock permission cards instead (see
//     parseWriteMarkers below). Approval/sandbox bypass flags are never
//     passed; a test pins this.
//
// Normalised events returned by parseCodexLine():
//   { type: 'session', threadId }                      thread.started
//   { type: 'text', text }                             item.completed (agent_message)
//   { type: 'done', usage: {inputTokens, cachedInputTokens, outputTokens} }
//                                                      turn.completed
//   { type: 'error', message }                         turn.failed / error
//   null                                               anything else (skip)

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');

// ── Argv construction ──────────────────────────────────────────────────────

// Build argv for one Codex turn. The prompt travels via stdin (the trailing
// `-`), matching how Rundock pipes prompts to Claude Code rather than putting
// user content into argv. `--skip-git-repo-check` is required because
// knowledge workspaces are frequently not git repositories and the CLI
// refuses to run in one otherwise. The model flag is passed only when the
// agent's frontmatter sets one; Codex's own default applies otherwise.
// Thread ids appear in argv as a positional after the `resume` subcommand,
// where the CLI still parses flags. A client-supplied id starting with a
// hyphen could therefore smuggle flags (including the forbidden bypass
// flags) into the invocation. Ids must start with an alphanumeric and stay
// within a safe charset; anything else starts a fresh thread instead.
const THREAD_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
function isValidThreadId(id) {
  return typeof id === 'string' && THREAD_ID_RE.test(id);
}

function buildCodexArgs({ resumeThreadId, model } = {}) {
  const args = ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check'];
  if (model) args.push('--model', model);
  if (resumeThreadId && isValidThreadId(resumeThreadId)) args.push('resume', resumeThreadId);
  args.push('-');
  return args;
}

// ── Output parsing ─────────────────────────────────────────────────────────

// Parse one line of `codex exec --json` output into a normalised event.
// Unknown or malformed lines return null; callers may log and must skip.
// The Codex CLI's output format can gain event types across versions, so
// this parser is deliberately a whitelist of the four shapes Rundock needs.
function parseCodexLine(line) {
  if (!line || !line.trim()) return null;
  let ev;
  try { ev = JSON.parse(line); } catch (e) { return null; }
  if (!ev || typeof ev !== 'object') return null;

  switch (ev.type) {
    case 'thread.started':
      return { type: 'session', threadId: ev.thread_id };
    case 'item.completed':
      if (ev.item && ev.item.type === 'agent_message') {
        return { type: 'text', text: ev.item.text };
      }
      return null; // command runs, reasoning steps etc: not user-facing
    case 'turn.completed': {
      const u = ev.usage || {};
      return {
        type: 'done',
        usage: {
          inputTokens: u.input_tokens || 0,
          cachedInputTokens: u.cached_input_tokens || 0,
          outputTokens: u.output_tokens || 0,
        },
      };
    }
    case 'turn.failed':
      return { type: 'error', message: (ev.error && ev.error.message) || 'Codex turn failed' };
    case 'error':
      return { type: 'error', message: ev.message || 'Codex error' };
    default:
      return null;
  }
}

// ── Binary resolution ──────────────────────────────────────────────────────

// Resolve the absolute path of the codex binary. Mirrors the Claude binary
// resolution: the absolute path lets Node spawn .cmd shims on Windows
// WITHOUT `shell: true`, which would expose prompt-bearing argv to command
// injection. On Windows, npm distributes `codex` as a .cmd shim, so the .cmd
// branch is the EXPECTED case there; a standalone .exe is preferred when both
// exist. On lookup failure the bare command is returned so spawn's 'error'
// event surfaces the real ENOENT.
function resolveCodexBin(deps = {}) {
  const platform = deps.platform || process.platform;
  const exec = deps.execSync || execSync;
  const isWindows = platform === 'win32';
  try {
    const lookupCmd = isWindows ? 'where.exe codex' : 'which codex';
    const output = exec(lookupCmd, { timeout: 5000, encoding: 'utf-8' }).trim();
    if (!output) return 'codex';
    if (isWindows) {
      const candidates = output.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const exe = candidates.find(c => c.toLowerCase().endsWith('.exe'));
      const cmd = candidates.find(c => c.toLowerCase().endsWith('.cmd'));
      return exe || cmd || candidates[0] || 'codex';
    }
    return output.split(/\r?\n/)[0].trim();
  } catch (e) {
    return 'codex';
  }
}

// ── Detection ──────────────────────────────────────────────────────────────

// Report whether Codex is usable on this machine:
//   installed:     the CLI binary resolves
//   authenticated: auth.json EXISTS under the Codex home. Presence only;
//                  the file is never read or copied. Sign-in belongs to the
//                  CLI (`codex login`), not to Rundock.
//   version:       from `codex --version`, null if unparseable
// The Codex home is $CODEX_HOME when set, else ~/.codex. Home resolution
// goes through os.homedir() so Windows (USERPROFILE) works.
function detectCodex(deps = {}) {
  const exec = deps.execSync || execSync;
  const exists = deps.existsSync || fs.existsSync;
  const homedir = deps.homedir || os.homedir;
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;

  const bin = resolveCodexBin({ execSync: exec, platform });
  if (bin === 'codex') {
    // Bare command means lookup failed: not installed (or not on PATH).
    // A second probe distinguishes "on PATH but which failed" cheaply.
    try {
      exec(platform === 'win32' ? 'where.exe codex' : 'which codex', { timeout: 5000, encoding: 'utf-8' });
    } catch (e) {
      return { installed: false, authenticated: false, version: null };
    }
  }

  let version = null;
  try {
    const out = exec(`"${bin}" --version`, { timeout: 5000, encoding: 'utf-8' });
    const m = String(out).match(/(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?)/);
    version = m ? m[1] : null;
  } catch (e) { /* installed but --version failed: keep version null */ }

  const codexHome = env.CODEX_HOME || path.join(homedir(), '.codex');
  const authenticated = !!exists(path.join(codexHome, 'auth.json'));

  // Windows only: whether the config declares a native sandbox (see
  // hasWindowsSandboxConfig). null off-Windows (not applicable). Honours
  // the RUNDOCK_TEST_PLATFORM seam for this field ONLY: binary resolution
  // above must stay on the real platform or the probes break in CI.
  const effectivePlatform = env.RUNDOCK_TEST_PLATFORM || platform;
  const windowsSandbox = effectivePlatform === 'win32'
    ? hasWindowsSandboxConfig({ homedir, env })
    : null;

  return { installed: true, authenticated, version, windowsSandbox };
}

// Presence-only scan of the Codex config for a [windows] table declaring a
// sandbox. When declared, the CLI grants a real workspace-write policy on
// Windows (in-process patch writes and sandboxed commands, workspace-
// bounded), so Rundock's write-marker fallback stands down. When absent,
// the CLI silently downgrades workspace-write to read-only (verified live)
// and the marker fallback carries writes instead. The VALUE is never acted
// on: any declared sandbox mode counts, mirroring the presence-only
// principle used for auth detection.
function hasWindowsSandboxConfig(deps = {}) {
  const read = deps.readFileSync || fs.readFileSync;
  const homedir = deps.homedir || os.homedir;
  const env = deps.env || process.env;
  try {
    const cfgPath = path.join(env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml');
    const lines = String(read(cfgPath, 'utf-8')).split(/\r?\n/);
    let inWindows = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith('[')) { inWindows = line === '[windows]'; continue; }
      if (inWindows && /^sandbox\s*=/.test(line)) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// ── Error classification ───────────────────────────────────────────────────

// Detects the Codex CLI's plan-limit exhaustion wording so the UI can show a
// friendly "limit reached" card instead of a raw error. Keyed on "usage
// limit", the stable core of the message across observed variants. Extend
// the pattern list as real-world variants are captured; keep it narrow so
// ordinary failures are never misclassified as quota.
const CODEX_QUOTA_RE = /usage limit/i;
function isCodexQuotaError(text) {
  return classifyCodexError(text).kind === 'quota';
}

// Classifies a Codex CLI failure message so the server can surface guidance
// instead of raw transport noise. Every pattern is keyed to a message
// captured from a real failure; keep them narrow so ordinary failures fall
// through to 'unknown' and surface verbatim.
//
// Kinds:
//   quota    plan-limit exhaustion ("usage limit")
//   model    the configured model is not available on this account
//            (captured: 400 invalid_request_error "The 'gpt-5.3-codex' model
//            is not supported when using Codex with a ChatGPT account.")
//   auth     signed out: 401/missing-bearer transport noise or the CLI's own
//            "not logged in" wording
//   unknown  everything else
const CODEX_MODEL_NAME_RE = /The '([^']+)' model is not supported/;
const CODEX_MODEL_RE = /\bmodel\b[^.]*\bis not supported\b/i;
const CODEX_AUTH_RE = /401 unauthorized|missing bearer or basic authentication|not (?:logged|signed) in/i;
function classifyCodexError(text) {
  if (typeof text !== 'string' || !text) return { kind: 'unknown', model: null };
  if (CODEX_QUOTA_RE.test(text)) return { kind: 'quota', model: null };
  if (CODEX_MODEL_RE.test(text)) {
    const m = text.match(CODEX_MODEL_NAME_RE);
    return { kind: 'model', model: m ? m[1] : null };
  }
  if (CODEX_AUTH_RE.test(text)) return { kind: 'auth', model: null };
  return { kind: 'unknown', model: null };
}

// ── Write-request markers (Windows) ─────────────────────────────────────────

// The Codex CLI cannot enforce its write sandbox on native Windows: it
// silently downgrades workspace-write to read-only (verified live; the
// native AppContainer sandbox fails to initialise on ARM64). Rather than
// leave Windows Codex agents read-only or pass bypass flags (pinned-never),
// win32 spawns are instructed to request writes as markers in their
// response. The server validates each request and performs the write itself
// after the user approves a permission card. Mac/Linux spawns never get the
// instruction and their markers are not honoured: the OS sandbox writes
// directly there.
const WRITE_MARKER_RE = /<!-- RUNDOCK:WRITE_FILE path="([^"\n]+)" -->\n([\s\S]*?)\n?<!-- \/RUNDOCK:WRITE_FILE -->/g;

// Returns { cleanText, requests: [{ path, content }] }. cleanText replaces
// each marker block with a short plain-language line so the conversation
// shows intent without the payload; the card carries the full content.
function parseWriteMarkers(text) {
  if (typeof text !== 'string' || !text) return { cleanText: '', requests: [] };
  const requests = [];
  const cleanText = text.replace(WRITE_MARKER_RE, (m, p, content) => {
    requests.push({ path: p, content });
    return `[write requested: ${p}]`;
  });
  return { cleanText, requests };
}

// Resolve a Codex thread id to its rollout file on disk. One rollout file
// exists per thread under $CODEX_HOME/sessions/YYYY/MM/DD, named
// rollout-<started-at>-<threadId>.jsonl, and resumes append to the SAME
// file (verified against real sessions; the CLI's own sqlite index maps
// thread id -> rollout_path the same way, but the filename convention is
// the stable public surface, so resolution scans filenames and never opens
// the CLI's databases). Newest date directories are scanned first. Returns
// the absolute path or null.
function findCodexThreadFile(threadId, deps = {}) {
  if (!isValidThreadId(threadId)) return null;
  const readdir = deps.readdirSync || fs.readdirSync;
  const homedir = deps.homedir || os.homedir;
  const env = deps.env || process.env;
  const sessionsDir = path.join(env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions');
  const suffix = `-${threadId}.jsonl`;
  const listDirs = (p) => {
    try { return readdir(p).sort().reverse(); } catch (e) { return []; }
  };
  for (const year of listDirs(sessionsDir)) {
    for (const month of listDirs(path.join(sessionsDir, year))) {
      for (const day of listDirs(path.join(sessionsDir, year, month))) {
        const dayDir = path.join(sessionsDir, year, month, day);
        for (const f of listDirs(dayDir)) {
          if (f.startsWith('rollout-') && f.endsWith(suffix)) return path.join(dayDir, f);
        }
      }
    }
  }
  return null;
}

module.exports = {
  buildCodexArgs, parseCodexLine, resolveCodexBin, detectCodex, isCodexQuotaError,
  classifyCodexError, isValidThreadId, parseWriteMarkers, hasWindowsSandboxConfig,
  findCodexThreadFile,
};
