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
// else rests on. The run tells the agent tool which session to be, by passing
// its own id as --session-id at the spawn, and the tool names the transcript
// for that session. So the file is found by an identity the run chose, never
// by which file changed last: "the most recent transcript" would answer a
// question nobody asked with a plausible list of somebody else's files, and
// nothing downstream could tell.
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
const FILE_TOOLS = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

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

// A run whose changes cannot be established says so, and says why. The list
// is NULL rather than empty, so nothing downstream can mistake not knowing
// for a run that changed nothing: an empty array is an answer, and this is
// the absence of one.
function unknown(reason) {
  return { status: 'unknown', reason, files: null, activity: null };
}

// What a write turned out to be. Taken from the outcome the tool reported
// rather than from the name of the tool that asked, because the same Write
// call creates a file or overwrites one depending on what was already there.
// A write whose outcome named neither is recorded as 'changed': the file was
// written, and claiming to know which of the two would be a guess.
function changeOf(tool, result) {
  const type = result && typeof result === 'object' ? result.type : null;
  if (type === 'create') return 'created';
  if (type === 'update') return 'edited';
  return tool === 'Write' ? 'changed' : 'edited';
}

/**
 * Read one run's transcript.
 *
 * Returns `{ status, reason, files, activity }`. `status` is 'known' when the
 * transcript was found and understood, and 'unknown' otherwise, with `reason`
 * naming which: no session at all, no transcript on disk, a file that could
 * not be read, or a shape this reader does not recognise.
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
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        activity = { kind: 'text', text: block.text.trim(), at: entry.timestamp || null };
      } else if (block.type === 'tool_use') {
        const field = FILE_TOOLS[block.name];
        const declared = field && block.input ? block.input[field] : null;
        activity = { kind: 'tool', tool: block.name, path: typeof declared === 'string' ? declared : null, at: entry.timestamp || null };
        if (typeof declared === 'string' && declared) {
          asked.set(block.id, { tool: block.name, path: declared, at: entry.timestamp || null });
        }
      } else if (block.type === 'tool_result') {
        const call = asked.get(block.tool_use_id);
        if (!call) continue;
        asked.delete(block.tool_use_id);
        // THE WHOLE REASON THIS READS THE OUTCOME. The ask for a write that
        // was refused is identical to the ask for one that worked. Only this
        // line says which happened, and a run that lists what it tried to
        // write is not a run that lists what it changed.
        if (block.is_error) continue;
        const result = entry.toolUseResult;
        const reported = result && typeof result === 'object' && typeof result.filePath === 'string' ? result.filePath : null;
        files.push({
          path: reported || call.path,
          tool: call.tool,
          change: changeOf(call.tool, result),
          at: call.at,
          source: 'transcript',
        });
      }
    }
  }

  if (!understood) return unknown('unrecognized');
  return { status: 'known', reason: null, files, activity };
}

module.exports = { readSessionTranscript };
