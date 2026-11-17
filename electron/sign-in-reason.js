// Why the desktop's sign-in check failed, as one line safe to show.
//
// The wizard decides whether Claude Code is signed in by running a one-word
// turn and reading only whether it succeeded. When it fails for a reason that
// signing in again cannot fix (a token Claude Code cannot refresh, a usage
// limit, a network error), the person is left looping on sign-in with nothing
// said. This turns the failed check into one answer the wizard can show:
// Claude Code's own first line, or a fixed kind when the check ran out of
// time, could not start, or printed nothing usable.
//
// The output is text Rundock did not write, and an agent able to change the
// person's Claude Code settings can choose it. So before it leaves the main
// process it is cut to one line, its escape sequences, control characters and
// direction controls are removed, anything shaped like a credential is
// replaced, and it is capped. Control and direction characters go before the
// credentials are looked for, so one placed inside a key cannot split it past
// the match and then vanish. The raw output is never kept, logged or returned.
//
// Pure of Electron. The cleaner is reached through `deps`, which tests replace
// in-process.

'use strict';

const MAX_CHARS = 300;
const HIDDEN = '[hidden]';

// CSI and OSC sequences (an OSC ends at BEL, ST or the line's end), the
// one-byte C1 CSI, and the other two- and three-character escapes.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)?|\u009b[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// A labelled secret keeps its label, so the line still says what was refused.
const LABELLED = /(?<![A-Za-z0-9])(bearer\s+|(?:x-api-key|anthropic_api_key|claude_code_oauth_token)["']?\s*[:=]\s*["']?)[^\s"']+/gi;
const SK_KEY = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]+/g;
const LONG_RUN = /[A-Za-z0-9_-]{32,}/g;

const SIGN_IN_WORDS = /authenticat|oauth|log in|login|logged in|expired|credential|unauthori|401|invalid api key/i;

function redact(text) {
  return text.replace(LABELLED, `$1${HIDDEN}`).replace(SK_KEY, HIDDEN).replace(LONG_RUN, HIDDEN);
}

function cut(text) {
  const chars = Array.from(text);
  return chars.length > MAX_CHARS ? chars.slice(0, MAX_CHARS - 1).join('') + '\u2026' : text;
}

function cleanLine(raw) {
  const text = String(raw)
    .replace(ANSI, '')
    .replace(/\t/g, ' ')
    .replace(CONTROL, '')
    .replace(BIDI, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cut(redact(text));
}

const deps = { clean: cleanLine };

function firstLine(stream) {
  if (stream == null) return '';
  const text = Buffer.isBuffer(stream) ? stream.toString('utf8') : String(stream);
  for (const raw of text.replace(ANSI, '').split('\n')) {
    const line = deps.clean(raw);
    if (line) return line;
  }
  return '';
}

const readsAsSignIn = (line) => SIGN_IN_WORDS.test(line);

// The answer for one failed check, as execSync throws it. Never throws.
function reasonFor(err) {
  try {
    if (!err || typeof err !== 'object') return { kind: 'no-reason' };
    if (err.code === 'ETIMEDOUT') return { kind: 'timeout' };
    if (err.code === 'ENOENT' || err.status === 127) return { kind: 'not-started' };
    const text = firstLine(err.stderr) || firstLine(err.stdout);
    return text ? { kind: 'said', text, signIn: readsAsSignIn(text) } : { kind: 'no-reason' };
  } catch {
    return { kind: 'no-reason' };
  }
}

// The last check's reason, kept beside a check that still answers only true
// or false, so the routing that retries a failed check reads it unchanged.
function createSignInReason() {
  let last = null;
  return {
    passed() { last = null; },
    failed(err) { last = reasonFor(err); },
    last: () => last,
  };
}

module.exports = { deps, MAX_CHARS, cleanLine, reasonFor, readsAsSignIn, createSignInReason };
