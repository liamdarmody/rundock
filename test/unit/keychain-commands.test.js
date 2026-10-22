'use strict';
// A shell command that reads or changes an item in the Mac's Keychain asks
// every time, with Allow and Deny only.
//
// WHY THE CARD IS THE ONLY LAYER. On macOS the runtimes keep their live sign-in
// tokens as Keychain items, and the command sandbox lets every command reach
// the Keychain service, because the runtime itself signs in through it. A
// sandboxed `security find-generic-password` searches the Keychain and prints
// what it finds, so nothing underneath stops one command from reading a token.
//
// Here the verdict is driven in process, over every subcommand that asks, the
// ones that only display and still run, and every place in a line the command
// can sit. The same commands through the real hook, server and card are in
// test/integration/keychain-approvals.test.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { codeModeVerdict, keychainVerdict } = require('../../scripts/code-mode-verdict.js');
const { gradeCodexApproval } = require('../../lib/runtime/codex-approval.js');
const RP = require('../../public/permissions.js');
const RepeatHint = require('../../public/repeat-hint-model.js');

// A workspace and home that exist nowhere: no disk or git fact decides whether
// a line reaches the Keychain, so none is consulted (`context` is empty).
const WS = '/work/space';
const HOME = '/home/agent';
const SVC = 'example-service';
const K = `security find-generic-password -w -s ${SVC}`;
const KEYCHAIN = { verdict: 'always-asks', reason: 'keychain' };
const SENTENCE = 'This reads or changes a password or key stored in your Mac\'s Keychain, where sign-in tokens are kept.';
// The Keychain verdict, with the other reason to always ask the line holds, if any.
const keychainWith = also => (also ? { ...KEYCHAIN, also: { verdict: 'always-asks', reason: also } } : KEYCHAIN);

function codeMode(command) {
  return codeModeVerdict({ toolName: 'Bash', command, cwd: WS, workspaceRoot: WS, extraDirs: [], home: HOME, platform: 'darwin', context: {} });
}
// Notes mode has no verdict of its own, and asks the hook this one question.
function notesMode(command) {
  return keychainVerdict({ toolName: 'Bash', command, cwd: WS, workspaceRoot: WS, extraDirs: [], home: HOME, platform: 'darwin' });
}

// Every subcommand that asks, with the arguments an agent would give it.
const ASKS = [
  // A secret printed: the password itself, or a certificate in full.
  `find-generic-password -w -s ${SVC}`,
  `find-generic-password -g -s ${SVC}`,
  `find-generic-password -s ${SVC} -w`,
  'find-internet-password -w -s example.com',
  'find-internet-password -g -s example.com',
  'find-certificate -p -c example',
  'find-certificate -a -p',
  'dump-keychain',
  'dump-keychain -d example.keychain',
  'export -k example.keychain -t identities -f pkcs12 -o example.p12',
  'export-identity',
  // Attributes only: no secret printed, but the account and service names
  // that tell the next command exactly which item holds a token.
  `find-generic-password -s ${SVC}`,
  'find-generic-password -a someone',
  'find-internet-password -s example.com',
  'find-certificate -c example',
  'find-key -l example',
  // An item or a keychain changed.
  `delete-generic-password -s ${SVC}`,
  'delete-internet-password -s example.com',
  'delete-keychain example.keychain',
  `add-generic-password -a someone -s ${SVC} -w example-value`,
  'add-internet-password -a someone -s example.com -w example-value',
  `set-generic-password-partition-list -S apple-tool: -s ${SVC}`,
  'set-internet-password-partition-list -S apple-tool: -s example.com',
  'set-key-partition-list -S apple-tool: -k example-value',
  'unlock-keychain -p example-value',
  'lock-keychain -a',
  'set-keychain-settings -t 3600',
  'set-keychain-password',
  'create-keychain -p example-value example.keychain',
  'import example.p12 -k example.keychain',
  'add-trusted-cert -d -r trustRoot example.pem',
  'authorizationdb read system.privilege.admin',
  'cms -D -i example.p7m',
  // The display commands with -s set the list or the default instead.
  'list-keychains -s example.keychain',
  'list-keychains -d user -s example.keychain',
  'default-keychain -s example.keychain',
  'login-keychain -s example.keychain',
  // A shortened name is not guessed at.
  `find-generic-pass -w -s ${SVC}`,
  'dump',
  // Interactive mode reads its commands from stdin, where nothing sees them.
  '-i',
  '-p example-prompt',
  '-q -i',
  // A subcommand only known when the line runs.
  `$SUB -w -s ${SVC}`,
  '"$(printf dump-keychain)"',
  'find-*',
];

