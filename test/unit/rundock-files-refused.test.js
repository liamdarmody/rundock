'use strict';
// AN AGENT'S FILE-TOOL WRITE TO RUNDOCK'S OWN TWO FILES IS REFUSED BY THE HOOK,
// WITH NO CARD, IN EVERY RUN.
//
// .rundock/permissions.json and .rundock/state.json hold what the person
// decided for the workspace: the standing "Always allow" answers, the granted
// folders, the Working folders and the mode. Rundock writes them itself,
// in-process, and no agent needs to. A card for an agent's file-tool write to
// either one read like an ordinary file edit, and an Allow on it kept whatever
// the agent wrote, "allowedTools":["Bash"] included, as a standing permission.
// So the hook refuses a Write, Edit, MultiEdit or NotebookEdit of either file
// before any saved answer, folder grant, mode or card: in Code mode and Notes
// mode, in a conversation and in a routine. A shell command that writes either
// file keeps its card.
//
// The check is driven in-process for the spellings, with the case-folding seam
// set both ways rather than left to whichever filesystem the suite runs on.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hook = require('../../scripts/permission-hook.js');

const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const SYMLINKS = { skip: process.platform === 'win32' && 'a link needs privileges on Windows' };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-files-')));
const wsCode = path.join(root, 'ws-code');
const wsNotes = path.join(root, 'ws-notes');
// A workspace holding no .rundock folder at all, so a case variant of either
// file cannot be resolved by the filesystem before the comparison sees it, on
// any host.
const wsBare = path.join(root, 'ws-bare');
// Each workspace reached through a link, and a twin of it whose .rundock folder
// holds no permissions.json yet.
const linkOf = (ws) => `${ws}-link`;
const freshOf = (ws) => `${ws}-fresh`;
// Another Rundock workspace beside these, whose answer files are its own.
const wsOther = path.join(root, 'ws-other');

const permissionsFile = (ws) => path.join(ws, '.rundock', 'permissions.json');
const stateFile = (ws) => path.join(ws, '.rundock', 'state.json');
const noteFile = (ws) => path.join(ws, 'notes', 'a.md');

function makeWorkspace(ws, mode) {
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.writeFileSync(stateFile(ws), `${JSON.stringify({ workspaceMode: mode })}\n`);
  fs.writeFileSync(permissionsFile(ws), '{"allowedDirs":[],"allowedTools":[]}\n');
  fs.writeFileSync(path.join(ws, '.rundock', 'mcp-secrets.json'), '{}\n');
  fs.writeFileSync(path.join(ws, '.rundock', 'permission-hook.sh'), '#!/bin/sh\nexec node hook.js "$@"\n');
  fs.writeFileSync(path.join(ws, '.mcp.json'), '{}\n');
  fs.mkdirSync(path.join(ws, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), '{}\n');
  fs.writeFileSync(path.join(ws, '.claude', 'agents', 'example-agent.md'), '---\nname: example-agent\n---\nOriginal body.\n');
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
  fs.writeFileSync(noteFile(ws), 'Original body.\n');
}
for (const [ws, mode] of [[wsCode, 'code'], [wsNotes, 'notes']]) {
  makeWorkspace(ws, mode);
  fs.mkdirSync(path.join(freshOf(ws), '.rundock'), { recursive: true });
  fs.writeFileSync(stateFile(freshOf(ws)), `${JSON.stringify({ workspaceMode: mode })}\n`);
  if (!SYMLINKS.skip) {
    fs.symlinkSync(ws, linkOf(ws), 'dir');
    fs.symlinkSync(permissionsFile(ws), path.join(ws, 'notes', 'p.json'), 'file');
    fs.symlinkSync(path.join(ws, '.rundock'), path.join(ws, 'notes', 'r'), 'dir');
  }
}
makeWorkspace(wsOther, 'notes');
fs.mkdirSync(wsBare, { recursive: true });

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// A file-tool call naming `target` in the field its tool uses, or in `field`.
function edit(tool, target, field) {
  const key = field || (tool === 'NotebookEdit' ? 'notebook_path' : 'file_path');
  const rest = {
    Write: { content: '{"allowedTools":["Bash"]}\n' },
    Edit: { old_string: '"allowedTools":[]', new_string: '"allowedTools":["Bash"]' },
    MultiEdit: { edits: [{ old_string: '"allowedTools":[]', new_string: '"allowedTools":["Bash"]' }] },
    NotebookEdit: { new_source: '{"allowedTools":["Bash"]}', cell_type: 'code', edit_mode: 'replace' },
  }[tool];
  return { tool_name: tool, tool_input: { [key]: target, ...rest } };
}
const also = (request, extra) => ({ ...request, tool_input: { ...request.tool_input, ...extra } });

