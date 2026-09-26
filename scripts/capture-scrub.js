'use strict';
// Scrub a runtime capture of the person who took it, before it is written.
//
// The truth captures (scripts/stream-truth, scripts/transcript-truth) record
// the real runtime verbatim so that a format change shows as a diff, and they
// are committed to a public repository. The runtime writes the person into
// what it records: their email in its system context, their home directory
// and username in paths, the per-user temporary directory the run's workspace
// sits in, and, since 2.1.281, their organisation's id. None of that is the
// format, so each is replaced with a fixed placeholder, the same way every
// time, so a re-capture still differs only where the runtime changed.
//
// The machine's own values (HOME, the username, the temporary directory) are
// replaced exactly, in both their plain and their encoded spelling (the runtime
// names a project folder after its path with every '/' and '.' made '-'). The
// patterns in scripts/personal-data.js are then applied as a backstop, so a
// value from another machine is caught too, and whatever is written passes the
// same check the repository applies to every file.

const fs = require('node:fs');
const os = require('node:os');
const { emailAllowed, PLACEHOLDER_NAMES } = require('./personal-data.js');

// Absolute paths that name nobody, so a reader that needs an absolute path
// still gets one, and the repository's own check passes them.
const PLACEHOLDERS = {
  email: ['someone', 'example.com'].join('@'),
  home: ['', 'Users', 'me'].join('/'),
  user: 'me',
  tmp: ['', 'tmp', 'capture'].join('/'),
  uuid: '00000000-0000-0000-0000-000000000000',
  session: '00000000-0000-4000-8000-000000000000',
  emailBlock: 'The account email is removed from this capture.',
};

// The runtime's encoding of a path into a project folder name.
const encodePath = (p) => p.replace(/[/.]/g, '-');
const ENCODED = { home: encodePath(PLACEHOLDERS.home), tmp: encodePath(PLACEHOLDERS.tmp) };

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const replaceAll = (text, value, withWhat) => (value ? text.split(value).join(withWhat) : text);

function machineValues() {
  const tmp = os.tmpdir().replace(/\/$/, '');
  let realTmp = tmp;
  try { realTmp = fs.realpathSync(tmp); } catch { /* the plain spelling is enough */ }
  let user = '';
  try { user = os.userInfo().username; } catch { user = process.env.USER || ''; }
  return { home: os.homedir(), user, tmps: [...new Set([realTmp, tmp])] };
}

/**
 * The capture text, scrubbed. `values` defaults to this machine's own and is
 * passed explicitly by the tests.
 */
function scrubCapture(text, values = machineValues()) {
  let out = String(text);

  // The runtime's account email block, whole: the address and the lines of
  // instruction that exist only because of it.
  out = out.replace(/The user's email address is [^\n\\"]*?unless the user explicitly asks\./g, PLACEHOLDERS.emailBlock);

  // The run's own session id, everywhere it appears (field, lines, file
  // names), so the capture names no session of the account that ran it.
  // Every other identifier in a line is left alone.
  for (const id of values.sessionIds || []) out = replaceAll(out, id, PLACEHOLDERS.session);

  // Emails first, before a username inside one is rewritten out of shape.
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    (m) => (emailAllowed(m) ? m : PLACEHOLDERS.email));

  // This machine's temporary directory, longest spelling first, plain and encoded.
  const tmps = [...(values.tmps || [])].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const t of tmps) out = replaceAll(replaceAll(out, t, PLACEHOLDERS.tmp), encodePath(t), ENCODED.tmp);

  // This machine's home directory, plain and encoded.
  if (values.home) out = replaceAll(replaceAll(out, values.home, PLACEHOLDERS.home), encodePath(values.home), ENCODED.home);

  // The backstop, for values from any machine: a macOS per-user temporary
  // directory, plain and encoded; a home directory with a name in it, plain
  // and encoded; an identifier key carrying a UUID.
  out = out.replace(/\/private\/var\/folders\/[A-Za-z0-9_+]{2}\/[A-Za-z0-9_+]{20,}\/T/g, PLACEHOLDERS.tmp);
  out = out.replace(/\/var\/folders\/[A-Za-z0-9_+]{2}\/[A-Za-z0-9_+]{20,}\/T/g, PLACEHOLDERS.tmp);
  out = out.replace(/-(?:private-)?var-folders-[A-Za-z0-9_+]{2}-[A-Za-z0-9_+]{20,}-T/g, ENCODED.tmp);
  out = out.replace(/\/(Users|home)\/([A-Za-z0-9._-]+)(?=\/)/g, (m, root, name) => (PLACEHOLDER_NAMES.has(name) ? m : PLACEHOLDERS.home));
  out = out.replace(/-(Users|home)-([A-Za-z0-9_]+)(?=-)/g, (m, root, name) => (PLACEHOLDER_NAMES.has(name) ? m : ENCODED.home));
  out = out.replace(
    /((?:\\?["'])?(?:organi[sz]ation|account|org|user|member)[_-]?(?:uuid|id)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    (m, key) => `${key}${PLACEHOLDERS.uuid}`,
  );

  // The username anywhere left, when it is long enough to be unambiguous and
  // is not itself a placeholder.
  if (values.user && values.user.length >= 4 && !PLACEHOLDER_NAMES.has(values.user)) {
    out = out.replace(new RegExp(escape(values.user), 'g'), PLACEHOLDERS.user);
  }
  return scrubConnectors(out);
}

// THE CONNECTED SERVICES. The runtime lists every MCP tool the session can
// reach, each named for the service it belongs to, and carries each service's
// own instructions and the installed skills, so a capture names what the
// person who took it has connected. None of that is the format, and nothing
// the truth checks compare reads it (they read tool calls and file changes),
// so each is replaced with a numbered placeholder: a service becomes
// `connector_N` and its tools `tool_M`, numbered by first appearance, so the
// count and shape stay and a re-capture still shows a change in them. A
// service's display name becomes `connector N`, its instructions keep only
// their heading, and a skill becomes `skill_K` with its description removed.
// Placeholders already in that form are kept, so scrubbing is stable.
const MCP_TOOL = /mcp__[A-Za-z0-9_-]+/g;
const PLACEHOLDER_TOOL = /^mcp__connector_\d+__(?:tool_\d+)?$/;
const REMOVED_INSTRUCTIONS = "(this connector's instructions are removed from this capture)";
const REMOVED_SKILL = '(description removed from this capture)';

function connectorNumbering() {
  const servers = new Map();
  let next = 1;
  const numberOf = (server) => {
    if (!servers.has(server)) servers.set(server, { n: next++, tools: new Map() });
    return servers.get(server);
  };
  return {
    // Reserve the numbers a scrubbed capture already uses, so new names never
    // collide with them.
    reserve(text) {
      for (const m of text.matchAll(/mcp__connector_(\d+)__/g)) next = Math.max(next, Number(m[1]) + 1);
    },
    tool(token) {
      if (PLACEHOLDER_TOOL.test(token)) return token;
      const parts = token.slice('mcp__'.length).split('__');
      const entry = numberOf(parts[0]);
      if (parts.length === 1) return `mcp__connector_${entry.n}`;
      const tool = parts.slice(1).join('__');
      if (!tool) return `mcp__connector_${entry.n}__`;
      if (!entry.tools.has(tool)) entry.tools.set(tool, entry.tools.size + 1);
      return `mcp__connector_${entry.n}__tool_${entry.tools.get(tool)}`;
    },
    display(name) {
      return `connector ${numberOf(name.replace(/[^A-Za-z0-9-]/g, '_')).n}`;
    },
  };
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn);
    return out;
  }
  return value;
}

