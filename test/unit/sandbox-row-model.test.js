'use strict';
// Every state the Permissions row can take, from the model the view draws.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const M = require('../../public/sandbox-row-model.js');

const status = (extra) => ({ platform: 'darwin', available: true, present: true, managed: true, on: true, blockOn: true, setBy: 'workspace', enabledElsewhere: [], stored: true, notice: null, ...extra });
const text = (parts) => (parts || []).map((p) => p.text || p.code).join('');

describe('the effective state comes first, and only what Rundock can change is a switch', () => {
  test('macOS, Rundock\'s block, on and off: a switch, the consequence, and the macOS caption', () => {
    const on = M.sandboxRow(status(), 'darwin', null);
    assert.deepStrictEqual([on.state, on.label, on.control, on.folders], ['on', 'On', 'switch', 'on']);
    assert.deepStrictEqual(on.captions, [M.ON_CAPTION, 'Uses macOS\'s built-in sandbox.']);
    const off = M.sandboxRow(status({ on: false, blockOn: false }), 'darwin', null);
    assert.deepStrictEqual([off.state, off.label, off.control, off.folders], ['off', 'Off', 'switch', 'off']);
    assert.deepStrictEqual(off.captions, [M.OFF_CAPTION, 'Uses macOS\'s built-in sandbox.']);
  });

  test('a block a person wrote: its own state, a lock, where it was set, and the way to bring it in', () => {
    for (const on of [true, false]) {
      const r = M.sandboxRow(status({ managed: false, on, blockOn: on }), 'darwin', null);
      assert.deepStrictEqual([r.label, r.control, r.bringIn], [on ? 'On' : 'Off', 'lock', true]);
      assert.strictEqual(text(r.ownership), 'Set up outside Rundock, in .claude/settings.local.json. Rundock cannot change this switch here.');
    }
  });

  test('turned on by managed settings: On, a lock, and that the organisation set it', () => {
    const r = M.sandboxRow(status({ on: true, blockOn: false, setBy: 'managed' }), 'darwin', null);
    assert.deepStrictEqual([r.label, r.control, r.folders], ['On', 'lock', 'on']);
    assert.strictEqual(text(r.ownership), 'Set by your organisation\'s managed Claude Code settings. Rundock cannot change this switch here.');
  });

  test('turned on by another file: On, a lock, the file named, and why the switch cannot turn it off', () => {
    const one = M.sandboxRow(status({ on: true, blockOn: false, setBy: 'elsewhere', enabledElsewhere: ['~/.claude/settings.json'] }), 'darwin', null);
    assert.deepStrictEqual([one.label, one.control], ['On', 'lock']);
    assert.strictEqual(text(one.ownership), 'Turned on in ~/.claude/settings.json. Rundock\'s switch can\'t turn this off while that file turns it on.');
    const two = M.sandboxRow(status({ on: true, setBy: 'elsewhere', enabledElsewhere: ['.claude/settings.json', '~/.claude/settings.json'] }), 'darwin', null);
    assert.strictEqual(text(two.ownership), 'Turned on in .claude/settings.json and ~/.claude/settings.json. Rundock\'s switch can\'t turn this off while those files turn it on.');
  });

  test('Windows and Linux: Unavailable, with nothing switch-shaped', () => {
    const win = M.sandboxRow(null, 'win32', null);
    assert.deepStrictEqual([win.label, win.control, win.captions], ['Unavailable', 'none', ['Not available on Windows. Your approval settings still apply.']]);
    const linux = M.sandboxRow(status({ platform: 'linux', available: false, on: false }), 'linux', null);
    assert.deepStrictEqual([linux.label, linux.control, linux.captions], ['Unavailable', 'none', ['Not available on Linux yet. Your approval settings still apply.']]);
  });

  test('a Codex default: Status unknown, a lock, and a sentence about Codex only where it was detected', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const bare = M.sandboxRow(status({ platform }), platform, { defaultRuntime: 'codex', codex: { windowsSandbox: null } });
      assert.deepStrictEqual([bare.label, bare.control, bare.captions], ['Status unknown', 'lock', []], platform);
      assert.strictEqual(text(bare.ownership), 'Controlled by Codex, in your own config file. Rundock can\'t confirm whether it is active.');
    }
    const undeclared = M.sandboxRow(null, 'win32', { defaultRuntime: 'codex', codex: { windowsSandbox: false } });
    assert.deepStrictEqual(undeclared.captions, ['Codex currently asks before changing files, based on its own settings.']);
  });

  test('before the status arrives, nothing is claimed', () => {
    const r = M.sandboxRow(null, 'darwin', null);
    assert.deepStrictEqual([r.state, r.control, r.captions], ['checking', 'none', []]);
  });
});

