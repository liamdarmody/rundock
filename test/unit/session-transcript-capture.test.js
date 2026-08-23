'use strict';
// The reader, against a transcript a real run really produced.
//
// WHY THIS FILE AND NOT MORE FIXTURES. Every other test of this reader is
// written against shapes this repository invented. They can only ever prove
// the reader is self-consistent: get the shape wrong and the fixtures are
// wrong in exactly the same way, and everything passes while the product
// reports nonsense. The format belongs to the agent tool, so the only thing
// that can settle a question about it is an artefact from the tool itself.
//
// The capture is committed (scripts/transcript-truth/captured-transcript.json)
// and was taken from a run driven the way the scheduler drives one: print
// mode, permissions skipped, output discarded, session named by the caller.
// It contains a file created, a file edited, a file overwritten, a write that
// was refused, two writes issued in parallel from a single message, a web
// search, and work delegated to a subagent. The last two are there because
// they were open questions the packet could not answer either way, and the
// only thing that settles a question about somebody else's format is an
// artefact from their software.
//
// This half runs in continuous integration, which has no runtime to spend.
// The half that checks the capture is still CURRENT (the installed CLI's
// version against the capture's) lives in the harness that took it, and is
// run by the release gate rather than by CI. Both facts are stated at the top
// of that harness.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { readSessionTranscript, FILE_TOOLS, KNOWN_BLOCK_TYPES } = require('../../lib/runtime/session-transcript.js');
const { checkTranscriptInvariants, checkDeclarationsAgree, checkCaptureAnswers, withoutDelegation, EXPECTED_EXTRACTION, EXPECTED_ABSENT, EXPECTED_DELEGATED, WITNESSED_TOOLS, UNWITNESSED_TOOLS } = require('../../scripts/transcript-truth/truth.js');

const captured = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'scripts', 'transcript-truth', 'captured-transcript.json'), 'utf-8'));

let home = null;
let realHome = null;

// TWO READINGS OF ONE ARTEFACT, laid down as two sessions, because one capture
// cannot witness both halves at once: the delegation in it is precisely what
// stops the reader publishing a list.
//
// The captured session id carries the run WHOLE, subagent transcript included,
// and must report that it cannot say. A second id carries the same lines with
// the delegation removed, which is what a run that delegated nothing leaves,
// and its file list must come out exactly. Neither invents a shape: both are
// lines a real run wrote.
const NO_DELEGATION_SESSION = 'e0000000-0000-4000-8000-00000000cafe';