// Commands that only display the keychain list or settings, check a
// certificate, or print help. They run as they always have.
const DISPLAYS = [
  'list-keychains',
  'list-keychains -d user',
  'default-keychain',
  'default-keychain -d user',
  'login-keychain',
  'show-keychain-info',
  'show-keychain-info example.keychain',
  'verify-cert -c example.pem',
  'find-identity -v -p codesigning',
  'help',
  '-h',
  'error -25300',
  '-q list-keychains',
  // With no command and no -i or -p, security prints its list of commands.
  '',
];

// Lines that name `security` without running it.
const MENTIONS = [
  'grep -r security src',
  'echo security dump-keychain',
  'command -v security',
  'which security',
  'man security',
  'git commit -m "security: tighten the check"',
];

// Every place in a line the command can sit.
const POSITIONS = [
  ['on its own', K],
  ['by its full path', `/usr/bin/security find-generic-password -w -s ${SVC}`],
  ['with its name quoted', `"security" find-generic-password -w -s ${SVC}`],
  ['with its name escaped', `\\security find-generic-password -w -s ${SVC}`],
  ['spelled in capitals, which a Mac reads as the same program', `SECURITY find-generic-password -w -s ${SVC}`],
  ['after command', `command ${K}`],
  ['after env', `env ${K}`],
  ['after env VAR=', `env LANG=C ${K}`],
  ['after an assignment', `LANG=C ${K}`],
  ['after sudo', `sudo ${K}`, 'elevation'],
  ['after sudo and its options', `sudo -u root -E ${K}`, 'elevation'],
  ['after sudo and its long options', `sudo --user root --preserve-env ${K}`, 'elevation'],
  ['after sudo with a value joined to its option', `sudo -uroot ${K}`, 'elevation'],
  ['after doas', `doas ${K}`, 'elevation'],
  ['after nice', `nice ${K}`],
  ['after nice -n', `nice -n 10 ${K}`],
  ['after nice and sudo', `nice sudo ${K}`, 'elevation'],
  ['after time', `time ${K}`],
  ['after nohup', `nohup ${K}`],
  ['after exec', `exec ${K}`],
  ['after timeout', `timeout 5 ${K}`],
  ['second in a chain', `cd src && ${K}`],
  ['after a semicolon', `true; ${K}`],
  ['after ||', `false || ${K}`],
  ['on a second line', `echo start\n${K}`],
  ['in the background', `${K} &`],
  ['first in a pipe', `${K} | pbcopy`],
  ['last in a pipe', `echo ${SVC} | ${K}`],
  ['in a subshell', `(${K})`],
  ['in a group', `{ ${K}; }`],
  ['in a substitution', `echo "$(${K})"`],
  ['in a substitution assigned to a variable', `TOKEN=$(${K})`],
  ['in backticks', `echo \`${K}\``],
  ['in a process substitution', `cat <(${K})`],
  ['behind if', `if ${K}; then echo found; fi`],
  ['through xargs', `echo ${SVC} | xargs security find-generic-password -w -s`],
  ['through xargs -I', `echo ${SVC} | xargs -I{} security find-generic-password -w -s {}`],
  ['through xargs and sudo', `echo ${SVC} | xargs sudo security find-generic-password -w -s`, 'elevation'],
  ['through find -exec', `find . -name x -exec ${K} \\;`],
  ['through find -exec and sudo', `find . -name x -exec sudo ${K} \\;`, 'elevation'],
  ['inside bash -c', `bash -c "${K}"`],
  ['inside sh -c', `sh -c '${K}'`],
  ['inside zsh -c', `zsh -c "${K}"`],
  ['inside bash -lc', `bash -lc "${K}"`],
  ['inside sudo bash -c', `sudo bash -c "${K}"`, 'elevation'],
  ['in a here-document fed to bash', `bash <<EOF\n${K}\nEOF`],
  ['in a quoted here-document fed to sh', `sh <<'EOF'\n${K}\nEOF`],
  ['in a here-string fed to bash', `bash <<< "${K}"`],
  ['before a here-document that never ends', `${K} <<EOF\nmore`, 'unreadable-command'],
  ['after a command that asks for another reason', `eval "$X"; ${K}`, 'unreadable-command'],
  ['before a command that asks for another reason', `${K}; eval "$X"`, 'unreadable-command'],
];

