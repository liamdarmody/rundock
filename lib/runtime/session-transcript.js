'use strict';
// What a Claude run did, read from the session transcript it leaves on disk.
//
// WHY THE TRANSCRIPT AND NOT THE RUN'S OUTPUT. A routine's stdout and stderr
// are handed to the null device at the spawn, deliberately and recently: an
// unread pipe fills and the child stops for good (see the comment at the spawn
// in lib/scheduler.js). Reading the transcript needs nothing from the spawn,
// so that stays as it is. It also survives a restart mid-run, which for an
// unattended routine at five in the morning is the ordinary case. And it is
// the only source that records whether a write SUCCEEDED rather than only
// that the agent asked for one: the live stream carries the ask, and a list
// of attempted writes is not a list of files changed.
//
// WHAT TIES ONE TRANSCRIPT TO ONE RUN, which is the assumption everything
// else rests on. A run allocates a session id of its OWN, distinct from its
// run id, records it, and passes it as --session-id at the spawn; the tool
// names the transcript for that session. So the file is found by an identity
// the run chose, taken from the run's record and never assumed to be the run's
// id, and never by which file changed last: "the most recent transcript" would
// answer a question nobody asked with a plausible list of somebody else's
// files, and nothing downstream could tell.
//
// The directory holding it is named for the working directory the run
// happened in, by a rule this project does not own and has not established
// (slashes, dots and spaces all become dashes, as far as anything here has
// observed). So the directory is SEARCHED rather than computed: the session
// id is a uuid, so a scan for it is exact, and an encoding rule that was
// wrong would be a silent miss. It costs one directory listing per lookup, on
// an event that happens once per run.
//
// NOTHING HERE THROWS. Every caller is on the unattended path, one of them
// inside the handler that ends a run, so a transcript that cannot be read
// must cost the reading and never the run.
const fs = require('fs');
const path = require('path');

// The tools that change a file, and the input field each names it in. Both
// notebook and multi-file editors are here because the permission hook's own
// matcher includes them; the chat-side detector omits them, which is a gap
// rather than a precedent.
//
// DECLARED ONCE, HERE, AND EXPORTED. This map and the block-type set below are
// the reader's whole account of the format, and they used to be restated by
// the truth harness and again by the test fixtures. Three copies of one rule
// is three places to update and two places to forget: add a tool and the
// capture, the invariant check and the fixtures would all quietly stop
// covering it while continuing to pass. Everything that needs to know now
// imports them, and scripts/transcript-truth/truth.js additionally requires
// every tool named here to be either witnessed by the committed capture or
// listed as unwitnessed with a reason, so a new tool cannot narrow the
// coverage in silence.
// `input` is where the ASK names the file, `result` where the OUTCOME names
// it. They differ, which was found by capturing a real notebook edit rather
// than by reasoning: every other tool reports `filePath` and NotebookEdit
// reports `notebook_path`, so a reader that assumed one field silently
// refused to account for every notebook a run touched.
const FILE_TOOLS = {
  Write: { input: 'file_path', result: 'filePath' },
  Edit: { input: 'file_path', result: 'filePath' },
  MultiEdit: { input: 'file_path', result: 'filePath' },
  NotebookEdit: { input: 'notebook_path', result: 'notebook_path' },
};

// Every content block this reader knows how to meet. It is the repository's
// own declared union (ContentBlock in types.d.ts), which
// test/unit/session-transcript-capture.test.js holds it to, and the committed
// capture contains exactly these four and nothing else.
//
// WHY AN UNKNOWN BLOCK TYPE IS DRIFT RATHER THAN SOMETHING TO SKIP. This
// reader's whole promise is that a file list can be trusted, and the way it
// could quietly stop being true is a rename: call a tool_use something else
// and every write becomes invisible, leaving a confident, empty, WRONG list.
// Skipping what it does not recognise makes that failure silent; refusing to
// vouch for the file makes it loud. The cost is that a genuinely new block
// type turns a run's list into 'unknown' until this set is updated, which is
// the safe direction and is exactly the day the capture should be re-run.
const KNOWN_BLOCK_TYPES = new Set(['text', 'thinking', 'tool_use', 'tool_result']);