// The check, asked in-process. Every test reaches it through here, so a hook
// without it fails on this assertion rather than on a missing function.
function check(request, ws, foldsCase) {
  assert.strictEqual(typeof hook.isRundockAnswerFileEdit, 'function', 'the hook exports isRundockAnswerFileEdit');
  return hook.isRundockAnswerFileEdit(request.tool_name, request.tool_input, ws, foldsCase);
}

// Every way to spell either file, from the workspace `ws` is opened as.
const sep = path.sep;
function spellings(ws) {
  const link = linkOf(ws);
  const fresh = freshOf(ws);
  return [
    ['an absolute path to permissions.json', ws, edit('Write', permissionsFile(ws))],
    ['an absolute path to state.json', ws, edit('Write', stateFile(ws))],
    ['a relative path to permissions.json', ws, edit('Write', path.join('.rundock', 'permissions.json'))],
    ['a relative path to state.json', ws, edit('Edit', path.join('.rundock', 'state.json'))],
    ['./.rundock/permissions.json', ws, edit('Write', `.${sep}${path.join('.rundock', 'permissions.json')}`)],
    ['.rundock/../.rundock/state.json', ws, edit('Write', ['.rundock', '..', '.rundock', 'state.json'].join(sep))],
    ['notes/../.rundock/permissions.json, relative', ws, edit('Edit', ['notes', '..', '.rundock', 'permissions.json'].join(sep))],
    ['notes/../.rundock/permissions.json, absolute', ws, edit('Write', [ws, 'notes', '..', '.rundock', 'permissions.json'].join(sep))],
    ['a permissions.json that does not exist yet', fresh, edit('Write', permissionsFile(fresh))],
    ['a Write naming permissions.json in notebook_path', ws, edit('Write', permissionsFile(ws), 'notebook_path')],
    ['a Write naming state.json in path', ws, edit('Write', stateFile(ws), 'path')],
    ['an Edit naming state.json in notebook_path', ws, edit('Edit', stateFile(ws), 'notebook_path')],
    ['an Edit naming permissions.json in path', ws, edit('Edit', permissionsFile(ws), 'path')],
    ...(SYMLINKS.skip ? [] : [
      ['the workspace opened through a link, the target spelled through it', link, edit('Write', permissionsFile(link))],
      ['the workspace opened through a link, the target spelled by its real path', link, edit('Write', stateFile(ws))],
      ['the workspace opened by its real path, the target spelled through a link', ws, edit('Edit', permissionsFile(link))],
      ['a link inside the workspace to permissions.json', ws, edit('Write', path.join(ws, 'notes', 'p.json'))],
      ['a link inside the workspace to the .rundock folder', ws, edit('Write', path.join(ws, 'notes', 'r', 'state.json'))],
    ]),
  ];
}