before(() => {
  realHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-capture-'));
  // Laid down where a transcript lives, so the lookup under test is the real
  // one: found by session id, in a directory named for nothing in particular.
  const dir = path.join(home, '.claude', 'projects', 'captured-run');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${captured.sessionId}.jsonl`), captured.lines.join('\n') + '\n');
  // And its subagent's transcript where the runtime really files one: under a
  // directory named for the session, beside the session's own file.
  const sidechains = path.join(dir, captured.sessionId, 'subagents');
  fs.mkdirSync(sidechains, { recursive: true });
  for (const sub of captured.subagents || []) {
    fs.writeFileSync(path.join(sidechains, sub.name), sub.lines.join('\n') + '\n');
  }
  fs.writeFileSync(path.join(dir, `${NO_DELEGATION_SESSION}.jsonl`), withoutDelegation(captured.lines).join('\n') + '\n');
  process.env.HOME = home;
});

after(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the committed capture', () => {
  test('is a real transcript from a named runtime', () => {
    assert.match(captured.runtimeVersion, /^\d+\.\d+\.\d+$/, 'the capture says which runtime produced it');
    assert.ok(captured.lines.length > 20, 'and holds a whole run rather than a fragment');
    assert.match(captured.sessionId, /^[0-9a-f-]{36}$/, 'named for the session the run was told to be');
  });

  // The setup, asserted before anything is concluded from it. Every claim
  // below is about this artefact containing particular shapes; if a
  // re-capture ever loses one, these tests would pass for the wrong reason.
  test('still contains every shape the reader depends on', () => {
    assert.deepStrictEqual(checkTranscriptInvariants(captured.lines), [],
      'the capture satisfies each assumption the reader makes about the format');
    assert.deepStrictEqual(checkCaptureAnswers(captured), [],
      'and still holds the web search and the delegation the two open questions were settled by');
  });

  test('really does contain the write that was refused', () => {
    const blocks = captured.lines
      .filter(l => l.includes(EXPECTED_ABSENT))
      .map(l => JSON.parse(l))
      .flatMap(entry => (entry.message && Array.isArray(entry.message.content) ? entry.message.content : []));
    assert.ok(blocks.some(b => b.type === 'tool_use'), 'the refused write was really asked for in this capture');
    assert.ok(blocks.some(b => b.type === 'tool_result' && b.is_error === true),
      'and its answer carries the marker the reader excludes on, so excluding it is a real exclusion');
  });
});

describe('the reader over the capture', () => {
  test('extracts exactly the files that run changed, and what happened to each', () => {
    const result = readSessionTranscript(NO_DELEGATION_SESSION);
    assert.strictEqual(result.status, 'known', 'the real transcript is one this reader understands');
    assert.deepStrictEqual(result.files.map(f => [path.basename(f.path), f.change]), EXPECTED_EXTRACTION,
      'a creation, an edit, an overwrite and both halves of a parallel batch, each named for what it was');
  });

  test('does not list the write the run attempted and did not make', () => {
    const result = readSessionTranscript(NO_DELEGATION_SESSION);
    assert.ok(!result.files.some(f => f.path.includes(EXPECTED_ABSENT)),
      'the refused write is in the transcript and is not in the list');
  });

  test('reports the paths the run itself named', () => {
    const result = readSessionTranscript(NO_DELEGATION_SESSION);
    // Taken from the capture's own asks rather than written here, because the
    // run happened in a temporary directory belonging to the machine that
    // captured it.
    const asked = new Set();
    for (const line of captured.lines) {
      const entry = JSON.parse(line);
      const content = entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_use' && block.input && typeof block.input.file_path === 'string') asked.add(block.input.file_path);
      }
    }
    for (const file of result.files) {
      assert.ok(asked.has(file.path), `${file.path} is a path the run really asked to write`);
      assert.ok(path.isAbsolute(file.path), 'and it is absolute, so it can be opened from the record');
    }
  });

  test('both halves of a parallel batch are listed once each, against their own paths', () => {
    const result = readSessionTranscript(NO_DELEGATION_SESSION);
    const parallel = result.files.filter(f => path.basename(f.path).startsWith('par-'));
    assert.strictEqual(parallel.length, 2, 'two parallel writes, two entries');
    assert.strictEqual(new Set(parallel.map(f => f.path)).size, 2, 'and two different files, not one file twice');
  });
});

// ---------------------------------------------------------------------------
// The two questions this capture was extended to settle
// ---------------------------------------------------------------------------

describe('a run that used a web tool', () => {
  // THE QUESTION: a research routine is this project's documented leading
  // example, and every one of them searches the web. If a web tool produced
  // content blocks this reader does not know, every such run would report
  // unknown and AC-4 would fail for the commonest real routine.
  //
  // THE ANSWER, from a run rather than from reasoning: it does not. On this
  // runtime a web search is an ordinary tool_use like any other, and the block
  // types in a transcript containing one are the four the reader already
  // knows. The concern was reasonable and it is unfounded, and the capture is
  // what stops it having to be re-argued.
  test('produces no content block the reader does not know', () => {
    const uses = captured.lines.flatMap(l => {
      const content = (JSON.parse(l).message || {}).content;
      return Array.isArray(content) ? content : [];
    });
    assert.ok(uses.some(b => b && b.type === 'tool_use' && b.name === 'WebSearch'),
      'the run really did use a web tool, so the absence below is a measurement');
    const types = new Set(uses.filter(b => b && typeof b === 'object').map(b => b.type));
    assert.deepStrictEqual([...types].sort().filter(t => !KNOWN_BLOCK_TYPES.has(t)), [],
      'and every block type it produced is one the reader knows');
  });
});

describe('a run that delegated to a subagent', () => {
  // THE QUESTION: whether a delegated subagent's writes land in the session's
  // own transcript. THE ANSWER: they do not. The subagent gets a transcript of
  // its own, filed under a directory named for the session, and its outcome
  // entries carry no payload at all: the path and whether the file was created
  // survive only as an English sentence.
  test('leaves its work in a transcript of its own, which the session\'s never mentions', () => {
    assert.ok((captured.subagents || []).length > 0, 'the capture holds the subagent\'s own transcript');
    const wrote = (captured.subagents || []).flatMap(sub => sub.lines).some(l => {
      const content = (JSON.parse(l).message || {}).content;
      return Array.isArray(content) && content.some(b => b && b.type === 'tool_use'
        && FILE_TOOLS[b.name] && String(b.input[FILE_TOOLS[b.name].input]).endsWith(EXPECTED_DELEGATED));
    });
    assert.ok(wrote, `the subagent really asked to write ${EXPECTED_DELEGATED}`);
    assert.deepStrictEqual(checkCaptureAnswers(captured), [],
      'and the session\'s own transcript holds no file tool naming it');
  });

  // What the reader does about it, over the real artefact. A list holding only
  // the parent's writes would be a confident list missing a file the run
  // really changed, which is the failure this whole reader exists to prevent.
  test('reports that it cannot say what the run changed', () => {
    const result = readSessionTranscript(captured.sessionId);
    assert.strictEqual(result.status, 'unknown', 'the parent\'s writes are not the whole of what this run changed');
    assert.strictEqual(result.reason, 'delegated', 'and it names where the rest of the answer went');
    assert.strictEqual(result.files, null, 'with no list at all');
    assert.ok(result.activity, 'while what the run was last seen doing survives');
  });
});

// The enforcement, driven rather than assumed. checkCaptureAnswers is what
// stops a future re-capture quietly dropping the web search or the delegation
// and leaving both questions answered by a capture that no longer exercises
// them. Satisfied by today's artefact, it asserts nothing about itself: a
// requirement that has never been seen to fail is a requirement nobody has
// tested. So each one is driven by taking the real capture and removing the
// thing it demands.
describe('a capture that stopped exercising what it settles', () => {
  const withoutWebSearch = () => captured.lines.filter(line => {
    const content = (JSON.parse(line).message || {}).content;
    if (!Array.isArray(content)) return true;
    return !content.some(b => b && b.type === 'tool_use' && b.name === 'WebSearch');
  });

  test('a capture with no web search is complained about', () => {
    const lines = withoutWebSearch();
    assert.ok(lines.length < captured.lines.length, 'the capture really did contain the search that was removed');
    const failures = checkCaptureAnswers({ ...captured, lines });
    assert.ok(failures.some(f => /WebSearch/.test(f)), 'the missing search is named');
    assert.ok(failures.some(f => /unwitnessed/.test(f)),
      'and the complaint says what the loss costs: the block-type check stops proving anything about web tools');
  });

  test('a capture with no subagent transcript is complained about', () => {
    const failures = checkCaptureAnswers({ ...captured, subagents: [] });
    // The two absences are different problems and are told apart, so the
    // complaint sends the reader to the right place: no transcript at all
    // means the delegation left nothing behind, while a transcript that never
    // asked to write means the run did not do what the prompt asked.
    assert.ok(failures.some(f => /carries no subagent transcript/.test(f)),
      'a delegation with no transcript beside it leaves the reason for the reader\'s refusal unwitnessed');
    assert.ok(failures.some(f => new RegExp(`no subagent transcript asks to write ${EXPECTED_DELEGATED}`).test(f)),
      'and the file the subagent was asked to write is named, so the fix is obvious');
  });

  // THE TWO FACTS THE READER'S REFUSAL RESTS ON, each driven by taking the
  // real capture and making the fact false. Without these, the reader would go
  // on refusing to list a delegated run on grounds that had quietly stopped
  // holding, which is the same class of error as a list that is quietly wrong.
  test('a delegated write the parent can see for itself is complained about', () => {
    const parentWrote = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_parent', name: 'Write', input: { file_path: `/w/${EXPECTED_DELEGATED}` } }] },
    });
    const failures = checkCaptureAnswers({ ...captured, lines: [...captured.lines, parentWrote] });
    assert.ok(failures.some(f => /not invisible from the parent/.test(f)),
      'a subagent whose writes show up in the session\'s own transcript would leave nothing to refuse');
  });

  test('a subagent outcome that grew a payload is complained about', () => {
    const subagents = (captured.subagents || []).map(sub => ({
      ...sub,
      lines: sub.lines.map(line => {
        const entry = JSON.parse(line);
        const content = (entry.message || {}).content;
        if (!Array.isArray(content) || !content.some(b => b && b.type === 'tool_result')) return line;
        // The payload a session's own transcript carries, put on a subagent's
        // outcome: if that ever became true, the delegated write would be
        // readable and the reader should stop refusing to list it.
        return JSON.stringify({ ...entry, toolUseResult: { type: 'create', filePath: `/w/${EXPECTED_DELEGATED}` } });
      }),
    }));
    const failures = checkCaptureAnswers({ ...captured, subagents });
    assert.ok(failures.some(f => /now carries a payload/.test(f)),
      'the ground for refusing a delegated run has moved and the capture says so');
  });

  test('a capture that no longer delegates at all is complained about', () => {
    const lines = withoutDelegation(captured.lines);
    assert.ok(lines.length < captured.lines.length, 'the capture really did contain the delegation that was removed');
    const failures = checkCaptureAnswers({ ...captured, lines });
    assert.ok(failures.some(f => /no delegation in the capture/.test(f)),
      'a capture that stopped delegating settles nothing about where a subagent\'s work is recorded');
  });

  test('and says nothing about the capture that does exercise both', () => {
    assert.deepStrictEqual(checkCaptureAnswers(captured), []);
  });
});

// ---------------------------------------------------------------------------
// One rule, one place
// ---------------------------------------------------------------------------

describe('the declarations the reader owns', () => {
  // The reader's account of the format used to be restated by the truth
  // harness and again by the fixtures. Three copies pass happily while
  // covering different things, and the way that shows up is silence: add a
  // tool and the capture, the invariant check and the fixtures all stop
  // covering it without a word.
  test('every tool the reader handles is either witnessed by the capture or recorded as unwitnessed', () => {
    assert.deepStrictEqual(checkDeclarationsAgree(), [], 'the reader and the capture harness agree today');
    for (const tool of WITNESSED_TOOLS) assert.ok(FILE_TOOLS[tool], `${tool} is claimed as witnessed and is a tool the reader handles`);
    for (const [tool, reason] of Object.entries(UNWITNESSED_TOOLS)) {
      assert.ok(FILE_TOOLS[tool], `${tool} is recorded as unwitnessed and is still a tool the reader handles`);
      assert.ok(reason.length > 40, `${tool} carries a reason somebody can weigh, not a label`);
    }
  });

  // The enforcement itself, driven rather than assumed: a tool added to the
  // reader and to nothing else must fail, or the agreement above is a
  // coincidence that holds only while nobody adds anything.
  test('a tool added to the reader alone fails the agreement', () => {
    FILE_TOOLS.PatchFile = { input: 'file_path', result: 'filePath' };
    try {
      const failures = checkDeclarationsAgree();
      assert.strictEqual(failures.length, 1, 'the new tool is complained about, exactly once');
      assert.match(failures[0], /PatchFile/, 'and it is named');
      assert.match(failures[0], /witness/i, 'with what has to happen about it');
    } finally {
      delete FILE_TOOLS.PatchFile;
    }
    assert.deepStrictEqual(checkDeclarationsAgree(), [], 'and the complaint goes away when the tool does');
  });

  // The other half of the enforcement, and the half that decides whether the
  // partition means anything: a tool CLAIMED as witnessed and missing from
  // the capture. Without this the harness is satisfied by naming a tool and
  // never exercising it, which is the silent narrowing the whole arrangement
  // exists to prevent. Driven by taking the real capture and removing one
  // witnessed tool from it.
  test('a witnessed tool missing from the capture is complained about by name', () => {
    const notebookIds = new Set();
    const stripped = captured.lines.filter(line => {
      const entry = JSON.parse(line);
      const content = entry.message && entry.message.content;
      if (!Array.isArray(content)) return true;
      if (content.some(b => b.type === 'tool_use' && b.name === 'NotebookEdit' && notebookIds.add(b.id))) return false;
      return !content.some(b => b.type === 'tool_result' && notebookIds.has(b.tool_use_id));
    });
    assert.ok(stripped.length < captured.lines.length, 'the capture really did contain the tool that was removed');

    const failures = checkTranscriptInvariants(stripped);
    const named = failures.filter(f => f.includes('NotebookEdit'));
    assert.ok(named.length > 0, 'the harness names the witnessed tool the capture no longer exercises');
    // The SENTENCE, not just the name. A tool with no call at all and a tool
    // whose outcome shape has moved are different problems with different
    // fixes, and told the wrong one somebody goes looking for a broken result
    // shape that does not exist.
    assert.ok(named.some(f => /contains no NotebookEdit call/.test(f)),
      'and says the capture no longer contains the call, rather than blaming its outcome');
    assert.deepStrictEqual(checkTranscriptInvariants(captured.lines), [],
      'and says nothing about the capture that does exercise it');
  });

  // A fourth copy, which the reader's own comment appeals to. types.d.ts
  // declares the content-block union the reader claims to be following, and a
  // reader that quietly knew a different set would make that comment a
  // decoration.
  test('the block types the reader knows are the union the type model declares', () => {
    const types = fs.readFileSync(path.join(__dirname, '..', '..', 'types.d.ts'), 'utf-8');
    // The union runs to the blank line after it. Split on the semicolon
    // instead and the first member's own field separator ends the search
    // after one block type, which reads as a type model that declares only
    // text: a parse that fails quietly is worse here than no check at all.
    const union = (types.split('type ContentBlock =')[1] || '').split('\n\n')[0];
    assert.ok(union, 'types.d.ts declares a ContentBlock union to compare against');
    const declared = new Set([...union.matchAll(/type: '([a-z_]+)'/g)].map(m => m[1]));
    assert.ok(declared.size > 1, 'and the union parsed as more than a single member, so this is reading the whole of it');
    assert.ok(declared.size > 0, 'and the union names its block types');
    assert.deepStrictEqual([...declared].sort(), [...KNOWN_BLOCK_TYPES].sort(),
      'the reader knows exactly the blocks the repository says exist');
  });
});

// ---------------------------------------------------------------------------
// The question this capture answers on the way past
// ---------------------------------------------------------------------------

describe('the permission hook under skipped permissions', () => {
  // AC-18 and AC-19. Routines spawn with permissions skipped, and whether a
  // PreToolUse hook fires under that flag decides whether write-time capture
  // is available at all to the work that needs it (bytes can only be saved
  // before a write by something that runs before the write). It was an open
  // question nobody had run.
  //
  // The answer lives in the capture rather than in prose because a capture
  // can be re-run: npm run transcript:truth -- --capture.
  test('fires, and the capture says so with what it was asked', () => {
    const hook = captured.permissionHook;
    assert.ok(hook, 'the capture carries the experiment');
    assert.strictEqual(hook.fired, true,
      'the pre-tool hook DOES fire when a routine spawns with permissions skipped');
    assert.ok(hook.calls > 1, `it was consulted ${hook.calls} times, so this is not one lucky call`);
    assert.ok(hook.tools.includes('Write'), 'including about the writes the run made');
    assert.ok(hook.matchers.length > 0, 'and the capture records the matchers it was configured with');
    assert.match(hook.spawn, /dangerously-skip-permissions/, 'and the spawn shape it was asked under');
  });

  test('is consulted before the tool runs, which is what write-time capture needs', () => {
    // The payload the hook receives names the tool it is being asked about,
    // which is only meaningful before the tool has run.
    assert.ok(captured.permissionHook.payloadKeys.includes('tool_name'),
      'the hook is told which tool is about to run');
    assert.ok(captured.permissionHook.payloadKeys.includes('transcript_path'),
      'and where the run is writing its transcript, which anything reading it later would otherwise have to find');
  });
});
