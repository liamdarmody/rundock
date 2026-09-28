'use strict';
// A CODEX AGENT CANNOT KEEP A CHANGE TO THE WORKSPACE'S OWN PERMISSION ANSWERS
// WITHOUT ASKING.
//
// Measured against the live CLI, a Codex thread started the way Rundock starts
// one writes `.rundock/permissions.json`, `.rundock/state.json` and
// `.claude/settings.local.json` inside its sandbox, by file edit and by shell
// redirect, and no approval ever reaches Rundock. No thread option stops it.
// So while a Codex turn runs these files are watched: a change Rundock did not
// make is put back at once, the person is told, and the change is offered on
// the answer-file card, standing only if they approve it.
//
// These tests stand in for the agent by writing the files from outside the
// guard, both as a file edit (a direct write) and as a shell redirect (a real
// `sh -c "printf >> file"`), during a turn the glue is guarding.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const guardLib = require('../../lib/workspace/answer-file-guard.js');
const config = require('../../lib/config.js');
const glue = require('../../lib/runtime/codex-glue.js');
const boundary = require('../../lib/workspace/boundary.js');

const FILES = ['.rundock/permissions.json', '.rundock/state.json', '.claude/settings.local.json'];
let ws;
let prevWorkspace;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-guard-'));
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.rundock', 'permissions.json'), '{"allowedTools":[]}\n');
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{"workspaceMode":"code"}\n');
  fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), '{"hooks":{}}\n');
  prevWorkspace = config.getWorkspace();
  config.setWorkspace(ws);
});
afterEach(() => {
  if (prevWorkspace) config.setWorkspace(prevWorkspace);
  // The glue records each restore as a signal, appended to the workspace's
  // own folder asynchronously, so removal retries rather than racing it.
  fs.rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const read = f => fs.readFileSync(path.join(ws, f), 'utf-8');
function asFileEdit(f, text) { fs.appendFileSync(path.join(ws, f), text); }
function asShellRedirect(f, text) { execFileSync('sh', ['-c', `printf '%s' '${text}' >> '${path.join(ws, f)}'`]); }

function drivenGlue() {
  const notices = [];
  const asked = [];
  const prev = glue.wireCodexGlueDeps({
    safeSend: (s) => { const m = JSON.parse(s); if (m.subtype === 'notice') notices.push(m); },
    requestServerPermission: (req) => { asked.push(req); },
  });
  return { notices, asked, restore: () => glue.wireCodexGlueDeps(prev) };
}

describe('during a Codex turn, an out-of-band change to an answer file is put back and surfaced', () => {
  for (const [route, write] of [['file edit', asFileEdit], ['shell redirect', asShellRedirect]]) {
    test(`all three files, by ${route}`, () => {
      const before = Object.fromEntries(FILES.map(f => [f, read(f)]));
      const d = drivenGlue();
      const entry = { agentId: 'builder', processId: 'p1' };
      try {
        glue.guardCodexTurn(entry, 'convo-1');
        for (const f of FILES) write(f, 'planted');
        glue.releaseCodexTurnGuard(entry); // the turn ends: one last check
      } finally { d.restore(); }
      for (const f of FILES) {
        assert.strictEqual(read(f), before[f], `${f} is back to the bytes it had when the turn started`);
      }
      assert.strictEqual(d.notices.length, 3, 'the person is told about each file');
      for (const n of d.notices) {
        assert.match(n.content, /^A Codex agent changed \.(rundock|claude)\/[a-z.]+\.json, which holds your own answers about what agents may do\. Rundock put it back as it was, and is asking you whether to keep the change\.$/);
        assert.strictEqual(n._conversationId, 'convo-1');
      }
      assert.strictEqual(d.asked.length, 3, 'and asked, on the answer-file card, whether to keep each change');
      for (const req of d.asked) {
        assert.strictEqual(req.grading.answer_file, true);
        assert.strictEqual(req.grading.grant_dir, null, 'never remembered');
        assert.match(req.toolInput.content, /planted$/, 'the card carries what the agent wrote');
      }
    });
  }

  test('restored within the check interval while the turn is still running, without waiting for its end', async () => {
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    const f = '.rundock/permissions.json';
    const before = read(f);
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      asFileEdit(f, '{"allowedTools":["Bash:rm"]}');
      await new Promise(r => setTimeout(r, guardLib.CHECK_INTERVAL_MS * 3));
      assert.strictEqual(read(f), before, 'a planted standing allow does not survive the interval');
      assert.strictEqual(d.notices.length, 1);
    } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
  });

  test('a file the agent creates where none existed is removed', () => {
    fs.rmSync(path.join(ws, '.rundock', 'permissions.json'));
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      asFileEdit('.rundock/permissions.json', '{"allowedTools":["Bash"]}');
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    assert.strictEqual(fs.existsSync(path.join(ws, '.rundock', 'permissions.json')), false);
  });

  test('approving the card keeps the agent\'s version, and it is not put back again', () => {
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    const f = '.rundock/state.json';
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      asFileEdit(f, 'X');
      entry._answerGuard.check();
      assert.strictEqual(d.asked.length, 1);
      d.asked[0].onDecision(true);
      assert.match(read(f), /X$/, 'the person said keep it');
      entry._answerGuard.check();
      assert.match(read(f), /X$/, 'and the guard does not undo an approved change');
    } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
  });

  test('declining leaves the file as it was', () => {
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    const f = '.claude/settings.local.json';
    const before = read(f);
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      asShellRedirect(f, 'Y');
      glue.releaseCodexTurnGuard(entry);
      d.asked[0].onDecision(false, 'user');
    } finally { d.restore(); }
    assert.strictEqual(read(f), before);
  });
});