function scrubConnectors(text) {
  const numbering = connectorNumbering();
  numbering.reserve(text);
  let capture;
  try { capture = JSON.parse(text); } catch { capture = null; }
  if (!capture || typeof capture !== 'object' || !Array.isArray(capture.lines)) {
    return text.replace(MCP_TOOL, (m) => numbering.tool(m));
  }
  const holders = [capture, ...(Array.isArray(capture.subagents) ? capture.subagents : [])];
  const parsed = holders.map((h) => (Array.isArray(h.lines) ? h.lines.map((l) => JSON.parse(l)) : []));
  // What the runtime names as services, instructions and skills, read from
  // the lines that carry them, before anything is rewritten.
  const displays = new Set();
  const blocks = new Set();
  const skills = [];
  for (const entries of parsed) {
    for (const e of entries) {
      const a = e && e.attachment;
      if (!a) continue;
      if (a.type === 'mcp_instructions_delta') {
        for (const n of a.addedNames || []) if (typeof n === 'string') displays.add(n);
        for (const b of a.addedBlocks || []) if (typeof b === 'string') blocks.add(b);
      }
      if (a.type === 'deferred_tools_delta') {
        for (const key of ['pendingMcpServers', 'needsAuthMcpServers', 'failedMcpServers']) {
          for (const n of a[key] || []) if (typeof n === 'string') displays.add(n);
        }
      }
      if (a.type === 'skill_listing') for (const n of a.names || []) if (typeof n === 'string' && !/^skill_\d+$/.test(n) && !skills.includes(n)) skills.push(n);
    }
  }
  // Tools are numbered in the order they first appear in the whole capture.
  for (const m of text.matchAll(MCP_TOOL)) numbering.tool(m[0]);
  const byLength = (a, b) => b.length - a.length;
  const blockList = [...blocks].sort(byLength);
  const displayList = [...displays].filter((n) => n.length >= 4 && !/^(?:connector \d+|skill_\d+)$/.test(n)).sort(byLength);
  const skillList = [...skills].sort(byLength);
  const rewrite = (str) => {
    let s = str;
    for (const b of blockList) {
      const heading = /^## (.+)$/m.exec(b);
      const name = heading ? heading[1] : '';
      s = s.split(b).join(`## ${name}\n${REMOVED_INSTRUCTIONS}`);
    }
    // Skills before service names: a skill can share a service's name.
    for (const n of skillList) {
      const k = `skill_${skills.indexOf(n) + 1}`;
      s = s.replace(new RegExp(`(^|\\n)- ${escape(n)}:[^\\n]*`, 'g'), `$1- ${k}: ${REMOVED_SKILL}`);
      // A name that is also a service's is written as that service.
      if (s === n && !displays.has(n)) s = k;
    }
    s = s.replace(MCP_TOOL, (m) => numbering.tool(m));
    for (const n of displayList) s = s.split(n).join(numbering.display(n));
    return s;
  };
  holders.forEach((h, i) => {
    if (Array.isArray(h.lines)) h.lines = parsed[i].map((e) => JSON.stringify(mapStrings(e, rewrite)));
  });
  return `${JSON.stringify(capture, null, 2)}\n`;
}

module.exports = { scrubCapture, scrubConnectors, PLACEHOLDERS, encodePath, machineValues };
