'use strict';
// THE LINE AN AGENT IS GIVEN WHEN AN ACTION IS REFUSED: stop, and ask; or, in
// a run nobody can be asked from, carry on without it or say it failed.
//
// Without it, a refusal reads to the agent as an obstacle, and it improvises:
// another command for the same copy, the same command with the sandbox off,
// the same file through a different tool. Each attempt is another card, or
// another block, and every one of them is paid for. The person said no, or
// the workspace's settings did, and what they wanted next was a question.
//
// A routine cannot ask that question. Its output goes nowhere and no reply
// can reach it, so telling one to stop and ask ended the run there, with
// nothing saved, and the run still read as finished. A routine is told
// instead to carry on with the rest of its job, or, when it cannot, to end on
// the one line its run's record reads as a failure (RUN STATUS, in
// docs/ROUTINES.md and declaredOutcome in lib/scheduler.js).
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

// What a run nobody can be asked from does next. The failure line is the
// record's own contract, word for word, so an agent that follows it is read as
// failed with its reason rather than as finished.
const UNATTENDED_NEXT = 'This run has nobody to ask, so carry on with the rest of the job without that step. If you cannot finish without it, make the last line of your final message: RUN STATUS: failed: <one-line reason>';

// The record's failure line, the same words UNATTENDED_NEXT ends with.
const FAILED_LINE = 'RUN STATUS: failed: <one-line reason>';

// WHAT EVERY ROUTINE IS TOLD BEFORE IT STARTS, in its system prompt rather
// than its routine prompt, because a routine prompt is the plan an approval
// was given for and editing it would lapse that approval. The refusal line
// above reaches a routine only once something has been refused; by then a
// run that thought somebody was watching may already have asked a question
// nobody will read and stopped to wait for the answer. This says the same
// thing up front, in the same words where they overlap: nobody can be asked,
// carry on without what was refused, save the work, and end on the line the
// record reads. `RUN STATUS: succeeded` is accepted and changes nothing, so
// a run that finished can say so without risk.
const UNATTENDED_RUN = 'Nobody is watching this run, so nobody can answer a question or approve a step. Do not ask, and do not wait for a reply: work from what you have, and if a step is refused, carry on with the rest of the job without it. Save the work in the workspace as you go. End your final message with the line RUN STATUS: succeeded, or, if you could not finish, make its last line: ' + FAILED_LINE;

// `kind` is 'denied', 'timeout' or 'sandbox'. Anything else is no refusal,
// and gets no line. `unattended` is true only for a run nobody can be asked
// from, a routine's; only a plain true counts, so a stray value keeps a
// conversation's words.
function refusalNotice(kind, toolName, options) {
  const what = Object.prototype.hasOwnProperty.call(WHAT, kind) ? WHAT[kind] : null;
  if (!what) return null;
  const refused = `${what(subjectFor(toolName))} The refusal is deliberate: do not retry it or try another way.`;
  if (options && options.unattended === true) return `${refused} ${UNATTENDED_NEXT}`;
  return `${refused} Stop and ask the person what to do.`;
}

// A REFUSAL BECAUSE THE CHECK ITSELF FAILED (the server could not be reached,
// or its reply never finished), for a call that is never made without asking.
// A conversation keeps the words it had; a routine is told what to do next as
// every other refusal tells it, because it has nobody to ask either way.
function unansweredNotice(reason, options) {
  return options && options.unattended === true ? `${reason} ${UNATTENDED_NEXT}` : reason;
}

// THE LINE AN AGENT IS GIVEN WHEN A PERSON APPROVED A CARD. An approval and a
// question never asked look the same from inside a turn, so an agent that
// reasons from the command having run can tell the person the safety check
// never fired. This turns that inference into a fact. Only for an answer a
// person gave on a card: an allow by a rule or by policy gets no line. Short,
// because it is sent on every approval.
function approvalNotice(toolName) {
  return `The person approved ${subjectFor(toolName)} in Rundock after a permission card.`;
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

module.exports = { refusalNotice, unansweredNotice, approvalNotice, sandboxBlocked, UNATTENDED_NEXT, UNATTENDED_RUN, FAILED_LINE };