describe('in Code mode, a Keychain command always asks, and says it is the Keychain', () => {
  for (const args of ASKS) {
    test(`security ${args}`, () => {
      assert.deepStrictEqual(codeMode(`security ${args}`), KEYCHAIN);
    });
  }
  for (const [where, command, also] of POSITIONS) {
    test(where, () => {
      assert.deepStrictEqual(codeMode(command), keychainWith(also), command);
    });
  }
});

describe('in Code mode, what only displays runs as it always has', () => {
  for (const args of DISPLAYS) {
    test(`security ${args}`.trim(), () => {
      assert.deepStrictEqual(codeMode(`security ${args}`.trim()), { verdict: 'runs' });
    });
  }
  for (const command of MENTIONS) {
    test(command, () => {
      assert.deepStrictEqual(codeMode(command), { verdict: 'runs' });
    });
  }
  test('a display command beside the same everyday work still runs', () => {
    assert.deepStrictEqual(codeMode('security list-keychains && security find-identity -v -p codesigning'), { verdict: 'runs' });
  });
});

describe('what reading the elevation adds, and what it leaves alone', () => {
  test('sudo on its own, or with another program, still asks as elevation', () => {
    assert.deepStrictEqual(codeMode('sudo'), { verdict: 'always-asks', reason: 'elevation' });
    assert.deepStrictEqual(codeMode('sudo ls /var/root'), { verdict: 'always-asks', reason: 'elevation' });
    assert.deepStrictEqual(codeMode('sudo security list-keychains'), { verdict: 'always-asks', reason: 'elevation' });
    assert.deepStrictEqual(codeMode('echo x | xargs sudo ls'), { verdict: 'always-asks', reason: 'elevation' });
  });
});

// A context that counts every fact the verdict asks the disk or git for, and
// answers as a repository holding unsaved work under build/ would.
function counting() {
  const calls = { n: 0 };
  const tick = (v) => () => { calls.n++; return v; };
  return {
    calls,
    context: {
      exists: tick(true), gitTop: tick(WS), currentBranch: tick('feat/x'), defaultBranches: tick(['main']),
      gitStatus: tick({ ok: true, tracked: [], untracked: ['build/new.txt'], ignoredEnv: [] }),
      isTag: tick(false), isSymlink: tick(false), readList: tick(null),
    },
  };
}
function notesModeCounting(command) {
  const c = counting();
  const v = keychainVerdict({ toolName: 'Bash', command, cwd: WS, workspaceRoot: WS, extraDirs: [], home: HOME, platform: 'darwin', context: c.context });
  return { v, calls: c.calls.n };
}
function codeModeCounting(command) {
  const c = counting();
  const v = codeModeVerdict({ toolName: 'Bash', command, cwd: WS, workspaceRoot: WS, extraDirs: [], home: HOME, platform: 'darwin', context: c.context });
  return { v, calls: c.calls.n };
}

