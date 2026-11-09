'use strict';
// A CODEX ESCALATION THAT TOUCHES A SHELL STARTUP FILE IS NEVER ACCEPTED.
//
// Codex never runs the permission hook: what reaches Rundock is an escalation
// out of its own sandbox, graded in the server by the same rules. Grading a
// file change had no rule for the shell startup files, so with home named as
// a working folder a change to `~/.zshrc` was accepted with no card. Now a
// file change or an escalated command that touches a listed file (a startup
// file, the file one links to, or Rundock's record of them) is graded to the
// answer-file card, in both modes, with home named as a working folder or not.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { gradeCodexApproval } = require('../../lib/runtime/codex-approval.js');

let home, ws;
const ENV_NAMES = ['RUNDOCK_ELECTRON', 'ZDOTDIR', 'XDG_CONFIG_HOME'];
const envBefore = Object.fromEntries(ENV_NAMES.map(n => [n, process.env[n]]));
before(() => {
  process.env.RUNDOCK_ELECTRON = '1';
  delete process.env.ZDOTDIR;
  delete process.env.XDG_CONFIG_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-startup-home-')));
  ws = path.join(home, 'Projects', 'ws');
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{}\n');
  for (const f of ['.zshrc', '.bashrc', '.profile', '.zshenv']) fs.writeFileSync(path.join(home, f), '# mine\n');
  fs.mkdirSync(path.join(home, 'dotfiles'));
  fs.writeFileSync(path.join(home, 'dotfiles', 'zprofile'), '# mine\n');
  fs.symlinkSync(path.join(home, 'dotfiles', 'zprofile'), path.join(home, '.zprofile'));
  fs.mkdirSync(path.join(home, '.config', 'fish', 'conf.d'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'fish', 'config.fish'), '# mine\n');
});
after(() => {
  for (const n of ENV_NAMES) { if (envBefore[n] === undefined) delete process.env[n]; else process.env[n] = envBefore[n]; }
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

const TARGETS = () => [
  '.zshrc', '.bashrc', '.profile', '.zshenv', '.zlogout', '.zprofile', 'dotfiles/zprofile',
  '.config/fish/config.fish', '.config/fish/conf.d/evil.fish', '.rundock-startup-file-exposure.json',
].map(rel => path.join(home, rel));
const SETUPS = () => [
  { label: 'home named as a working folder', extraDirs: [home] },
  { label: 'no working folder', extraDirs: [] },
];
const MODES = [{ codeMode: false, label: 'Notes' }, { codeMode: true, label: 'Code' }];
function assertAnswerCard(g, what) {
  assert.strictEqual(g.decision, 'card', `${what}: carded, never accepted`);
  const r = g.request;
  const crossings = r.crossings || [];
  assert.ok(r.answer_file === true || (crossings.length && crossings.every(c => c.answerFile)), `${what}: as a file that is never changed without asking`);
  assert.ok(crossings.some(c => c.answerFile && c.startupFile), `${what}: naming the startup file`);
  assert.strictEqual(r.grant_dir || null, null, `${what}: with no folder to remember`);
}

describe('a Codex file change that touches a listed file is the answer-file card', () => {
  for (const setup of SETUPS()) {
    for (const mode of MODES) {
      test(`with ${setup.label} (${mode.label} mode)`, () => {
        for (const grantRoot of TARGETS()) {
          const g = gradeCodexApproval({ kind: 'fileChange', params: { grantRoot }, workspaceRoot: ws, extraDirs: setup.extraDirs, codeMode: mode.codeMode, home });
          assertAnswerCard(g, `${mode.label}, ${setup.label}: ${grantRoot}`);
        }
        // A folder that holds one is the same change.
        const g = gradeCodexApproval({ kind: 'fileChange', params: { grantRoot: path.join(home, '.config', 'fish') }, workspaceRoot: ws, extraDirs: setup.extraDirs, codeMode: mode.codeMode, home });
        assertAnswerCard(g, `${mode.label}: the fish folder`);
      });
    }
  }
  test('a change to a folder that holds one is named as that folder, and worded as what runs when you open a terminal', () => {
    const RP = require('../../public/permissions.js');
    for (const [grantRoot, name] of [[home, '~'], [path.join(home, '.config', 'fish'), '~/.config/fish'], [path.join(home, '.config'), '~/.config'], [path.join(home, 'dotfiles'), '~/dotfiles']]) {
      const r = gradeCodexApproval({ kind: 'fileChange', params: { grantRoot }, workspaceRoot: ws, extraDirs: [home], home }).request;
      assert.strictEqual(r.startup_file, name, grantRoot);
      assert.strictEqual(r.crossings[0].startupFile, name, grantRoot);
      const named = [r.resolved_path, ...r.crossings.map(c => c.path)];
      assert.strictEqual(RP.answerFileSummary(named, r.startup_file), 'Wants to change what runs when you open a terminal', grantRoot);
      assert.match(RP.answerFileCopy(named, r.startup_file), /runs each time you open a terminal/, grantRoot);
    }
  });
  test('run from source, a change to the checkout that holds the record is named by the record', () => {
    const RP = require('../../public/permissions.js');
    delete process.env.RUNDOCK_ELECTRON;
    try {
      const checkout = path.join(__dirname, '..', '..');
      const r = gradeCodexApproval({ kind: 'fileChange', params: { grantRoot: checkout }, workspaceRoot: ws, extraDirs: [checkout], home }).request;
      assert.strictEqual(path.basename(r.startup_file), '.startup-file-exposure.json');
      assert.strictEqual(RP.answerFileSummary([r.resolved_path], r.startup_file), 'Wants to change Rundock\'s own record');
    } finally { process.env.RUNDOCK_ELECTRON = '1'; }
  });
  test('the card names the file as the registry spells it', () => {
    const g = gradeCodexApproval({ kind: 'fileChange', params: { grantRoot: path.join(home, 'dotfiles', 'zprofile') }, workspaceRoot: ws, extraDirs: [home], home });
    assert.strictEqual(g.request.crossings[0].startupFile, '~/.zprofile');
  });
});

describe('a Codex command that writes a listed file is the answer-file card', () => {
  for (const setup of SETUPS()) {
    for (const mode of MODES) {
      test(`with ${setup.label} (${mode.label} mode)`, () => {
        for (const target of TARGETS()) {
          for (const command of [`echo x >> ${target}`, `cp notes.txt ${target}`, `sed -i '' s/a/b/ ${target}`]) {
            const g = gradeCodexApproval({ kind: 'command', params: { command, cwd: ws }, workspaceRoot: ws, extraDirs: setup.extraDirs, codeMode: mode.codeMode, home });
            assertAnswerCard(g, `${mode.label}, ${setup.label}: ${command}`);
          }
        }
      });
    }
  }
});

describe('the inverse: what is no startup file is graded as before', () => {
  test('a file beside them, inside a working folder, is accepted', () => {
    for (const rel of ['.zshrc.bak', 'Projects/.profile', 'notes/.bashrc-ideas.md']) {
      const g = gradeCodexApproval({ kind: 'fileChange', params: { grantRoot: path.join(home, rel) }, workspaceRoot: ws, extraDirs: [path.join(home, 'Projects'), path.join(home, 'notes')], home });
      if (rel === '.zshrc.bak') { assert.notStrictEqual((g.request || {}).answer_file, true, rel); continue; }
      assert.strictEqual(g.decision, 'accept', rel);
    }
  });
  test('a read-only command is not a startup-file card', () => {
    const g = gradeCodexApproval({ kind: 'command', params: { command: `cat ${path.join(home, '.zshrc')}`, cwd: ws }, workspaceRoot: ws, extraDirs: [], codeMode: true, home });
    assert.ok(!((g.request && g.request.crossings) || []).some(c => c.startupFile), 'no startup-file crossing');
  });
});
