'use strict';
// The card a person sees for what still asks in Code mode, and the words on it.
//
// THE INTERFACE THESE TESTS FIX, in public/permissions.js:
//   decidePermission(risk, key, allowedSet, verdict)   the verdict, when present, decides
//   offersAlwaysAllow(risk, verdict)                    only Asks once offers it, in Code mode
//   verdictAllowKey(verdict)                            the rule's own standing-allow key
//   verdictCardCopy(verdict) -> { sentence, closing, allowLabel, alwaysLabel }
//   alwaysAskCopy(crossing)                             now also for { hiddenHome, write } and
//                                                       { instructionFile }
//   ruleKeyLabel(key)                                   a stored rule key in words, for Settings
//
// With no verdict every function behaves exactly as on 0.15.0, which is every
// Notes-mode request.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RP = require('../../public/permissions.js');
const ROOT = path.join(__dirname, '..', '..');

const V = {
  runs: { verdict: 'runs' },
  pushMain: { verdict: 'asks-once', rule: 'Bash:git-push:default-branch', branch: 'main' },
  tags: { verdict: 'asks-once', rule: 'Bash:git-push:tags' },
  unsaved: { verdict: 'always-asks', reason: 'unsaved-work', files: ['src/legacy/new-parser.ts', 'src/legacy/notes.md'], more: 3 },
};

describe('the verdict decides the card in Code mode', () => {
  test('runs is allowed, whatever the old grader thought of the text', () => {
    assert.strictEqual(RP.decidePermission('high', 'Bash:rm', new Set(), V.runs).action, 'allow');
  });

  test('always-asks is carded ahead of every standing allow, and never offers Always allow', () => {
    const everything = new Set(['Bash:rm', 'Bash:git', 'Bash:git-push:default-branch']);
    assert.strictEqual(RP.decidePermission('medium', 'Bash:rm', everything, V.unsaved).action, 'card');
    assert.strictEqual(RP.offersAlwaysAllow('medium', V.unsaved), false);
    assert.strictEqual(RP.offersAlwaysAllow('low', V.unsaved), false);
  });

  test('asks-once offers Always allow under its rule key, and only that key answers it', () => {
    assert.strictEqual(RP.offersAlwaysAllow('high', V.pushMain), true, 'offered even where the old grader said high');
    assert.strictEqual(RP.verdictAllowKey(V.pushMain), 'Bash:git-push:default-branch');
    assert.strictEqual(RP.decidePermission('high', 'Bash:git', new Set(['Bash:git']), V.pushMain).action, 'card', 'a legacy binary key never answers it');
    assert.strictEqual(RP.decidePermission('high', 'Bash:git-push:tags', new Set(['Bash:git-push:tags']), V.pushMain).action, 'card', 'nor does another rule\'s key');
    assert.strictEqual(RP.decidePermission('high', 'Bash:git-push:default-branch', new Set(['Bash:git-push:default-branch']), V.pushMain).action, 'allow');
  });

  test('with no verdict, today\'s grading is untouched', () => {
    assert.strictEqual(RP.decidePermission('high', 'Bash:rm', new Set(['Bash:rm'])).action, 'card');
    assert.strictEqual(RP.decidePermission('medium', 'Bash:npm', new Set(['Bash:npm'])).action, 'allow');
    assert.strictEqual(RP.offersAlwaysAllow('high'), false);
    assert.strictEqual(RP.offersAlwaysAllow('medium'), true);
  });
});

describe('the Always-asks card copy is exact', () => {
  const CLOSING = 'Rundock asks about commands like this every time, even in Code mode, so there is no Always allow.';
  const CASES = [
    [V.unsaved, 'This deletes files git has never saved: src/legacy/new-parser.ts, src/legacy/notes.md and 3 more would be lost for good.'],
    [{ verdict: 'always-asks', reason: 'unsaved-discard', files: ['src/app.js'], more: 0 }, 'This throws away changes git has never saved: src/app.js would be lost for good.'],
    [{ verdict: 'always-asks', reason: 'outside-repository' }, 'This deletes a folder that isn\'t in a git repository, so nothing can bring it back.'],
    [{ verdict: 'always-asks', reason: 'repository' }, 'This deletes the repository\'s history, which is what lets every other change be undone.'],
    [{ verdict: 'always-asks', reason: 'git-internals' }, 'This changes git\'s own files, which are what let every other change be undone.'],
    [{ verdict: 'always-asks', reason: 'find-from-top' }, 'Starting at the top of the repository, this can delete git\'s own files as well as yours.'],
    [{ verdict: 'always-asks', reason: 'unknown-targets' }, 'This deletes files whose names are only worked out when it runs, so Rundock can\'t check what they are.'],
    [{ verdict: 'always-asks', reason: 'unreadable-command' }, 'Rundock can\'t tell what this command will do until it runs, so it asks first.'],
    [{ verdict: 'always-asks', reason: 'force-push', remoteBranch: 'origin/feat/x' }, 'This replaces the history of origin/feat/x. Commits that are only on the remote will be lost.'],
    [{ verdict: 'always-asks', reason: 'force-push-default', branch: 'main' }, 'This rewrites main, the branch everyone else builds on.'],
    [{ verdict: 'always-asks', reason: 'stash-or-reflog' }, 'This deletes git\'s only saved copy of those changes.'],
    [{ verdict: 'always-asks', reason: 'elevation' }, 'This runs as an administrator, beyond anything Rundock can see or check.'],
    [{ verdict: 'always-asks', reason: 'fetched-code' }, 'This runs a script from the internet without showing it to anyone first.'],
    [{ verdict: 'always-asks', reason: 'volumes' }, 'This deletes the Docker volumes for this project, including any database data in them.'],
    [{ verdict: 'always-asks', reason: 'disk' }, 'This writes directly to a disk or erases one.'],
    [{ verdict: 'always-asks', reason: 'publish' }, 'This publishes a package version that can never be replaced.'],
    [{ verdict: 'always-asks', reason: 'every-process' }, 'This stops every program you have open, Rundock included.'],
  ];
  for (const [v, sentence] of CASES) {
    test(v.reason, () => {
      const copy = RP.verdictCardCopy(v);
      assert.strictEqual(copy.sentence, sentence);
      assert.strictEqual(copy.closing, CLOSING);
      assert.strictEqual(copy.allowLabel, 'Allow once', 'the Allow button reads "Allow once" on this card');
      assert.strictEqual(copy.alwaysLabel, null);
    });
  }
});