describe('reading for the Keychain asks the disk and git for nothing', () => {
  test('the counter counts: an ordinary delete still reads git', () => {
    const r = codeModeCounting('rm -rf build');
    assert.strictEqual(r.v.reason, 'unsaved-work');
    assert.ok(r.calls > 0);
  });

  test('what sudo, doas, xargs sudo and find -exec sudo run', () => {
    for (const command of ['sudo -- rm -rf build', 'doas rm -rf build', 'echo build | xargs sudo rm -rf',
      'find . -name x -exec sudo rm -rf build \\;', 'sudo git clean -fdx', 'sudo bash -c "rm -rf build"']) {
      assert.deepStrictEqual(codeModeCounting(command), { v: { verdict: 'always-asks', reason: 'elevation' }, calls: 0 }, command);
    }
  });

  test('a line whose here-document never ends', () => {
    for (const command of ['cat <<EOF\nrm -rf build\ngit clean -fdx\n', 'rm -rf build <<EOF\nmore', 'bash <<EOF\nrm -rf build\n']) {
      assert.deepStrictEqual(codeModeCounting(command), { v: { verdict: 'always-asks', reason: 'unreadable-command' }, calls: 0 }, command);
    }
  });

  // The bound itself, exactly, on any host: how deep a chain must go to
  // overflow the stack without it depends on the machine, so that is not
  // what proves the bound is there.
  test('elevations are read eight deep and no further', () => {
    const chain = n => `echo ${SVC} | ${'xargs sudo '.repeat(n)}${K}`;
    assert.deepStrictEqual(codeMode(chain(8)), keychainWith('elevation'), 'eight deep, the Keychain is named');
    assert.deepStrictEqual(codeMode(chain(9)), { verdict: 'always-asks', reason: 'elevation' }, 'nine deep, it asks as elevation');
    assert.strictEqual(notesMode(chain(9)), null, 'and Notes mode grades it as before');
  });

  // A wall-clock budget, listed in docs/TEST-TIMING.md: reading past a long
  // chain of elevations once took 172ms at 500 and overflowed the stack at
  // 2000; read word by word and only so deep, it takes a few milliseconds.
  test('a long chain of xargs and sudo is read quickly, and still asks', () => {
    for (const k of [500, 2000]) {
      const command = `echo x | ${'xargs sudo '.repeat(k)}ls`;
      const started = Date.now();
      assert.deepStrictEqual(codeModeCounting(command), { v: { verdict: 'always-asks', reason: 'elevation' }, calls: 0 }, `${k} deep`);
      assert.strictEqual(notesMode(command), null);
      assert.ok(Date.now() - started < 1000, `${k} deep took ${Date.now() - started}ms`);
    }
  });
});

describe('the Keychain is named, and what else on the line cannot be undone is kept', () => {
  // What the delete alone is asked about: files under build/ git has never saved.
  const alone = () => codeModeCounting('rm -rf build').v;

  for (const command of [`rm -rf build && ${K}`, `${K} && rm -rf build`]) {
    test(command, () => {
      assert.strictEqual(alone().reason, 'unsaved-work');
      assert.deepStrictEqual(codeModeCounting(command).v, { ...KEYCHAIN, also: alone() }, 'Code mode');
      assert.deepStrictEqual(notesModeCounting(command).v, { ...KEYCHAIN, also: alone() }, 'Notes mode');
    });
  }

  test('the first other reason on the line is the one kept', () => {
    assert.deepStrictEqual(codeModeCounting(`eval "$X"; rm -rf build; ${K}`).v, keychainWith('unreadable-command'));
    assert.deepStrictEqual(codeModeCounting(`rm -rf build; ${K}; eval "$X"`).v, { ...KEYCHAIN, also: alone() });
  });

  test('Notes mode reads the facts only for a line that reaches the Keychain', () => {
    assert.deepStrictEqual(notesModeCounting('rm -rf build'), { v: null, calls: 0 });
    assert.ok(notesModeCounting(`rm -rf build && ${K}`).calls > 0);
  });

  test('the card says both', () => {
    assert.strictEqual(RP.verdictCardCopy({ ...KEYCHAIN, also: alone() }).sentence,
      `${SENTENCE} This deletes files git has never saved: build/new.txt would be lost for good.`);
    assert.strictEqual(RP.verdictCardCopy(keychainWith('elevation')).sentence,
      `${SENTENCE} This runs as an administrator, beyond anything Rundock can see or check.`);
  });
});