// Tools that hand work to another agent, whose changes are recorded somewhere
// this reader cannot account for.
//
// ESTABLISHED BY CAPTURE, and the capture said something nobody had assumed. A
// delegated subagent gets a transcript of its OWN, filed under a directory
// named for the session beside the session's own transcript, and its outcome
// entries carry no `toolUseResult` at all: where the session's transcript
// answers a write with an object naming the path and whether the file was
// created or overwritten, a subagent's answers with an English sentence inside
// the result block and nothing else. So the ASK is legible and the OUTCOME is
// not, and deciding a file was created by reading a sentence is exactly the
// unverified guess this module refuses everywhere else.
//
// The consequence is stated rather than papered over: a run that delegated
// work which touched files reports that it does not know. A delegation that
// touched none leaves the parent's list alone, so this is a finding about the
// evidence and not a blanket refusal to answer whenever an Agent appears.
const DELEGATION_TOOLS = new Set(['Agent']);

// Read at CALL time, not at load, so a process whose home moves (and a test
// pointing at a disposable one) is answered from where it is now.
function projectsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home ? path.join(home, '.claude', 'projects') : null;
}

function findTranscript(sessionId) {
  const root = projectsDir();
  if (!root) return null;
  const name = `${sessionId}.jsonl`;
  let dirs;
  try { dirs = fs.readdirSync(root); } catch (e) { return null; }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch (e) { /* not this one */ }
  }
  return null;
}

// Transcripts left by subagents this run delegated to. The runtime files them
// under a directory named for the session, beside the session's own file
// (`<project>/<session-id>/subagents/agent-<id>.jsonl` in the capture).
//
// WALKED RATHER THAN GLOBBED at one fixed depth, because a subagent may
// delegate in turn and nothing witnesses where a second level lands. Anything
// the runtime files under the session's own directory is found either way, and
// finding one too many costs an unknown where the answer was safe: finding one
// too few costs a confident list that is missing a file.
function sidechainTranscripts(file, sessionId) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
    }
  };
  walk(path.join(path.dirname(file), sessionId));
  return found;
}

// Whether a subagent asked to change a file, which is the half of its
// transcript this reader CAN read: the ask names its file in the same field
// the session's own transcript uses.
//
// A transcript that will not open counts as one that did, because the reason
// to look is to find out whether anything was changed out of sight, and a file
// that cannot be read has not answered that.
function sidechainChangedFiles(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch (e) { return true; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (e) { continue; }
    const blocks = entry && entry.message ? entry.message.content : null;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue;
      const field = FILE_TOOLS[block.name] ? FILE_TOOLS[block.name].input : null;
      if (field && block.input && typeof block.input[field] === 'string' && block.input[field]) return true;
    }
  }
  return false;
}

// A run whose changes cannot be established says so, and says why. The list
// is NULL rather than empty, so nothing downstream can mistake not knowing
// for a run that changed nothing: an empty array is an answer, and this is
// the absence of one.
function unknown(reason) {
  return { status: 'unknown', reason, files: null, activity: null };
}

// What a write turned out to be, or null when this reader cannot tell.
//
// Taken from the outcome the tool reported rather than from the name of the
// tool that asked, because the same Write creates a file or overwrites one
// depending on what was already there. Both shapes are in the committed
// capture: a Write reports `type: 'create'` or `'update'` beside the path it
// really wrote, and an Edit reports the path with no type at all, because an
// edit can only ever be an edit.
//
// NULL IS A REAL ANSWER HERE and it travels: a result whose shape this
// reader has never been shown is not a file it may list. Returning a
// plausible default instead is how a list stays confident while becoming
// wrong, which is the one outcome this whole card exists to prevent.
function decipher(tool, result) {
  if (!result || typeof result !== 'object') return null;
  // filePath rather than path: `path` is the module this file joins with two
  // functions above, and a local of that name shadows it.
  const filePath = result[FILE_TOOLS[tool].result];
  if (typeof filePath !== 'string' || !filePath) return null;
  // An outcome that reports its own error, in a field this reader does not
  // otherwise read. Witnessed empty on a notebook edit that worked; what a
  // failed one puts there is unwitnessed, so the file is not claimed as
  // changed. Refusing an outcome that says something went wrong is the safe
  // direction of an unverified guess.
  if (typeof result.error === 'string' && result.error) return null;
  if (result.type === 'create') return { path: filePath, change: 'created' };
  if (result.type === 'update') return { path: filePath, change: 'edited' };
  // No type at all is the edit shape. A Write always reports one, so a Write
  // arriving without it is a shape that has moved.
  if (result.type === undefined && tool !== 'Write') return { path: filePath, change: 'edited' };
  return null;
}