describe('an answer file swapped for a link, or for anything but a plain file, is replaced, never written through', () => {
  let outside;
  beforeEach(() => { outside = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-guard-outside-')); });
  afterEach(() => { fs.rmSync(outside, { recursive: true, force: true }); });

  test('a symlink to a file elsewhere is removed and the answers come back as a plain file; the other file is untouched', () => {
    const f = '.rundock/permissions.json';
    const abs = path.join(ws, f);
    const before = read(f);
    const target = path.join(outside, 'forged.json');
    fs.writeFileSync(target, '{"allowedTools":["Bash:*"]}\n');
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      fs.rmSync(abs);
      fs.symlinkSync(target, abs);
      entry._answerGuard.check();
      assert.strictEqual(fs.lstatSync(abs).isSymbolicLink(), false, 'the link is gone');
      assert.strictEqual(fs.lstatSync(abs).isFile(), true, 'a plain file stands in its place');
      assert.strictEqual(read(f), before, 'holding the answers the turn started with');
      assert.strictEqual(fs.readFileSync(target, 'utf-8'), '{"allowedTools":["Bash:*"]}\n', 'the file the link pointed at is untouched');
      // Rewriting the old target changes nothing any more.
      fs.writeFileSync(target, '{"allowedTools":["Bash"]}\n');
      entry._answerGuard.check();
      assert.strictEqual(read(f), before);
    } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
    assert.strictEqual(d.notices.length, 1, 'the person is told, like any other restore');
    assert.strictEqual(d.asked.length, 1, 'and asked on the answer-file card');
    assert.strictEqual(d.asked[0].grading.answer_file, true);
  });

  test('a link whose target holds exactly what Rundock last wrote is still not taken as Rundock\'s own', () => {
    const f = '.rundock/permissions.json';
    const abs = path.join(ws, f);
    const d = drivenGlue();
    const entry = { agentId: 'builder', processId: 'p1' };
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      boundary.addToolAllow('Bash:npm');
      entry._answerGuard.check();
      const ours = read(f);
      const target = path.join(outside, 'copy.json');
      fs.writeFileSync(target, ours);
      fs.rmSync(abs);
      fs.symlinkSync(target, abs);
      entry._answerGuard.check();
      assert.strictEqual(fs.lstatSync(abs).isSymbolicLink(), false);
      assert.strictEqual(read(f), ours);
    } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
  });

  test('a folder put where an answer file was is removed and the file restored', () => {
    const f = '.claude/settings.local.json';
    const abs = path.join(ws, f);
    const before = read(f);
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      fs.rmSync(abs);
      fs.mkdirSync(abs);
      fs.writeFileSync(path.join(abs, 'x'), 'x');
      entry._answerGuard.check();
    } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
    assert.strictEqual(fs.lstatSync(abs).isFile(), true);
    assert.strictEqual(read(f), before);
  });

  test('a link the person had there before the turn is kept, and what the agent wrote through it is put back', () => {
    const f = '.claude/settings.json';
    const abs = path.join(ws, f);
    const target = path.join(outside, 'kept-elsewhere.json');
    fs.writeFileSync(target, '{"theirs":true}\n');
    fs.symlinkSync(target, abs);
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      fs.appendFileSync(abs, 'planted');
      entry._answerGuard.check();
    } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
    assert.strictEqual(fs.lstatSync(abs).isSymbolicLink(), true, 'their own link stays');
    assert.strictEqual(fs.readlinkSync(abs), target);
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), '{"theirs":true}\n', 'with its content as it was');
    assert.strictEqual(d.notices.length, 1);
  });

  test('approving the card writes a plain file, even if a link was put back in the meantime', () => {
    const f = '.rundock/state.json';
    const abs = path.join(ws, f);
    const target = path.join(outside, 'elsewhere.json');
    fs.writeFileSync(target, 'untouched\n');
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      asFileEdit(f, 'X');
      entry._answerGuard.check();
      fs.rmSync(abs);
      fs.symlinkSync(target, abs);
      d.asked[0].onDecision(true);
    } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
    assert.strictEqual(fs.lstatSync(abs).isSymbolicLink(), false, 'the approved content lands in a plain file');
    assert.match(read(f), /X$/);
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'untouched\n', 'never through the link');
  });
});