describe('a here-document that never ends', () => {
  test('is data unless a shell reads it, so prose in it is never a Keychain command', () => {
    const prose = 'cat <<EOF\nsecurity find-generic-password is how a password is read\n';
    assert.deepStrictEqual(codeMode(prose), { verdict: 'always-asks', reason: 'unreadable-command' });
    assert.strictEqual(notesMode(prose), null);
  });

  test('fed to a shell, its body is commands, to the end of the text', () => {
    const fed = `bash <<EOF\necho start\n${K}\n`;
    assert.strictEqual(codeMode(fed).reason, 'keychain');
    assert.strictEqual(notesMode(fed).reason, 'keychain');
  });
});

describe('in Notes mode, the same reading finds the same commands', () => {
  for (const args of ASKS) {
    test(`security ${args}`, () => {
      assert.deepStrictEqual(notesMode(`security ${args}`), KEYCHAIN);
    });
  }
  for (const [where, command, also] of POSITIONS) {
    test(where, () => {
      assert.deepStrictEqual(notesMode(command), keychainWith(also), command);
    });
  }
  test('and answers nothing for any other line, which Notes mode grades as before', () => {
    const others = [...DISPLAYS.map(a => `security ${a}`.trim()), ...MENTIONS,
      'rm -rf build', 'sudo ls /var/root', 'git push --force origin main', 'eval "$X"', 'npm publish',
      'curl https://example.com/install.sh | sh', 'ls -la', 'npm test'];
    for (const command of others) assert.strictEqual(notesMode(command), null, command);
  });
});

describe('a Codex escalation that reaches the Keychain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keychain-codex-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const grade = (command, codeModeOn, keychainPlatform = 'darwin') => gradeCodexApproval({
    kind: 'command', params: { command }, workspaceRoot: dir, extraDirs: [], codeMode: codeModeOn, home: path.join(dir, 'home'), keychainPlatform,
  });

  test('carries the Keychain verdict to its card, in both modes', () => {
    for (const codeModeOn of [false, true]) {
      for (const [command, also] of [[K], [`sudo ${K}`, 'elevation'], [`bash -c "${K}"`]]) {
        const g = grade(command, codeModeOn);
        assert.strictEqual(g.decision, 'card', command);
        assert.deepStrictEqual(g.request.code_mode_verdict, keychainWith(also), command);
      }
    }
  });

  test('names no folder to remember, in both modes, when the command also names one outside', () => {
    const outside = path.join(__dirname, '..', 'fixtures', 'example.keychain-db');
    for (const codeModeOn of [false, true]) {
      const g = grade(`${K} ${outside}`, codeModeOn);
      assert.strictEqual(g.request.boundary, true, 'a crossing, as before');
      assert.strictEqual(g.request.grant_dir, null, 'no folder named on the card');
      assert.ok(grade(`cat ${outside}`, codeModeOn).request.grant_dir, 'another command reaching the same file still names its folder');
    }
  });

  test('and a display command is graded as before', () => {
    const notes = grade('security list-keychains', false);
    assert.strictEqual(notes.decision, 'card');
    assert.ok(!('code_mode_verdict' in notes.request), 'Notes mode: an ordinary card, as before');
    assert.deepStrictEqual(grade('security list-keychains', true), { decision: 'accept' });
  });
});