// The outcome payload belonging to one result block.
//
// The runtime writes one result per entry: a parallel batch of writes arrives
// as one API message and the transcript SPLITS it, one line per block, each
// with its own outcome (the capture holds such a batch, its asks sharing a
// single message id, on separate lines). So the ordinary case is exact.
//
// It is resolved rather than assumed because the payload sits on the ENTRY
// while the ask sits on the BLOCK: were two results ever to share one entry,
// reading the entry's payload for each of them would report one file twice
// and lose the other. Where the path is known, it decides; where it cannot,
// this returns undefined and the caller refuses to vouch for the file rather
// than attributing an outcome to the wrong write.
function payloadFor(entry, block, results, asked) {
  if (results.length === 1) return entry.toolUseResult;
  const payloads = Array.isArray(entry.toolUseResult) ? entry.toolUseResult : [entry.toolUseResult];
  const call = asked.get(block.tool_use_id);
  return payloads.find(p => p && typeof p === 'object' && call && p[FILE_TOOLS[call.tool].result] === call.path);
}

/**
 * Read one run's transcript.
 *
 * Returns `{ status, reason, files, activity }`. `status` is 'known' when the
 * transcript was found and understood, and 'unknown' otherwise, with `reason`
 * naming which. Reason codes are machine identifiers, but this one reaches the
 * run record that the run-detail surface will show, so they follow the
 * repository's spelling rather than the library convention: 'no-session' (a runtime that opens none), 'no-transcript'
 * (nothing on disk for it), 'unreadable' (a file that would not open),
 * 'unrecognised' (a shape this reader has not been shown, anywhere in the
 * file), 'unresolved' (a write was asked for and never came back), or
 * 'delegated' (a subagent changed files in a transcript of its own, whose
 * outcomes this reader cannot read).
 *
 * `files` is one entry per file the run really changed, in the order the run
 * changed them, carrying the path, the tool that touched it, whether it was
 * created or edited, when, and where that was learned. An ENTRY rather than a
 * string, because the revert card needs room to hang a backup handle on the
 * same list without changing its shape for everything already reading it.
 *
 * `activity` is the last thing the run was seen doing, which is what makes a
 * run in flight able to say where it has got to. Polled: this reads the file
 * each time it is called and registers for nothing, which is the pattern this
 * codebase already argues for over watching the filesystem.
 */