const OUTSIDE_NOTICE = (rel) => `${rel}, which holds your own answers about what agents may do, changed while no agent turn was running. `
  + 'Rundock put it back as it was, and is asking you whether to keep the change.';

describe('a change made between turns is caught when the next turn starts', () => {
  test('a write after a turn ended (a background job finishing late) is restored and carded at the next turn, worded as outside a turn', () => {
    const f = '.rundock/permissions.json';
    const before = read(f);
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      glue.releaseCodexTurnGuard(entry);
      asFileEdit(f, '{"allowedTools":["Bash:*"]}'); // no turn is running
      glue.guardCodexTurn(entry, 'convo-2');
      assert.strictEqual(read(f), before, 'put back the moment the next turn starts');
      entry._answerGuard.check();
      assert.strictEqual(read(f), before, 'and never adopted as the new baseline');
    } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
    assert.strictEqual(d.notices.length, 1);
    assert.strictEqual(d.notices[0].content, OUTSIDE_NOTICE('.rundock/permissions.json'));
    assert.strictEqual(d.notices[0]._conversationId, 'convo-2');
    assert.strictEqual(d.asked.length, 1);
    assert.strictEqual(d.asked[0].grading.answer_file, true);
    assert.match(d.asked[0].toolInput.content, /Bash:\*/);
  });

  test('approving that card keeps the change', () => {
    const f = '.rundock/state.json';
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      glue.releaseCodexTurnGuard(entry);
      asFileEdit(f, 'X');
      glue.guardCodexTurn(entry, 'convo-2');
      d.asked[0].onDecision(true);
      entry._answerGuard.check();
    } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
    assert.match(read(f), /X$/);
  });

  test('the baseline outlives every turn: Rundock\'s own writes between turns stand, an agent\'s do not', () => {
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      glue.releaseCodexTurnGuard(entry);
      boundary.addToolAllow('Bash:npm');
      glue.guardCodexTurn(entry, 'convo-2');
    } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
    assert.match(read('.rundock/permissions.json'), /Bash:npm/);
    assert.strictEqual(d.notices.length, 0);
  });
});

