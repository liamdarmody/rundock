'use strict';
// Characterization: conversation transcript persistence (.rundock/transcripts/).
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { makeWorkspace, cleanup, standardTeam } = require('../helpers/workspace.js');

after(cleanup);

let dir;
beforeEach(() => {
  dir = makeWorkspace({ agents: standardTeam() });
  srv.setWorkspace(dir);
  srv.convoTranscripts.clear();
});

function transcriptFile(convoId) {
  return path.join(dir, '.rundock', 'transcripts', `${convoId}.json`);
}

describe('append/load/save transcript', () => {
  test('append persists to disk and loads back after a simulated restart', () => {
    srv.appendTranscript('c1', 'user', 'user', 'hello');
    srv.appendTranscript('c1', 'agent', 'content-lead', 'hi there, here is a draft');
    const onDisk = JSON.parse(fs.readFileSync(transcriptFile('c1'), 'utf-8'));
    assert.strictEqual(onDisk.length, 2);
    assert.strictEqual(onDisk[0].role, 'user');
    assert.strictEqual(onDisk[1].agent, 'content-lead');
    assert.ok(onDisk[1].timestamp);

    // simulate restart: drop in-memory cache, reload from disk
    srv.convoTranscripts.clear();
    const loaded = srv.loadTranscript('c1');
    assert.strictEqual(loaded.length, 2);
    assert.strictEqual(loaded[1].text, 'hi there, here is a draft');
  });

  test('routing-typed entries carry type', () => {
    srv.appendTranscript('c2', 'agent', 'chief-of-staff', '[Read a.md]', 'routing');
    const onDisk = JSON.parse(fs.readFileSync(transcriptFile('c2'), 'utf-8'));
    assert.strictEqual(onDisk[0].type, 'routing');
  });

  test('missing transcript loads as empty array', () => {
    assert.deepStrictEqual(srv.loadTranscript('nope'), []);
  });

  test('soft cap: at 1000 entries the SECOND entry is evicted (index 1), first is kept', () => {
    const t = [];
    for (let i = 0; i < 1000; i++) t.push({ role: 'user', agent: 'user', text: `m${i}` });
    srv.convoTranscripts.set('c3', t);
    srv.appendTranscript('c3', 'user', 'user', 'overflow');
    const after_ = srv.convoTranscripts.get('c3');
    assert.strictEqual(after_.length, 1000);
    assert.strictEqual(after_[0].text, 'm0', 'first entry retained');
    assert.strictEqual(after_[1].text, 'm2', 'index 1 evicted');
    assert.strictEqual(after_[999].text, 'overflow');
  });

  test('recovery: a truncated array with a partial trailing object salvages the complete leading ones', () => {
    // Truncation mid-key on the second object cannot be auto-closed, so the
    // complete-object salvage keeps only the first entry.
    fs.mkdirSync(path.dirname(transcriptFile('rec1')), { recursive: true });
    fs.writeFileSync(transcriptFile('rec1'), '[{"role":"user","agent":"user","text":"one"},{"role":"agent","ag');
    const loaded = srv.loadTranscript('rec1');
    assert.strictEqual(loaded.length, 1, 'one complete object recovered');
    assert.strictEqual(loaded[0].text, 'one');
  });

  test('recovery: unrecoverable garbage loads as empty (does not throw)', () => {
    fs.mkdirSync(path.dirname(transcriptFile('rec2')), { recursive: true });
    fs.writeFileSync(transcriptFile('rec2'), 'not json at all {{{');
    assert.deepStrictEqual(srv.loadTranscript('rec2'), []);
  });

  test('a corrupt (truncated) transcript is salvaged, not wiped, on the next append', () => {
    // Post-fix behavior: loadTranscript recovers as much history as possible
    // from a truncated file, so appendTranscript preserves it rather than
    // overwriting with only the new entry. Regression companion in regression.test.js.
    fs.mkdirSync(path.dirname(transcriptFile('c4')), { recursive: true });
    fs.writeFileSync(transcriptFile('c4'), '[{"role":"user","text":"old history"'); // truncated JSON
    srv.appendTranscript('c4', 'user', 'user', 'new message');
    const onDisk = JSON.parse(fs.readFileSync(transcriptFile('c4'), 'utf-8'));
    assert.strictEqual(onDisk.length, 2, 'salvaged prior entry + new entry');
    assert.strictEqual(onDisk[0].text, 'old history', 'prior history recovered');
    assert.strictEqual(onDisk[1].text, 'new message');
  });
});


