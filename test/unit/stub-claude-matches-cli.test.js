'use strict';
// THE STUB `claude` ANSWERS AS THE INSTALLED CLAUDE CODE DID, CASE BY CASE.
//
// Every Notes-mode test in this suite runs on the stub, so what the stub
// refuses is what those tests prove. test/fixtures/claude-cli-notes-mode.json
// is what the real CLI refused and allowed in the same cases, measured by
// test/tools/claude-cli-notes-mode-probe.js (run by hand: it needs a real
// install, and a stand-in for the API, so no account is used). This runs the
// stub through each recorded case and holds it to the record: the same calls
// refused, in the same words, the same files on disk afterwards, and the same
// shell commands put to the permission hook.
//
// When the CLI changes, the probe is run again and its record replaces this
// fixture; any case the stub then answers differently fails here, by name.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');
const { NOTES_DISALLOWED_TOOLS } = require('../../lib/workspace/mode.js');

after(cleanup);

const RECORD = require('../fixtures/claude-cli-notes-mode.json');
const STUB = path.join(__dirname, '..', 'helpers', 'stub-claude', 'claude');
const PROMPT = 'do the work';
// The stub keeps its session transcript under $HOME, so it gets its own.
const HOME = makeTempDir('rundock-stub-cli-home-');

// A hook that records each call it is put and gives the case's answer.
function hookScript(dir, decision) {
  const script = path.join(dir, 'hook.js');
  const log = path.join(dir, 'hook-calls.jsonl');
  fs.writeFileSync(script, `let s = '';
process.stdin.on('data', d => { s += d; });
process.stdin.on('end', () => {
  require('fs').appendFileSync(${JSON.stringify(log)}, s.trim() + '\\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: ${JSON.stringify(decision)}, permissionDecisionReason: ${JSON.stringify(decision === 'allow' ? 'Approved' : 'Denied')} } }));
});
`);
  return { command: `"${process.execPath}" "${script}"`, log };
}

// What the stub was asked to do and said back, in call order, read from the
// transcript it keeps for the session.
function answers(dir, sessionId) {
  const file = path.join(HOME, '.claude', 'projects', fs.realpathSync(dir).replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  const asked = [];
  const said = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    for (const b of (entry.message && Array.isArray(entry.message.content)) ? entry.message.content : []) {
      if (b.type === 'tool_use') asked.push({ id: b.id, tool: b.name, input: b.input });
      if (b.type === 'tool_result') said.set(b.tool_use_id, b.is_error ? { refused: true, message: b.content } : { refused: false });
    }
  }
  return asked.map(a => ({ ...a, answer: said.get(a.id) }));
}

// One recorded case, run on the stub in the same spawn shape.
function runStub(c) {
  const dir = makeTempDir('rundock-stub-cli-');
  for (const [f, body] of Object.entries(c.seed || {})) fs.writeFileSync(path.join(dir, f), body);
  const shell = [];
  const writes = [];
  for (const s of c.steps) {
    if (s.tool === 'Bash') shell.push(s.command);
    // An edit's result, worked out here: the stub writes whole files, and what
    // is compared is whether the CLI let the edit happen.
    else if (s.tool === 'Edit') writes.push({ tool: 'Edit', file: s.file, content: c.seed[s.file].split(s.old).join(s.new) });
    else if (s.tool !== 'Read') writes.push({ tool: s.tool, file: s.file, content: s.content });
  }
  fs.writeFileSync(path.join(dir, 'stub-scenario.json'), JSON.stringify({ rules: [{ match: {}, shell, writes, turn: [{ text: 'done' }] }] }));
  const sessionId = crypto.randomUUID();
  const list = c.list === 'notes' ? NOTES_DISALLOWED_TOOLS : c.list;
  const flag = list ? ['--disallowed-tools', list] : [];
  const hook = c.hook ? hookScript(dir, c.hook) : null;
  const settings = hook ? ['--settings', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: hook.command }] }] } })] : [];
  let argv;
  let input;
  if (c.shape === 'conversation') {
    argv = [...settings, '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', RECORD.conversation.permissionMode, '--allowed-tools', RECORD.conversation.allowedTools, ...flag, '--session-id', sessionId];
    input = `${JSON.stringify({ type: 'user', message: { role: 'user', content: PROMPT } })}\n`;
  } else if (c.placement === 'before-prompt') {
    argv = [...settings, '--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--session-id', sessionId, ...flag, PROMPT];
  } else {
    argv = [...settings, ...flag, '--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--session-id', sessionId, PROMPT];
  }
  const r = spawnSync(process.execPath, [STUB, ...argv], { cwd: dir, env: { ...process.env, HOME }, input, encoding: 'utf8', timeout: 20000 });
  const errorLine = String(r.stderr || '').split('\n').map(l => l.trim()).find(l => l.startsWith('Error:'));
  const files = {};
  for (const f of c.observe || []) {
    const p = path.join(dir, f);
    files[f] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  const hookAsked = hook && fs.existsSync(hook.log)
    ? fs.readFileSync(hook.log, 'utf8').split('\n').filter(Boolean).map((l) => {
      const j = JSON.parse(l);
      return { tool: j.tool_name, about: j.tool_input.command || path.relative(fs.realpathSync(dir), j.tool_input.file_path || '') };
    })
    : [];
  return { status: r.status, errorLine, files, hookAsked, answers: r.status === 0 ? answers(dir, sessionId) : [] };
}

