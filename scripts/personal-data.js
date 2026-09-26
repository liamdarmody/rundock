'use strict';
// Personal data must never ship in the public repository: not in a tracked
// file, not in a commit message, not in a pull request body.
//
// scripts/check-internal-refs.js applies these rules to every tracked text
// file with no path exemption, including the captured runtime artefacts, the
// vendored bundles, the lockfile and this file itself, and to commit messages
// and pull request bodies in its --message mode. The line marker that excuses
// a planning reference does not excuse these.
//
// The rules are written so that this file's own source never matches them:
// every pattern is assembled from pieces, and nothing below spells a real
// address, home path or token. The specimens that prove each rule are built at
// run time in test/unit/personal-data.test.js for the same reason.
//
// What passes, and why, is stated beside each rule. Anything else that matches
// is to be removed or replaced with a placeholder, never excused.

const AT = '@';

// An email address, any domain.
const EMAIL = new RegExp(`[A-Za-z0-9._%+-]+${AT}[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}`, 'g');

// Addresses that identify no person:
//   - the reserved example and test domains (RFC 2606 and RFC 6761), which
//     exist so documentation and tests have addresses that reach nobody;
//   - GitHub's per-user no-reply addresses;
//   - the co-author trailer's no-reply address.
const RESERVED_DOMAIN = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/i;
const NOREPLY = [
  new RegExp(`${AT}users\\.noreply\\.github\\.com$`, 'i'),
  new RegExp(`^noreply${AT}anthropic\\.com$`, 'i'),
];
// Addresses that third-party code or registry text we ship verbatim carries,
// and must carry: a licence notice that its licence requires us to keep, and
// the npm registry's own deprecation text, which the lockfile records as the
// registry wrote it. Listed by exact value, each with where it comes from, so
// this can only name those addresses and nothing a person here could add.
const UPSTREAM = new Set([
  ['hello', 'joshgoebel.com'].join(AT), // the highlight.js licence notice (public/vendor/highlight)
  ['i', 'izs.me'].join(AT), // npm's deprecation notice for glob 7, recorded in package-lock.json
]);

function emailAllowed(address) {
  const domain = address.slice(address.indexOf(AT) + 1);
  if (RESERVED_DOMAIN.test(domain)) return true;
  if (NOREPLY.some((re) => re.test(address))) return true;
  return UPSTREAM.has(address.toLowerCase());
}

// A home directory with a name in it. Placeholder names that stand for nobody
// pass, so a test or a document can still show the shape of a path; a real
// name, including a first name, does not. The capture scrubber writes a home
// directory as a placeholder with no name in it at all.
const HOME = new RegExp(`/(?:${['Us', 'ers'].join('')}|${['ho', 'me'].join('')})/([A-Za-z0-9._-]+)/`, 'g');
const PLACEHOLDER_NAMES = new Set([
  'me', 'you', 'them', 'someone', 'someone-else', 'user', 'username', 'name', 'x', 'u', 'dev', 'example',
  // Not a name: a dot folder written straight under the root in a test.
  '.claude',
]);

// A Claude Code project directory named after a real path: the runtime names
// each one after the working directory with every '/' and '.' made '-', so a
// home directory's name, or a per-user temporary directory, is carried in it.
// The layout written with placeholders, or after a path that names nobody,
// passes.
const PROJECTS = new RegExp(
  `\\.claude/projects/-(?:(?:private-)?var-folders-|(?:${['Us', 'ers'].join('')}|${['ho', 'me'].join('')})-([A-Za-z0-9_]+)-)`,
  'g',
);

// A macOS per-user temporary directory: its middle segment is an identifier
// for the account on that machine.
const MAC_TEMP = new RegExp(`/var/folders/[A-Za-z0-9_+]{2}/[A-Za-z0-9_+]{20,}/`, 'g');