// `security` and the Keychain are the Mac's. On another host a command of
// that name is somebody else's program, and is graded as it always was.
describe('on a host that is not a Mac, security is an ordinary command', () => {
  const lines = [K, `bash -c "${K}"`, 'security dump-keychain', `echo ${SVC} | xargs security find-generic-password -w -s`];
  for (const platform of ['linux', 'win32']) {
    test(platform, () => {
      for (const command of lines) {
        const opts = { toolName: 'Bash', command, cwd: WS, workspaceRoot: WS, extraDirs: [], home: HOME, platform, context: {} };
        assert.deepStrictEqual(codeModeVerdict(opts), { verdict: 'runs' }, command);
        assert.strictEqual(keychainVerdict(opts), null, command);
      }
      assert.deepStrictEqual(codeModeVerdict({ toolName: 'Bash', command: `sudo ${K}`, workspaceRoot: WS, home: HOME, platform, context: {} }),
        { verdict: 'always-asks', reason: 'elevation' }, 'sudo still asks, as elevation');
    });
  }
  // The Keychain rules follow `keychainPlatform` and nothing else does: path
  // handling and the delete checks stay on `platform`, the real host.
  test('the Keychain gate has a platform of its own', () => {
    const v = (platform, keychainPlatform) => codeModeVerdict({ toolName: 'Bash', command: K, workspaceRoot: WS, home: HOME, platform, keychainPlatform, context: {} });
    assert.deepStrictEqual(v('linux', 'darwin'), KEYCHAIN);
    assert.deepStrictEqual(v('darwin', 'linux'), { verdict: 'runs' });
    assert.deepStrictEqual(v('darwin', undefined), KEYCHAIN, 'with none named, the host\'s');
  });

  test('nor does a Codex escalation carry the Keychain verdict there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keychain-codex-linux-'));
    try {
      const grade = codeModeOn => gradeCodexApproval({ kind: 'command', params: { command: K }, workspaceRoot: dir, codeMode: codeModeOn, home: path.join(dir, 'home'), keychainPlatform: 'linux' });
      assert.ok(!('code_mode_verdict' in grade(false).request), 'Notes mode: an ordinary card');
      assert.deepStrictEqual(grade(true), { decision: 'accept' }, 'Code mode: runs');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// WHAT THE READER CANNOT SEE, AS ARCHITECTURE.md LISTS IT. Each example is
// found in the group the document puts it in, and does what that group says:
// the first still asks in Code mode, as a command Rundock cannot read; the
// second runs with no card. Neither is a Keychain verdict in Notes mode.
describe('what the reader cannot see, as ARCHITECTURE.md lists it', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'ARCHITECTURE.md'), 'utf8');
  const at = doc.indexOf('**What it cannot see, in two groups.**');
  const runsAt = doc.indexOf('These run with no card in Code mode:', at);
  const endAt = doc.indexOf('In Notes mode both groups are carded as before', runsAt);
  const STILL_ASK = [
    ['`eval`', `eval "${K}"`],
    ['a `case`', `case x in *) ${K};; esac`],
    ['a function definition', `k() { ${K}; }; k`],
    ['`caffeinate`', `caffeinate -i ${K}`],
    ['`arch`', `arch -arm64 ${K}`],
    ['`script`', `script -q /dev/null ${K}`],
    ['`stdbuf`', `stdbuf -oL ${K}`],
    ['`watch`', `watch ${K}`],
    ['`parallel`', `parallel ${K} ::: a`],
    ['`env -S`', `env -S "${K}"`],
    ["`$'security'`", `$'security' find-generic-password -w -s ${SVC}`],
    ['a glob', `sec*rity find-generic-password -w -s ${SVC}`],
    ['a variable', `$TOOL find-generic-password -w -s ${SVC}`],
  ];
  const RUN = [
    ['`python3 -c`', 'python3 -c "print(1)"'],
    ['`node -e`', 'node -e "1"'],
    ['`perl -e`', "perl -e 'print 1'"],
    ['`ruby -e`', "ruby -e 'p 1'"],
    ['`osascript -e`', "osascript -e 'return 1'"],
    ['`./k.sh`', './k.sh'],
    ['`bash script.sh`', 'bash script.sh'],
    ['`bash < script.sh`', 'bash < script.sh'],
    ['`source`', 'source k.sh'],
    ['a symlink', `./kc find-generic-password -w -s ${SVC}`],
    ['a copy', `bin/sec find-generic-password -w -s ${SVC}`],
    ['an alias', `alias s=security; s find-generic-password -w -s ${SVC}`],
    ['`xcrun security`', `xcrun security find-generic-password -w -s ${SVC}`],
    ["`echo '…' | sh`", `echo '${K}' | sh`],
  ];

  test('the passage is there, in two groups', () => {
    assert.ok(at > 0 && runsAt > at && endAt > runsAt, 'ARCHITECTURE.md keeps the passage and both groups');
  });
  for (const [named, command] of STILL_ASK) {
    test(`still asks in Code mode: ${named}`, () => {
      assert.ok(doc.slice(at, runsAt).includes(named), `listed among those that still ask: ${named}`);
      assert.deepStrictEqual(codeMode(command), { verdict: 'always-asks', reason: 'unreadable-command' }, command);
      assert.strictEqual(notesMode(command), null, command);
    });
  }
  for (const [named, command] of RUN) {
    test(`runs with no card in Code mode: ${named}`, () => {
      assert.ok(doc.slice(runsAt, endAt).includes(named), `listed among those that run: ${named}`);
      assert.deepStrictEqual(codeMode(command), { verdict: 'runs' }, command);
      assert.strictEqual(notesMode(command), null, command);
    });
  }
});