function readSessionTranscript(sessionId) {
  if (!sessionId) return unknown('no-session');
  const file = findTranscript(sessionId);
  if (!file) return unknown('no-transcript');
  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch (e) { return unknown('unreadable'); }

  const asked = new Map(); // tool_use id -> the file tool call waiting on its outcome
  const files = [];
  let activity = null;
  // Whether this run handed any work to a subagent, which is the parent's own
  // record that changes may have happened where this reader cannot read them.
  let delegated = false;
  // Whether anything in this file was a message at all. A transcript in a
  // shape nobody here knows must not read as a run that did nothing, and the
  // two are indistinguishable by the file list alone.
  let understood = false;

  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (e) { continue; } // a line still being written
    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant') || !entry.message) continue;
    understood = true;
    const blocks = entry.message.content;
    if (!Array.isArray(blocks)) continue; // the prompt itself: a plain string
    const results = blocks.filter(b => b && b.type === 'tool_result');
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      // A block shape nobody here has been shown. Refused rather than
      // skipped: see KNOWN_BLOCK_TYPES for why silence is the dangerous
      // option.
      if (!KNOWN_BLOCK_TYPES.has(block.type)) return unknown('unrecognised');
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        activity = { kind: 'text', text: block.text.trim(), at: entry.timestamp || null };
      } else if (block.type === 'tool_use') {
        const field = FILE_TOOLS[block.name] ? FILE_TOOLS[block.name].input : null;
        const declared = field && block.input ? block.input[field] : null;
        // A file tool whose input no longer names a file. The tool is one this
        // reader is responsible for and it cannot say what it touched, which
        // is drift rather than a tool call to pass over.
        if (field && typeof declared !== 'string') return unknown('unrecognised');
        if (DELEGATION_TOOLS.has(block.name)) delegated = true;
        activity = { kind: 'tool', tool: block.name, path: typeof declared === 'string' ? declared : null, at: entry.timestamp || null };
        if (typeof declared === 'string' && declared) {
          asked.set(block.id, { tool: block.name, path: declared, at: entry.timestamp || null });
        }
      } else if (block.type === 'tool_result') {
        const call = asked.get(block.tool_use_id);
        if (!call) continue; // an outcome for something that touches no file
        // THE WHOLE REASON THIS READS THE OUTCOME. The ask for a write that
        // was refused is identical to the ask for one that worked. Only this
        // line says which happened, and a run that lists what it tried to
        // write is not a run that lists what it changed.
        //
        // The marker is `is_error` on the result block, which the committed
        // capture witnesses on a refused write and types.d.ts declares as a
        // boolean. A marker present in any other type has changed meaning,
        // and this field decides whether a write counts as a change, so it is
        // the last place to be relaxed about what it holds: the string
        // "false" read for truthiness is a refusal, and read strictly is a
        // success. Neither is an answer worth giving, so it is refused.
        //
        // WHICH LINE DOES THE WORK, because the second reads like a guard and
        // is not one. Once the first has run, the only values that can reach
        // the second are undefined, true and false, on which `=== true` and a
        // truthiness test agree exactly. It is written strictly because that
        // is what it means, and a mutation of it turns nothing red: that is
        // the guard above being complete rather than this line being unpinned.
        if (block.is_error !== undefined && typeof block.is_error !== 'boolean') return unknown('unrecognised');
        if (block.is_error === true) { asked.delete(block.tool_use_id); continue; }
        const payload = payloadFor(entry, block, results, asked);
        const outcome = decipher(call.tool, payload);
        // An outcome for a file tool that this reader cannot read. It is not
        // a failure and not a success, so the honest report is that nothing
        // in this transcript can be vouched for.
        if (!outcome) return unknown('unrecognised');
        asked.delete(block.tool_use_id);
        files.push({
          path: outcome.path,
          tool: call.tool,
          change: outcome.change,
          at: call.at,
          source: 'transcript',
        });
      }
    }
  }

  if (!understood) return unknown('unrecognised');
  // A write was asked for and never came back. ONE IS ENOUGH, however many
  // others reported: a list holding only the writes that resolved is a list
  // that omits one the run may well have made, offered with the confidence of
  // a complete one. That is the quietly incomplete list this module exists to
  // prevent, and it is worse than no list because the record is what a later
  // revert acts on.
  //
  // WHAT AN OPEN ASK MEANS depends on when this is read, and the honest answer
  // is the same either way. Read after the run has ended, the child has
  // already exited, so an open ask is a run cut off between the tool writing
  // the file and the runtime recording the outcome (a crash, a kill, an OOM):
  // the file may be on disk and nothing here can tell. Read while the run is
  // in flight, it is a tool that has not finished yet, and the list is simply
  // not settled. Neither is a run that changed only the files that resolved.
  //
  // The activity survives, and only here. This is a transcript that was read
  // and understood in full; what it lacks is outcomes, so the FILE LIST is
  // what cannot be vouched for. A run in flight, inside a write, is exactly
  // this state, and it can still say what it is doing: readRunProgress asks
  // for the activity and never for the list, which is why no separate
  // in-flight mode is needed to keep progress working.
  if (asked.size > 0) return { status: 'unknown', reason: 'unresolved', files: null, activity };
  // WORK HANDED TO A SUBAGENT, checked from both ends because the two ends can
  // move apart. A subagent transcript on disk that asked to change a file is
  // the direct evidence that changes happened out of sight, and it holds even
  // if the delegating tool is renamed. An ask in the parent with no subagent
  // transcript to be found is the same conclusion from the other side: the run
  // handed work to somebody else and this reader has not seen what came of it,
  // which is where a subagent still running and a runtime that files its
  // transcripts somewhere else both land.
  const sidechains = sidechainTranscripts(file, sessionId);
  if (sidechains.some(sidechainChangedFiles) || (delegated && sidechains.length === 0)) {
    return { status: 'unknown', reason: 'delegated', files: null, activity };
  }
  return { status: 'known', reason: null, files, activity };
}

// findTranscript and sidechainTranscripts are exported for the capture
// harness, which has to lay hands on the same files this reader would. A
// private copy of the lookup there restates a search rule this module owns, so
// a change to it could leave the harness pinning a file the product never
// reads.
module.exports = {
  readSessionTranscript, findTranscript, sidechainTranscripts,
  FILE_TOOLS, KNOWN_BLOCK_TYPES, DELEGATION_TOOLS,
};