describe('the Asks-once card copy is exact', () => {
  const CASES = [
    [V.pushMain, 'This can be undone, but other people see it first: it pushes to main, the branch this repository treats as its default.', 'Always allow pushes to main'],
    [{ verdict: 'asks-once', rule: 'Bash:git-push:default-branch', branch: 'trunk' }, 'This can be undone, but other people see it first: it pushes to trunk, the branch this repository treats as its default.', 'Always allow pushes to trunk'],
    [V.tags, 'This can be undone, but a pushed tag often starts a release.', 'Always allow pushing tags'],
    [{ verdict: 'asks-once', rule: 'Bash:git-push:delete-remote-ref', ref: 'feat/x', remote: 'origin' }, 'This removes feat/x from origin. Your copy stays, but others lose it.', 'Always allow deleting remote branches'],
    [{ verdict: 'asks-once', rule: 'PowerShell:execution-policy:change' }, 'This changes which scripts Windows will run for your account.', 'Always allow execution policy changes'],
  ];
  for (const [v, sentence, label] of CASES) {
    test(label, () => {
      const copy = RP.verdictCardCopy(v);
      assert.strictEqual(copy.sentence, sentence);
      assert.strictEqual(copy.alwaysLabel, label);
      assert.strictEqual(copy.allowLabel, 'Allow');
    });
  }
});

describe('the hidden-folder and instruction-file cards', () => {
  test('~/.ssh, read', () => {
    assert.strictEqual(RP.alwaysAskCopy({ hiddenHome: '.ssh', write: false }),
      'This reads inside ~/.ssh, where your SSH keys are kept. '
      + 'Rundock asks every time for this folder and can\'t offer to remember it: one "always" here would hand over your private keys along with it. '
      + 'Connecting over SSH and pushing with git don\'t need this, and never ask. '
      + 'If you do want agents working in this folder, name ~/.ssh yourself under Settings, Permissions, Folders agents can also change.');
  });

  test('another hidden folder is named, and a write says "changes"', () => {
    const read = RP.alwaysAskCopy({ hiddenHome: '.aws', write: false });
    assert.ok(read.startsWith('This reads inside ~/.aws, a folder where tools usually keep credentials.'), read);
    const write = RP.alwaysAskCopy({ hiddenHome: '.aws', write: true });
    assert.ok(write.startsWith('This changes inside ~/.aws, a folder where tools usually keep credentials.'), write);
    assert.ok(read.includes('name ~/.aws yourself under Settings, Permissions, Folders agents can also change.'));
  });

  test('a global instruction file', () => {
    assert.strictEqual(RP.alwaysAskCopy({ instructionFile: true }),
      'This file is loaded as instructions by every later session in every workspace, including routines that run unattended. '
      + 'An agent can ask to change it, but Rundock asks every time and can\'t remember the answer.');
  });
});

describe('Settings', () => {
  test('a stored rule key is listed in words', () => {
    assert.strictEqual(RP.ruleKeyLabel('Bash:git-push:default-branch'), 'Pushes to the default branch');
  });

  test('the Code-mode description says exactly what the mode now does', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'views', 'settings.js'), 'utf8');
    assert.ok(src.includes("Websites and software. Agents can edit code and run everyday development commands without asking. Commands that can't be undone still ask every time."),
      'the description in public/views/settings.js');
  });
});

describe('the server relays the verdict by name', () => {
  test('the request object the browser receives carries code_mode_verdict', () => {
    // The request object is built from a whitelist: a field the hook sends is
    // dropped unless it is named, which is how the advisory list was once
    // computed, sent and discarded.
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'http-router.js'), 'utf8');
    assert.match(src, /code_mode_verdict:\s*data\.code_mode_verdict/);
  });
});
