'use strict';
// THE LINE AN AGENT IS GIVEN WHEN AN ACTION IS REFUSED: stop, and ask.
//
// Without it, a refusal reads to the agent as an obstacle, and it improvises:
// another command for the same copy, the same command with the sandbox off,
// the same file through a different tool. Each attempt is another card, or
// another block, and every one of them is paid for. The person said no, or
// the workspace's settings did, and what they wanted next was a question.
//
// One wording for every runtime, so a Claude Code agent and a Codex agent are
// told the same thing. It says what was refused and that the refusal was
// deliberate, and never how to get round it. It is short on purpose: it is
// sent on every refusal.
//
// Lives in scripts/ because the permission hook requires it and only scripts/
// is unpacked beside the hook in the packaged app.

const WHAT = {
  denied: (subject) => `The person refused ${subject}.`,
  timeout: (subject) => `No one answered the request for ${subject} in time, so it was refused.`,
  sandbox: (subject) => `The workspace's sandbox settings blocked ${subject}.`,
};

function subjectFor(toolName) {
  if (toolName === 'Bash' || toolName === 'PowerShell') return 'this command';
  return typeof toolName === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(toolName) ? `this ${toolName} call` : 'this action';
}

// `kind` is 'denied', 'timeout' or 'sandbox'. Anything else is no refusal,
// and gets no line.
function refusalNotice(kind, toolName) {
  const what = Object.prototype.hasOwnProperty.call(WHAT, kind) ? WHAT[kind] : null;
  if (!what) return null;
  return `${what(subjectFor(toolName))} The refusal is deliberate: do not retry it or try another way. Stop and ask the person what to do.`;
}

// A shell command the sandbox refused, read from what the runtime reported
// back. The runtime marks its own sandbox refusals with a tag, which is
// decisive. The operating system's "Operation not permitted" counts only
// where Rundock itself turns the sandbox on (Knowledge mode, on macOS) and
// only for a command that ran inside it: anywhere else it came from something
// other than the workspace's settings, and the agent would be told a reason
// that is not true.
const SANDBOX_TAG = '<sandbox_violations>';
const NOT_PERMITTED = /operation not permitted/i;
function sandboxBlocked(toolName, toolInput, text, { codeMode = false, platform = process.platform } = {}) {
  if (toolName !== 'Bash') return false;
  const out = typeof text === 'string' ? text : '';
  if (out.includes(SANDBOX_TAG)) return true;
  if (codeMode || platform !== 'darwin') return false;
  const sandboxOff = !!(toolInput && toolInput.dangerouslyDisableSandbox === true);
  return !sandboxOff && NOT_PERMITTED.test(out);
}

module.exports = { refusalNotice, sandboxBlocked };