describe('a Claude Code settings file changed outside Rundock between turns is left alone', () => {
  for (const f of ['.claude/settings.local.json', '.claude/settings.json']) {
    test(`a between-turns edit of ${f} stays, with no notice and no card, and becomes the baseline`, () => {
      if (!fs.existsSync(path.join(ws, f))) fs.writeFileSync(path.join(ws, f), '{}\n');
      const entry = { agentId: 'builder', processId: 'p1' };
      const d = drivenGlue();
      try {
        glue.guardCodexTurn(entry, 'convo-1');
        glue.releaseCodexTurnGuard(entry);
        fs.writeFileSync(path.join(ws, f), '{"edited":"outside"}\n');
        glue.guardCodexTurn(entry, 'convo-2');
        entry._answerGuard.check();
      } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
      assert.strictEqual(read(f), '{"edited":"outside"}\n', 'left in place');
      assert.strictEqual(d.notices.length, 0, 'no notice');
      assert.strictEqual(d.asked.length, 0, 'no card');
    });
  }

  test('Rundock\'s own files are still put back and asked about when changed between turns', () => {
    const f = '.rundock/permissions.json';
    const before = read(f);
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      glue.releaseCodexTurnGuard(entry);
      asFileEdit(f, '{"allowedTools":["Bash"]}');
      glue.guardCodexTurn(entry, 'convo-2');
    } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
    assert.strictEqual(read(f), before);
    assert.strictEqual(d.asked.length, 1);
    assert.strictEqual(d.notices.length, 1);
  });

  test('during a turn, the settings files are still put back and carded', () => {
    for (const f of ['.claude/settings.local.json', '.claude/settings.json']) {
      if (!fs.existsSync(path.join(ws, f))) fs.writeFileSync(path.join(ws, f), '{}\n');
      const before = read(f);
      const entry = { agentId: 'builder', processId: 'p1' };
      const d = drivenGlue();
      try {
        glue.guardCodexTurn(entry, 'convo-1');
        asFileEdit(f, 'planted');
        entry._answerGuard.check();
      } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
      assert.strictEqual(read(f), before, f);
      assert.strictEqual(d.asked.length, 1, f);
    }
  });
});

describe('an answer file made read-only is a change', () => {
  test('chmod during a turn is put back with the original mode, and carded', () => {
    const f = '.rundock/permissions.json';
    const abs = path.join(ws, f);
    fs.chmodSync(abs, 0o600); // not the default, so a restore that drops the mode shows
    const mode = fs.statSync(abs).mode & 0o777;
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      fs.chmodSync(abs, 0o444);
      entry._answerGuard.check();
    } finally { glue.releaseCodexTurnGuard(entry); d.restore(); }
    assert.strictEqual(fs.statSync(abs).mode & 0o777, mode, 'writable again, as it was');
    assert.strictEqual(d.notices.length, 1);
    assert.doesNotThrow(() => boundary.addToolAllow('Bash:npm'), 'and Rundock can write its answers again');
  });
});

describe('Rundock\'s own writes during a Codex turn stand', () => {
  test('a standing allow stored through the product is not reverted', () => {
    const entry = { agentId: 'builder', processId: 'p1' };
    const d = drivenGlue();
    try {
      glue.guardCodexTurn(entry, 'convo-1');
      boundary.addToolAllow('Bash:npm');
      glue.releaseCodexTurnGuard(entry);
    } finally { d.restore(); }
    assert.match(read('.rundock/permissions.json'), /Bash:npm/, 'the person\'s own answer, written by Rundock, is kept');
    assert.strictEqual(d.notices.length, 0, 'and nobody is told an agent changed it');
  });
});

describe('the guard covers every Codex turn', () => {
  test('direct chats and delegates, fresh threads and resumed ones, all start the guard with the turn and end it with the turn', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'runtime', 'codex-glue.js'), 'utf8');
    const start = src.slice(src.indexOf('function startCodexTurnKeepalive'), src.indexOf('function stopCodexTurnKeepalive'));
    assert.match(start, /guardCodexTurn\(entry, convoId\)/, 'the guard starts with every turn');
    const stop = src.slice(src.indexOf('function stopCodexTurnKeepalive'), src.indexOf('function stopCodexTurnKeepalive') + 300);
    assert.match(stop, /releaseCodexTurnGuard\(entry\)/, 'and ends with it');
    // Both turn paths start the keepalive, whichever thread they run on.
    for (const fn of ['function startCodexTurn(', 'function wireCodexDelegate(']) {
      const i = src.indexOf(fn);
      assert.ok(i >= 0, fn);
      const body = src.slice(i, src.indexOf('\nfunction ', i + fn.length));
      assert.match(body, /startCodexTurnKeepalive\(entry, convoId\)/, `${fn} starts the keepalive, and with it the guard`);
    }
  });
});