// THE HOOK'S PLATFORM SEAM, judged with the environment and the runtime's
// versions handed in. It names a platform only with its flag, and never in the
// packaged app, whose hook always runs as the Electron binary.
describe('the hook\'s platform seam', () => {
  const { keychainPlatform } = require('../../scripts/permission-hook.js');
  const other = process.platform === 'win32' ? 'linux' : 'win32';
  const NODE = { node: process.versions.node };
  test('names a platform with its flag', () => {
    assert.strictEqual(keychainPlatform({ RUNDOCK_TEST_SEAMS: '1', RUNDOCK_TEST_PLATFORM: other }, NODE), other);
  });
  test('changes nothing without its flag', () => {
    assert.strictEqual(keychainPlatform({ RUNDOCK_TEST_PLATFORM: other }, NODE), process.platform);
    assert.strictEqual(keychainPlatform({}, NODE), process.platform);
  });
  test('changes nothing when the hook runs as Electron, as it does in the app', () => {
    assert.strictEqual(keychainPlatform({ RUNDOCK_TEST_SEAMS: '1', RUNDOCK_TEST_PLATFORM: other }, { ...NODE, electron: '42.9.3' }), process.platform);
  });
});

describe('the card', () => {
  test('says why it asks, and offers no Always allow', () => {
    assert.deepStrictEqual(RP.verdictCardCopy(KEYCHAIN), {
      sentence: SENTENCE,
      closing: RP.ALWAYS_ASKS_CLOSING, allowLabel: 'Allow once', alwaysLabel: null,
    });
    for (const risk of ['low', 'medium', 'high']) assert.strictEqual(RP.offersAlwaysAllow(risk, KEYCHAIN), false, risk);
  });

  test('no saved Always allow answers it, whatever the line starts with', () => {
    for (const [, command] of POSITIONS) {
      const input = { command };
      const key = RP.verdictAllowKey(KEYCHAIN) || RP.toolAllowKey('Bash', input);
      assert.deepStrictEqual(RP.decidePermission(RP.classifyRisk('Bash', input), key, new Set([key, 'Bash:security']), KEYCHAIN),
        { action: 'card' }, command);
    }
  });

  test('names no setting as the way to stop it', () => {
    const request = { tool_name: 'Bash', input: { command: K }, code_mode_verdict: KEYCHAIN };
    assert.strictEqual(RepeatHint.fixFor(request, 'notes'), null);
    assert.strictEqual(RepeatHint.fixFor(request, 'code'), null);
  });
});