// ---------------------------------------------------------------------------
// ONE WAY TO DROP A TOOL SUMMARY.
//
// A turn is stored as Rundock's summary of the tools it ran, a newline, then
// what the agent wrote. The rebuilder dropped that prefix with
// `^(\[.*?\]\s*)+`, which stops at the FIRST `]`. A real turn ran
// `grep -o '<title>[^<]*</title>'`, whose bracket closes the group early, so
// the reader was shown this as the agent's words:
//
//   *</title>' "$TMPDIR/rundock_home.html"; ] [Bash grep -io ... ] [Agent]
//
// The same expression builds the prefix the rebuilder looks a turn up by in the
// Claude session, so the lookup was handed garbage, found nothing, and fell
// back to the same broken strip. One cause, both symptoms.
//
// The fixtures below carry the REAL command. A tidied one would not fail
// against the old code, which is the whole reason this went unnoticed.
// ---------------------------------------------------------------------------
// The reported line and the words after it, VERBATIM from the transcript and
// shared by every test below. A shortened stand-in is not the evidence: with a
// tidied summary the old regex leaves little enough garbage that the real words
// still fit the matcher's 100-character window, so the test passes either way.
const REPORTED_SUMMARY = "[ToolSearch] [WebFetch https://rundock.ai] [Bash curl -sL -A \"Mozilla/5.0\" https://rundock.ai -o \"$TMPDIR/run] [Bash grep -o '<title>[^<]*</title>' \"$TMPDIR/rundock_home.html\"; ] [Bash grep -io '.\\{80\\}chatbot gives you a team.\\{80\\}' \"$TMPDIR/r] [Grep /Users/liamdarmody/Documents/Rundock/Test/.rundock/scratch/rundock_home.html] [Read /Users/liamdarmody/Documents/Rundock/Test/.rundock/scratch/rundock_home.html] [Bash rm -f \"$TMPDIR/rundock_home.html\"] [Agent]";
const WORDS = "Now let's check the nav bar section, above the hero.";

describe('a tool summary is dropped whatever its commands contain', () => {
  const { stripToolSummaryPrefix } = require('../../lib/store/transcripts.js');
  // VERBATIM, copied from the transcript rather than retyped. The reported line
  // carries seven groups, two of them truncated mid-command by the summary
  // builder, and one of those truncations is where the stray bracket lives.
  // A shortened version still fails against the old code, but a shortened
  // version is not the evidence: simplifying a fixture is how it stops being
  // the thing that was measured.

  test('the reported turn keeps its words and loses all of its summary', () => {
    const stored = `${REPORTED_SUMMARY}\n${WORDS}`;
    assert.strictEqual(stripToolSummaryPrefix(stored), WORDS,
      'nothing of the summary survives in front of what the agent wrote');
    assert.ok(!stripToolSummaryPrefix(stored).includes('</title>'),
      'and specifically not the fragment the reader was shown');
  });

  test('the prefix the rebuilder looks a turn up by is the agent\'s real words', () => {
    // The half that made this more than cosmetic: given a garbled prefix the
    // session lookup matched nothing, so a turn fell back instead of rendering
    // from the session at all.
    const stored = `${REPORTED_SUMMARY}\n${WORDS}`;
    const prefix = stripToolSummaryPrefix(stored).trim().substring(0, 100);
    assert.ok(WORDS.substring(0, 100).includes(prefix.substring(0, 60)),
      'the lookup searches with the words the session actually holds');
  });

  test('text that is not a summary keeps every character', () => {
    for (const notSummary of [
      '[not a summary because prose follows] and here it is',
      'Plain words with [a bracket] in the middle.',
      '[unclosed',
      'No brackets at all.',
    ]) {
      assert.strictEqual(stripToolSummaryPrefix(notSummary), notSummary,
        `left alone: ${notSummary}`);
    }
  });

  test('a summary with no words after it leaves nothing, and empty input is safe', () => {
    assert.strictEqual(stripToolSummaryPrefix(`${REPORTED_SUMMARY}\n`), '');
    assert.strictEqual(stripToolSummaryPrefix(''), '');
    assert.strictEqual(stripToolSummaryPrefix(null), '');
  });
});

describe('the rebuilder matches a bracket-carrying turn to its session entry', () => {
  const { handleGetSessionHistory } = require('../../lib/protocol/handlers/history.js');

  test('the turn renders from the session, rather than falling back to the stored text', async () => {
    // THE REAL LOOKUP, not a re-derived prefix. The prefix is an input to the
    // matcher; what matters is whether the matcher then finds the turn. Given
    // a garbled prefix it found nothing and fell back, which is how a fragment
    // of the summary reached the reader in the first place.
    srv.setWorkspace(makeWorkspace({ agents: standardTeam() }));
    const convoId = 'rebuild-bracket-turn';
    srv.appendTranscript(convoId, 'agent', 'research-lead', `${REPORTED_SUMMARY}\n${WORDS}`);

    // The session holds MORE than the transcript does, which is what makes this
    // able to tell the branches apart. With both returning the same string, the
    // match branch and the fallback branch produce identical output and the
    // assertion proves only that one of them ran.
    const SESSION_ONLY = ' A sentence only the session holds.';
    const ctx = { store: { parseSessionHistory: async () => ({
      messages: [{ role: 'assistant', content: WORDS + SESSION_ONLY, timestamp: '2026-09-15T10:00:00Z' }],
    }) } };
    const sent = [];
    const ws = { send: (s) => sent.push(JSON.parse(s)) };

    handleGetSessionHistory(ctx, ws, {
      conversationId: convoId,
      sessionIds: [{ sessionId: 'sess-1', agentId: 'research-lead' }],
    });
    await new Promise(r => setTimeout(r, 40));

    assert.strictEqual(sent.length, 1, 'the handler answered');
    const agentMsgs = sent[0].messages.filter(m => m.role === 'assistant');
    assert.strictEqual(agentMsgs.length, 1, 'the turn came back once');
    assert.strictEqual(agentMsgs[0].content, WORDS + SESSION_ONLY,
      'the session text came back in full, which only the match branch can produce');
    assert.ok(!agentMsgs[0].content.includes('</title>'),
      'with no fragment of the summary in front of them');
  });
});