// An account, organisation or user identifier key carrying a UUID, in plain
// text, in JSON, or in JSON written inside a JSON string (escaped quotes).
// The all-zero UUID is the scrubber's placeholder and names nobody.
const QUOTE = `(?:\\\\?["'])?`;
const ID_KEY = new RegExp(
  `${QUOTE}(?:organi[sz]ation|account|org|user|member)[_-]?(?:uuid|id)${QUOTE}\\s*[:=]\\s*${QUOTE}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`,
  'gi',
);
const ZERO_UUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

// Token-shaped strings: API keys, GitHub and Slack tokens, AWS access key
// ids, and private key blocks.
const TOKEN = new RegExp([
  `\\b${'s'}k-[A-Za-z0-9_-]{16,}`,
  `\\bgh[pousr]_[A-Za-z0-9]{20,}`,
  `\\bgithub_pat_[A-Za-z0-9_]{20,}`,
  `\\bxox[abprs]-[A-Za-z0-9-]{10,}`,
  `\\b${'AK'}IA[0-9A-Z]{16}\\b`,
  `-----BEGIN [A-Z ]*${'PRIVATE'} KEY-----`,
].join('|'), 'g');

// A link to a Claude Code session. It opens only for the account that ran it,
// names that account's work, and has no place in a public commit.
const SESSION_LINK = new RegExp(`claude\\.ai/code/${'session'}_[A-Za-z0-9]`, 'g');

// A connected service named in a runtime capture. The runtime lists every MCP
// tool the session can reach, each named for its service, so a capture names
// what the person who took it has connected. The scrubber writes them as
// numbered placeholders (scripts/capture-scrub.js); in a capture, anything
// else is a finding. Checked only in captures, because the code and its tests
// name MCP tools on purpose.
const CAPTURE_FILE = /^scripts\/[a-z-]+\/captured-[a-z-]+\.json$/;
const MCP_NAME = new RegExp(`${'mcp'}__[A-Za-z0-9_-]+`, 'g');
const MCP_PLACEHOLDER = /^mcp__connector_\d+(?:__(?:tool_\d+)?)?$/;
const CONNECTOR_DISPLAY = new RegExp(`claude\\.ai [A-Z][A-Za-z]`, 'g');

const PERSONAL_RULES = [
  { label: 'email address (use a reserved example domain)', re: EMAIL, allowed: emailAllowed },
  { label: 'home directory with a name in it (use a placeholder)', re: HOME, allowed: (m, g1) => PLACEHOLDER_NAMES.has(g1) },
  { label: 'Claude Code project directory for a real path', re: PROJECTS, allowed: (m, name) => name !== undefined && PLACEHOLDER_NAMES.has(name) },
  { label: 'per-user temporary directory', re: MAC_TEMP },
  { label: 'account or organisation identifier', re: ID_KEY, allowed: (m, uuid) => ZERO_UUID.test(uuid) },
  { label: 'token-shaped secret', re: TOKEN },
  { label: 'Claude Code session link', re: SESSION_LINK },
  { label: 'connected service named in a capture (scrub it)', re: MCP_NAME, appliesTo: CAPTURE_FILE, allowed: (m) => MCP_PLACEHOLDER.test(m) },
  { label: 'connected service named in a capture (scrub it)', re: CONNECTOR_DISPLAY, appliesTo: CAPTURE_FILE },
];

// What a finding shows: its first two characters and its length, so a reader
// can find it and a public CI log does not republish it.
function mask(value) {
  return `${value.slice(0, 2)}${'*'.repeat(Math.max(0, Math.min(value.length - 2, 12)))} (${value.length} characters)`;
}

// Every personal-data hit on every line of `text`.
function scanPersonal(label, text, { skipHashComments = false } = {}) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (skipHashComments && line.startsWith('#')) return;
    for (const rule of PERSONAL_RULES) {
      if (rule.appliesTo && !rule.appliesTo.test(label)) continue;
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        if (rule.allowed && rule.allowed(m[0], m[1])) continue;
        out.push({ file: label, line: i + 1, label: rule.label, match: mask(m[0]), text: '(the line is not printed: it carries personal data)' });
      }
    }
  });
  return out;
}

module.exports = { PERSONAL_RULES, scanPersonal, emailAllowed, mask, PLACEHOLDER_NAMES };
