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
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { codeModeVerdict } = require('../../scripts/code-mode-verdict.js');
const RP = require('../../public/permissions.js');
const RepeatHint = require('../../public/repeat-hint-model.js');

// A workspace and home that exist nowhere: no disk or git fact decides whether
// a line reaches the Keychain, so none is consulted (`context` is empty).
const WS = '/work/space';
const HOME = '/home/agent';
const SVC = 'example-service';
const K = `security find-generic-password -w -s ${SVC}`;
const KEYCHAIN = { verdict: 'always-asks', reason: 'keychain' };

function codeMode(command) {
  return codeModeVerdict({ toolName: 'Bash', command, cwd: WS, workspaceRoot: WS, extraDirs: [], home: HOME, platform: 'darwin', context: {} });
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
  ['after sudo', `sudo ${K}`],
  ['after sudo and its options', `sudo -u root -E ${K}`],
  ['after sudo and its long options', `sudo --user root --preserve-env ${K}`],
  ['after sudo with a value joined to its option', `sudo -uroot ${K}`],
  ['after doas', `doas ${K}`],
  ['after nice', `nice ${K}`],
  ['after nice -n', `nice -n 10 ${K}`],
  ['after nice and sudo', `nice sudo ${K}`],
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
  ['through xargs and sudo', `echo ${SVC} | xargs sudo security find-generic-password -w -s`],
  ['through find -exec', `find . -name x -exec ${K} \\;`],
  ['through find -exec and sudo', `find . -name x -exec sudo ${K} \\;`],
  ['inside bash -c', `bash -c "${K}"`],
  ['inside sh -c', `sh -c '${K}'`],
  ['inside zsh -c', `zsh -c "${K}"`],
  ['inside bash -lc', `bash -lc "${K}"`],
  ['inside sudo bash -c', `sudo bash -c "${K}"`],
  ['in a here-document fed to bash', `bash <<EOF\n${K}\nEOF`],
  ['in a quoted here-document fed to sh', `sh <<'EOF'\n${K}\nEOF`],
  ['in a here-string fed to bash', `bash <<< "${K}"`],
  ['before a here-document that never ends, which the shell still runs', `${K} <<EOF\nmore`],
  ['after a command that asks for another reason', `eval "$X"; ${K}`],
  ['before a command that asks for another reason', `${K}; eval "$X"`],
];

describe('in Code mode, a Keychain command always asks, and says it is the Keychain', () => {
  for (const args of ASKS) {
    test(`security ${args}`, () => {
      assert.deepStrictEqual(codeMode(`security ${args}`), KEYCHAIN);
    });
  }
  for (const [where, command] of POSITIONS) {
    test(where, () => {
      assert.deepStrictEqual(codeMode(command), KEYCHAIN, command);
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

describe('the card', () => {
  test('says why it asks, and offers no Always allow', () => {
    assert.deepStrictEqual(RP.verdictCardCopy(KEYCHAIN), {
      sentence: 'This reads or changes a password or key stored in your Mac\'s Keychain, where sign-in tokens are kept.',
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