describe('the limit of counting brackets, pinned so it is known rather than discovered', () => {
  const { stripToolSummaryPrefix } = require('../../lib/store/transcripts.js');

  test('an unbalanced bracket in text ALREADY STORED still defeats the stripper', () => {
    // A RECORD OF WHAT CANNOT BE REPAIRED, not of what is unfixed. The builder
    // no longer writes a summary whose argument carries a bracket or a newline,
    // so no NEW turn can arrive in this shape. Replayed across 173 real stored
    // summaries as arguments, none survives the new builder unstrippable.
    //
    // What remains is history: turns written before that, whose text is on disk
    // in the broken shape. Reading them back cannot be made reliable, because
    // the summary was glued onto the words with a newline and arbitrary command
    // text can imitate either delimiter. Rewriting stored transcripts to repair
    // them is a migration and is not attempted here.
    //
    // So this test pins the reading side's real limit. It is not a defect to be
    // fixed by trying harder at parsing; it is the reason the summary should
    // have had its own field, which is a transcript-format card.
    const stored = "[Bash sed -n '/\\]/p' file.txt] [Agent]\nTHE WORDS.";
    assert.strictEqual(stripToolSummaryPrefix(stored), stored,
      'today this is left untouched, and that is the known boundary of the approach');
  });
});

describe('a tool summary is always one line, whatever the command was', () => {
  const { buildToolSummary, stripToolSummaryPrefix } = require('../../lib/store/transcripts.js');

  test('a multi-line command does not break the summary line', () => {
    // MEASURED, and the only cause of the failures that survived counting
    // brackets: across 173 real summary-carrying turns, both remaining failures
    // were a command with a newline in it, not a command with a bracket. A
    // heredoc or a `python3 -c` block ends the summary's first line INSIDE a
    // group, leaving its bracket unclosed, so the line stops reading as a
    // summary and the whole of it is shown as the agent's words.
    const summary = buildToolSummary([
      { tool: 'Bash', arg: 'cat << \'EOF\' > "$TMPDIR/thread.txt"\nsecond line\nEOF' },
    ]);
    assert.ok(!summary.includes('\n'), 'the summary occupies one line');
    assert.strictEqual(stripToolSummaryPrefix(`${summary}\nTHE WORDS.`), 'THE WORDS.',
      'so it strips, where before the newline made it unstrippable');
  });

  test('the words of a multi-line command survive, just on one line', () => {
    // Collapsed rather than truncated at the newline: a reader still sees what
    // ran, and dropping the tail would lose the part that says what it did.
    const summary = buildToolSummary([{ tool: 'Bash', arg: 'python3 -c "\nprint(1)\n"' }]);
    assert.ok(summary.includes('print(1)'), 'the body of the command is still there');
    assert.strictEqual(summary, '[Bash python3 -c " print(1) "]');
  });

  test('an ordinary single-line argument is untouched', () => {
    assert.strictEqual(buildToolSummary([{ tool: 'Read', arg: '/a/b.md' }]), '[Read /a/b.md]');
    assert.strictEqual(buildToolSummary([{ tool: 'ToolSearch' }]), '[ToolSearch]');
  });

  test('an argument cannot carry the delimiter, however it got there', () => {
    // Two real shapes, both measured. An argument TRUNCATED mid-character-class
    // leaves `[^` unclosed; a command carrying a lone `]` closes a group early.
    // Both made the line stop reading as a summary, so all of it was shown as
    // the agent's words.
    for (const arg of [
      'grep -o -E \'<meta[^>]*name="description"[^',   // truncated mid-class
      "sed -n '/\\]/p' file.txt",                        // a lone closing bracket
      'awk \'{print $1[0]}\' f',                        // balanced, still substituted
    ]) {
      const summary = buildToolSummary([{ tool: 'Bash', arg }]);
      assert.ok(!summary.slice(1, -1).includes('['), `no stray opener: ${summary}`);
      assert.ok(!summary.slice(1, -1).includes(']'), `no stray closer: ${summary}`);
      assert.strictEqual(stripToolSummaryPrefix(`${summary}\nTHE WORDS.`), 'THE WORDS.',
        `and it strips: ${summary}`);
    }
  });

  test('a regex in a command is still legible after substitution', () => {
    // Substituted, not deleted: a summary is already lossy, being truncated and
    // de-duplicated, and a reader should still recognise what ran.
    assert.strictEqual(
      buildToolSummary([{ tool: 'Bash', arg: "grep -o '<title>[^<]*</title>'" }]),
      "[Bash grep -o '<title>(^<)*</title>']");
  });
});