// A CALL WHOSE PATH FIELDS DISAGREE. The runtime writes the field its tool
// names, and the boundary classifier reads that same field, so a check that
// read only the first field present could look at an ordinary note while the
// tool wrote one of these files. Every string path field is checked, so either
// file is refused whichever field names it and whatever the others say.
function conflicting(ws) {
  const note = noteFile(ws);
  return [
    ['a NotebookEdit naming a note in file_path and permissions.json in notebook_path', also(edit('NotebookEdit', permissionsFile(ws)), { file_path: note })],
    ['a NotebookEdit naming a note in notebook_path and state.json in path', also(edit('NotebookEdit', note), { path: stateFile(ws) })],
    ['a NotebookEdit naming permissions.json in file_path and a note in notebook_path', also(edit('NotebookEdit', note), { file_path: permissionsFile(ws) })],
    ['a NotebookEdit naming state.json in file_path and a number in notebook_path', also(edit('NotebookEdit', 7), { file_path: stateFile(ws) })],
    ['a Write naming a note in file_path and permissions.json in notebook_path', also(edit('Write', note), { notebook_path: permissionsFile(ws) })],
    ['a Write naming a note in file_path and state.json in path', also(edit('Write', note), { path: stateFile(ws) })],
    ['a Write naming permissions.json in file_path and a number in path', also(edit('Write', permissionsFile(ws)), { path: 7 })],
    ['an Edit naming a note in file_path and permissions.json in path', also(edit('Edit', note), { path: permissionsFile(ws) })],
    ['an Edit naming state.json in file_path and a note in notebook_path', also(edit('Edit', stateFile(ws)), { notebook_path: note })],
    ['a MultiEdit naming a note in file_path and state.json in path', also(edit('MultiEdit', note), { path: stateFile(ws) })],
    ['a MultiEdit naming permissions.json in file_path and a number in notebook_path', also(edit('MultiEdit', permissionsFile(ws)), { notebook_path: 7 })],
  ];
}

// The names beside the boundary: not these two files, so not this refusal.
function beside(ws) {
  const writeTo = (...parts) => edit('Write', path.join(ws, ...parts));
  return [
    ['.rundock/permissions.json.bak', writeTo('.rundock', 'permissions.json.bak')],
    ['.rundock/state.json.tmp', writeTo('.rundock', 'state.json.tmp')],
    ['.rundock/permissions', writeTo('.rundock', 'permissions')],
    ['notes/.rundock/permissions.json', writeTo('notes', '.rundock', 'permissions.json')],
    ["another workspace's .rundock/permissions.json", edit('Write', permissionsFile(wsOther))],
  ];
}

// The rest of the workspace's answer files, and the reads of these two.
function others(ws) {
  return [
    ['a Read of permissions.json', { tool_name: 'Read', tool_input: { file_path: permissionsFile(ws) } }],
    ['a Read of state.json', { tool_name: 'Read', tool_input: { file_path: stateFile(ws) } }],
    ['a Glob of the .rundock folder', { tool_name: 'Glob', tool_input: { pattern: '*.json', path: path.join(ws, '.rundock') } }],
    ['a Grep of state.json', { tool_name: 'Grep', tool_input: { pattern: 'workspaceMode', path: stateFile(ws) } }],
    ['a Write to .mcp.json', edit('Write', path.join(ws, '.mcp.json'))],
    ['a Write to .claude/settings.json', edit('Write', path.join(ws, '.claude', 'settings.json'))],
    ['a Write to .rundock/mcp-secrets.json', edit('Write', path.join(ws, '.rundock', 'mcp-secrets.json'))],
    ['a Write to .claude/settings.local.json', edit('Write', path.join(ws, '.claude', 'settings.local.json'))],
    ['a Write to the launcher', edit('Write', path.join(ws, '.rundock', 'permission-hook.sh'))],
    ['a Write to an agent file', edit('Write', path.join(ws, '.claude', 'agents', 'example-agent.md'))],
    ['a Write to notes/a.md', edit('Write', noteFile(ws))],
  ];
}