// The stub's answer to each recorded step, matched by order within its kind:
// the stub runs a rule's shell commands, then its writes.
function stubAnswerFor(c, run) {
  const shellAnswers = run.answers.filter(a => a.tool === 'Bash');
  const writeAnswers = run.answers.filter(a => a.tool !== 'Bash');
  let nShell = 0;
  let nWrite = 0;
  return c.steps.map((s) => {
    if (s.tool === 'Read') return null;
    const a = s.tool === 'Bash' ? shellAnswers[nShell++] : writeAnswers[nWrite++];
    return a ? a.answer : undefined;
  });
}

describe('the record', () => {
  test('was made with the Notes list Rundock passes today', () => {
    assert.strictEqual(RECORD.notesList, NOTES_DISALLOWED_TOOLS,
      'the list has changed since the CLI was measured: run node test/tools/claude-cli-notes-mode-probe.js --write');
  });

  test('ran its conversation cases with the permission mode and allowed tools a conversation is spawned with', () => {
    const { _internal: srv } = require('../../server.js');
    assert.strictEqual(RECORD.conversation.permissionMode, srv.getPermissionMode());
    assert.strictEqual(RECORD.conversation.allowedTools, srv.getAllowedToolsInteractive());
  });

  test('names the version it measured, and holds no path from the machine it ran on', () => {
    assert.ok(/^\d+\.\d+\.\d+$/.test(RECORD.claudeCode), `a version: ${RECORD.claudeCode}`);
    const text = JSON.stringify(RECORD);
    for (const re of [/\/Users\//, /\/home\//, /\/private\//, /\/tmp\//, /\/var\/folders\//, /[A-Z]:\\\\/]) {
      assert.doesNotMatch(text, re);
    }
  });
});

describe('the stub answers each recorded case as the CLI did', () => {
  for (const c of RECORD.cases.filter(k => k.steps.length > 0)) {
    test(c.name, () => {
      const run = runStub(c);
      assert.strictEqual(run.status, c.observed.exitCode, 'the run ends as the CLI\'s did');
      const stub = stubAnswerFor(c, run);
      c.steps.forEach((s, i) => {
        if (s.tool === 'Read') return;
        assert.deepStrictEqual(stub[i], c.observed.results[i], `${s.tool} ${s.file || s.command}: refused or not, in the CLI's words`);
      });
      assert.deepStrictEqual(run.files, c.observed.files, 'the same files, holding the same bytes, afterwards');
      if (c.hook) {
        // Shell commands are put to the hook, including the ones the deny
        // rules then refuse; that is the CLI's order, and the stub's.
        assert.deepStrictEqual(run.hookAsked, c.observed.hookAsked.filter(h => h.tool === 'Bash'),
          'the same shell commands put to the hook');
      }
    });
  }

  test('the flag placed just before the prompt fails the run for want of input, in the CLI\'s words', () => {
    const c = RECORD.cases.find(k => k.placement === 'before-prompt');
    const run = runStub(c);
    assert.strictEqual(run.status, c.observed.exitCode);
    assert.strictEqual(run.errorLine, c.observed.error);
  });
});

describe('what the record says about the hook and the deny rules', () => {
  const withHook = RECORD.cases.filter(k => k.hook === 'allow');

  test('a shell rename or delete a deny rule covers was put to the hook, answered allow, and refused all the same', () => {
    let seen = 0;
    for (const c of withHook) {
      c.steps.forEach((s, i) => {
        if (s.tool !== 'Bash' || !c.observed.results[i].refused) return;
        seen++;
        assert.ok(c.observed.hookAsked.some(h => h.tool === 'Bash' && h.about === s.command), `${c.name}: ${s.command} was put to the hook`);
        assert.match(c.observed.results[i].message, /^Permission to use Bash with command .* has been denied\.$/);
      });
    }
    assert.ok(seen >= 6, 'in a routine\'s spawn shape and in a conversation\'s');
    assert.ok(withHook.some(c => c.shape === 'conversation' && c.steps.some((s, i) => s.tool === 'Bash' && c.observed.results[i].refused)));
  });

  test('a write a deny rule covers is refused without the hook being asked; the stub never asks it about a write', () => {
    for (const c of withHook) {
      c.steps.forEach((s, i) => {
        if (s.tool !== 'Write') return;
        const asked = c.observed.hookAsked.some(h => h.tool === 'Write' && h.about === s.file);
        assert.strictEqual(asked, !c.observed.results[i].refused, `${c.name}: ${s.file}`);
      });
    }
    // The other half, stated rather than hidden: the CLI does ask the hook
    // about a write it allows, and the stub does not model that.
    const run = runStub(withHook.find(c => c.steps.some(s => s.tool === 'Write')));
    assert.deepStrictEqual(run.hookAsked.filter(h => h.tool !== 'Bash'), []);
  });
});