describe('the notice and the review', () => {
  test('the notice carries the state that was carried over, and nothing when there is none', () => {
    assert.strictEqual(M.noticeText(status({ notice: 'on' })), 'Keeping agents inside this workspace is now its own switch. Yours is still on. Switching between Notes and Code won\'t change it.');
    assert.strictEqual(M.noticeText(status({ notice: 'off' })), 'Keeping agents inside this workspace is now its own switch. Yours is still off. Switching between Notes and Code won\'t change it.');
    assert.strictEqual(M.noticeText(status()), null);
  });

  test('the review names the folders and every dropped rule, one or many', () => {
    const one = M.reviewCopy({ folders: ['/Users/x/Projects'], dropped: [{ rule: 'filesystem.denyWrite', value: '*.env' }] });
    assert.strictEqual(one.foldersLead, 'These folders you added by hand become Working folders:');
    assert.strictEqual(text(one.warn), 'Rundock can\'t represent one rule in your file: a custom deny pattern on *.env. Bringing your rules in will drop it.');
    const many = M.reviewCopy({ folders: [], dropped: [{ rule: 'excludedCommands', value: '*ship.sh*' }, { rule: 'network', value: '{"allowLocalBinding":true}' }] });
    assert.strictEqual(many.foldersLead, null);
    assert.match(text(many.warn), /^Rundock can't represent 2 rules in your file: .*\*ship\.sh\*.*network.*Bringing your rules in will drop them\.$/);
    assert.strictEqual(M.reviewCopy({ folders: [], dropped: [] }).warn, null);
  });
});

describe('a workspace using both runtimes', () => {
  test('a Claude Code row and a Codex row, and each alone when only one is in use', () => {
    const both = M.sandboxRows(status(), 'darwin', { defaultRuntime: 'claude' }, [{ runtime: 'claude' }, { runtime: 'codex' }]);
    assert.deepStrictEqual(both.map((r) => [r.rowLabel, r.label]), [[null, 'On'], ['Keep Codex agents inside this workspace', 'Status unknown']]);
    assert.deepStrictEqual(M.sandboxRows(status(), 'darwin', { defaultRuntime: 'codex' }, [{ runtime: 'codex' }]).map((r) => r.rowLabel), [null]);
    assert.strictEqual(M.sandboxRows(status(), 'darwin', { defaultRuntime: 'codex' }, [{ runtime: 'codex' }])[0].label, 'Status unknown');
    assert.deepStrictEqual(M.sandboxRows(status(), 'darwin', null, [{ runtime: 'claude' }]).map((r) => r.label), ['On']);
  });
});

describe('what the working folders do, in each state and mode', () => {
  test('the sentence for each state, checked against the hook and the block', () => {
    const on = 'Agents can change files in these folders too. Anywhere else, changes are blocked unless you approve them.';
    assert.strictEqual(M.foldersCaption('on', 'notes'), on);
    assert.strictEqual(M.foldersCaption('on', 'code'), on);
    assert.strictEqual(M.foldersCaption('off', 'notes'), 'Agents can edit files in these folders without asking. Anywhere else, changes need your approval.');
    assert.strictEqual(M.foldersCaption('off', 'code'), 'Agents can change files in these folders without asking. Anywhere else, Rundock still asks before a file edit, and before a command it can see reaching outside.');
    assert.strictEqual(M.foldersCaption('plain', 'notes'), null);
  });

  test('Windows and Linux run no sandbox, so their folders read as off', () => {
    assert.strictEqual(M.sandboxRow(null, 'win32', null).folders, 'off');
    assert.strictEqual(M.sandboxRow(null, 'linux', null).folders, 'off');
  });
});

describe('the switch captions say what is true of the row they are on', () => {
  const ON = 'Keeps agents inside a wall macOS enforces: they can change files in this workspace, the folders below, and the temporary folders they need. Everything else is blocked.';
  const OFF = 'Removes the wall macOS enforces: agents can then change or delete files outside this workspace wherever your account allows. Rundock still asks before each change there, until you add a folder below.';
  const ON_NO_FOLDERS = 'Keeps agents inside a wall macOS enforces: they can change files in this workspace and the temporary folders they need. Everything else is blocked.';
  const OFF_NO_FOLDERS = 'Removes the wall macOS enforces: agents can then change or delete files outside this workspace wherever your account allows. Rundock still asks before each change there.';

  test('the four captions, word for word', () => {
    assert.deepStrictEqual([M.ON_CAPTION, M.OFF_CAPTION, M.ON_CAPTION_NO_FOLDERS, M.OFF_CAPTION_NO_FOLDERS], [ON, OFF, ON_NO_FOLDERS, OFF_NO_FOLDERS]);
  });

  test('Rundock\'s own switch row names the folders, on and off', () => {
    assert.strictEqual(M.sandboxRow(status(), 'darwin', null).captions[0], ON);
    assert.strictEqual(M.sandboxRow(status({ on: false, blockOn: false }), 'darwin', null).captions[0], OFF);
    assert.strictEqual(M.sandboxRow(status({ present: false, on: false, blockOn: false }), 'darwin', null).captions[0], OFF, 'no block yet: adding a folder writes Rundock\'s');
  });

  test('a locked row with Rundock\'s block in the file names the folders too', () => {
    const org = M.sandboxRow(status({ on: true, setBy: 'managed' }), 'darwin', null);
    assert.strictEqual(org.control, 'lock');
    assert.strictEqual(org.captions[0], ON);
    const elsewhere = M.sandboxRow(status({ on: true, setBy: 'elsewhere', enabledElsewhere: ['~/.claude/settings.json'] }), 'darwin', null);
    assert.strictEqual(elsewhere.captions[0], ON);
  });

  test('a locked row without Rundock\'s block does not promise folders it cannot keep', () => {
    for (const on of [true, false]) {
      const own = M.sandboxRow(status({ managed: false, on, blockOn: on }), 'darwin', null);
      assert.strictEqual(own.captions[0], on ? ON_NO_FOLDERS : OFF_NO_FOLDERS, `the person\'s own block, ${on ? 'on' : 'off'}`);
    }
    const elsewhere = M.sandboxRow(status({ present: false, on: true, blockOn: false, setBy: 'elsewhere', enabledElsewhere: ['~/.claude/settings.json'] }), 'darwin', null);
    assert.strictEqual(elsewhere.captions[0], ON_NO_FOLDERS, 'turned on by another file, with no block of Rundock\'s');
    const org = M.sandboxRow(status({ present: false, on: true, blockOn: false, setBy: 'managed' }), 'darwin', null);
    assert.strictEqual(org.captions[0], ON_NO_FOLDERS);
  });

  test('Windows and Linux keep their own line', () => {
    assert.deepStrictEqual(M.sandboxRow(status({ platform: 'win32' }), 'win32', null).captions, ['Not available on Windows. Your approval settings still apply.']);
  });
});

describe('the working folders note for a sandbox block a person wrote', () => {
  test('shown only when the block in the file is the person\'s own', () => {
    assert.strictEqual(M.ownSandboxFoldersNote(status({ managed: false })), "Because this workspace's sandbox settings are your own, Rundock doesn't add working folders to them. Add each working folder to them yourself so agents can write there and a cd into it carries over.");
    assert.strictEqual(M.ownSandboxFoldersNote(status()), null);
    assert.strictEqual(M.ownSandboxFoldersNote(status({ present: false, managed: true })), null);
    assert.strictEqual(M.ownSandboxFoldersNote(null), null);
  });
});