describe('the check, in-process', () => {
  test('each file tool on each of the two files is matched', () => {
    for (const ws of [wsCode, wsNotes]) {
      for (const tool of EDIT_TOOLS) {
        for (const target of [permissionsFile(ws), stateFile(ws)]) {
          for (const foldsCase of [true, false]) {
            assert.strictEqual(check(edit(tool, target), ws, foldsCase), true,
              `${tool} ${path.relative(ws, target)} (${path.basename(ws)}, foldsCase ${foldsCase})`);
          }
        }
      }
    }
  });

  test('every spelling of either file is matched', () => {
    for (const ws of [wsCode, wsNotes]) {
      for (const [what, opened, request] of spellings(ws)) {
        for (const foldsCase of [true, false]) {
          assert.strictEqual(check(request, opened, foldsCase), true, `${what} (${path.basename(ws)}, foldsCase ${foldsCase})`);
        }
      }
    }
  });

  test('either file named in any path field is matched, whatever the other fields say', () => {
    for (const ws of [wsCode, wsNotes]) {
      for (const [what, request] of conflicting(ws)) {
        for (const foldsCase of [true, false]) {
          assert.strictEqual(check(request, ws, foldsCase), true, `${what} (${path.basename(ws)}, foldsCase ${foldsCase})`);
        }
      }
    }
  });

  // THE FOLDING SEAM, BOTH WAYS. On a filesystem that folds case,
  // `.rundock/PERMISSIONS.json` is the permissions file, whether or not it
  // exists yet; on one that does not, it is a different file Rundock never
  // reads. The bare workspace holds neither file, so the filesystem cannot
  // correct the case before the comparison sees it.
  test('a case variant is matched exactly where case folds, driven both ways through the seam', () => {
    const rows = [
      [path.join(wsBare, '.rundock', 'PERMISSIONS.json'), true, true],
      [path.join(wsBare, '.RUNDOCK', 'state.json'), true, true],
      [path.join(wsBare, '.rundock', 'PERMISSIONS.json'), false, false],
      [path.join(wsBare, '.RUNDOCK', 'state.json'), false, false],
      [path.join(wsBare, '.rundock', 'permissions.json'), true, true],
      [path.join(wsBare, '.rundock', 'state.json'), false, true],
    ];
    for (const [target, foldsCase, matched] of rows) {
      assert.strictEqual(check(edit('Write', target), wsBare, foldsCase), matched, `${path.relative(wsBare, target)}, foldsCase ${foldsCase}`);
    }
    assert.strictEqual(typeof hook.hostFoldsCase, 'function', 'the hook exports hostFoldsCase');
    assert.strictEqual(check(edit('Write', path.join(wsBare, '.rundock', 'PERMISSIONS.json')), wsBare), hook.hostFoldsCase(),
      'with no seam given, the host decides');
  });

  test('the names beside the two files, and every other file, are not matched', async (t) => {
    for (const ws of [wsCode, wsNotes]) {
      for (const [what, request] of [...beside(ws), ...others(ws)]) {
        await t.test(`${what} (${path.basename(ws)})`, () => {
          for (const foldsCase of [true, false]) {
            assert.strictEqual(check(request, ws, foldsCase), false, `${what} (${path.basename(ws)}, foldsCase ${foldsCase})`);
          }
        });
      }
    }
  });

  test('a call with no string path, or no input, is not matched', () => {
    for (const input of [undefined, null, {}, { file_path: '' }, { file_path: 7 }, { content: 'x' }]) {
      assert.strictEqual(check({ tool_name: 'Write', tool_input: input }, wsCode), false, JSON.stringify(input));
    }
  });

  test('the check reaches its seam once for each string target it compares', () => {
    assert.strictEqual(typeof (hook.rundockAnswerFileSeam && hook.rundockAnswerFileSeam.beforeChecking), 'function', 'the seam is a module attribute');
    const seen = [];
    const was = hook.rundockAnswerFileSeam.beforeChecking;
    hook.rundockAnswerFileSeam.beforeChecking = (target) => { seen.push(target); };
    try {
      check({ tool_name: 'Read', tool_input: { file_path: permissionsFile(wsNotes) } }, wsNotes);
      check({ tool_name: 'Write', tool_input: {} }, wsNotes);
      check({ tool_name: 'Write', tool_input: { file_path: noteFile(wsNotes), notebook_path: 7, path: stateFile(wsNotes) } }, wsNotes);
    } finally {
      hook.rundockAnswerFileSeam.beforeChecking = was;
    }
    assert.deepStrictEqual(seen, [noteFile(wsNotes), stateFile(wsNotes)]);
  });
});
