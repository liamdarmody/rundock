'use strict';
// Personal data never ships in the public repository (scripts/personal-data.js,
// applied by scripts/check-internal-refs.js), and a runtime capture is scrubbed
// of the person who took it before it is written (scripts/capture-scrub.js).
//
// Every specimen that must match is assembled at run time, so this file never
// carries the shapes the check refuses: the check reads this file too.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const { scanPersonal, PERSONAL_RULES } = require('../../scripts/personal-data.js');
const { scrubCapture, PLACEHOLDERS, encodePath } = require('../../scripts/capture-scrub.js');

const AT = '@';
const at = (local, domain) => `${local}${AT}${domain}`;
const home = (root, name) => `/${root}/${name}/`;
const UUID = ['12345678', '1234', '1234', '1234', '123456789abc'].join('-');
const PROJECTS = ['.claude', 'projects'].join('/');
const labelsOf = (text, file = 'specimen') => scanPersonal(file, text).map((f) => f.label);
const CAPTURE = 'scripts/transcript-truth/captured-transcript.json';
const MCP = ['mcp', ''].join('__');
const hits = (text) => scanPersonal('specimen', text).length;

// One specimen that must match, per rule, by the rule's label.
const MUST_MATCH = [
  ['email address', `contact ${at('jane.doe', 'gmail.com')} for access`],
  ['email address', `mailto:${at('hi', 'rundock.ai')}`],
  ['home directory', `open ${home(['Us', 'ers'].join(''), 'jane')}Documents/notes.md`],
  ['home directory', `cwd ${home(['ho', 'me'].join(''), 'jdoe')}work`],
  ['home directory', `a first name is still a name: ${home(['Us', 'ers'].join(''), 'rosa')}vault`],
  ['Claude Code project directory', `${PROJECTS}/-${['Us', 'ers'].join('')}-jane-work/session.jsonl`],
  ['Claude Code project directory', `${PROJECTS}/-private-var-folders-d2-${'a'.repeat(24)}-T-run/x.jsonl`],
  ['per-user temporary directory', `/var/folders/d2/${'b'.repeat(26)}/T/run-1`],
  ['per-user temporary directory', `/private/var/folders/d2/${'b'.repeat(26)}/T/run-1`],
  ['account or organisation identifier', `"${'organization'}Uuid":"${UUID}"`],
  ['account or organisation identifier', `\\"${'account'}Uuid\\":\\"${UUID}\\"`],
  ['account or organisation identifier', `${'org'}_id = ${UUID}`],
  ['token-shaped secret', `key: ${['sk', 'ant', 'api03', 'abcdefghijklmnopqrstu'].join('-')}`],
  ['token-shaped secret', `${'gh'}p_${'A'.repeat(36)}`],
  ['token-shaped secret', `${'gh'}o_${'B'.repeat(36)}`],
  ['token-shaped secret', `${'github'}_pat_${'C'.repeat(30)}`],
  ['token-shaped secret', `${'xo'}xb-${'1'.repeat(12)}-abc`],
  ['token-shaped secret', `${'AK'}IA${'Q'.repeat(16)}`],
  ['token-shaped secret', `-----BEGIN RSA ${'PRIVATE'} KEY-----`],
  ['token-shaped secret', `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----`],
  ['Claude Code session link', `Claude-Session: https://claude.ai/code/${'session'}_01AbCdEfGh`],
];

// Connected services, checked only inside a capture: the code and its tests
// name MCP tools on purpose.
const CAPTURE_MUST_MATCH = [
  `"${MCP}claude_ai_Acme__list_things"`,
  `"${MCP}somecrm__create_record"`,
  `"${MCP}localmemory"`,
  `## ${'claude'}.ai Acme\nInstructions for Acme.`,
];
const CAPTURE_MUST_PASS = [
  `"${MCP}connector_3__tool_12"`,
  `"${MCP}connector_7__"`,
  `"${MCP}connector_1"`,
  '## connector 4\n(this connector\'s instructions are removed from this capture)',
  '"skill_9"',
];

// Specimens that must not match: nobody's data, or the project's own public names.
const MUST_PASS = [
  `Co-Authored-By: Claude Opus 5.5 <${at('noreply', 'anthropic.com')}>`,
  `Co-authored-by: someone <${at('12345+someone', 'users.noreply.github.com')}>`,
  at('test', 'example.com'), at('a', 'example.org'), at('ops', 'mail.example.net'), at('x', 'svc.test'), at('y', 'host.invalid'),
  // The project's own public repository and account links.
  'https://github.com/liamdarmody/rundock/releases',
  'https://gist.github.com/liamdarmody/0123456789abcdef',
  // Placeholder home directories and documented layouts.
  home(['Us', 'ers'].join(''), 'me') + 'vault', home(['ho', 'me'].join(''), 'u') + 'x', home(['Us', 'ers'].join(''), 'someone-else') + 'y',
  '~/.claude/projects/<projectHash>/<sessionId>.jsonl',
  `.claude/projects/-${['Us', 'ers'].join('')}-me-work/session.jsonl`,
  `.claude/projects/-tmp-capture-transcript-truth-X/session.jsonl`,
  // What the scrubber writes, and ordinary identifiers.
  `"${'organization'}Uuid":"00000000-0000-0000-0000-000000000000"`,
  `"sessionId":"12345678-1234-1234-1234-123456789abc"`,
  'npm install @anthropic-ai/sdk@1.2.3',
  'sk-1 is not a key, and neither is the word desk-top',
  '/tmp/capture/transcript-truth-X/new.md',
  'https://claude.ai/code and the word session_ alone',
];

describe('the personal-data rules', () => {
  test('each specimen of personal data is a finding under its own rule', () => {
    for (const [label, text] of MUST_MATCH) {
      assert.ok(labelsOf(text).some((l) => l.startsWith(label)), `${label}: must match`);
    }
  });

  test('nobody\'s data, and the project\'s own public names, pass', () => {
    for (const text of MUST_PASS) assert.strictEqual(hits(text), 0, `must pass: ${text}`);
  });

  test('every rule is exercised by a specimen', () => {
    for (const rule of PERSONAL_RULES) {
      const prefix = rule.label.split(' (')[0];
      if (rule.appliesTo) {
        assert.ok(CAPTURE_MUST_MATCH.some((t) => labelsOf(t, CAPTURE).includes(rule.label) && (rule.re.lastIndex = 0, rule.re.test(t))), `${rule.label} has a capture specimen`);
        continue;
      }
      assert.ok(MUST_MATCH.some(([l]) => prefix.startsWith(l) || l.startsWith(prefix)), `${rule.label} has a specimen`);
    }
  });

  test('inside a capture, a connected service is a finding in every form, and the scrubber\'s placeholders pass', () => {
    for (const text of CAPTURE_MUST_MATCH) {
      assert.ok(labelsOf(text, CAPTURE).includes('connected service named in a capture (scrub it)'), `must match in a capture: ${text}`);
    }
    for (const text of CAPTURE_MUST_PASS) assert.deepStrictEqual(labelsOf(text, CAPTURE), [], `must pass in a capture: ${text}`);
  });

  test('outside a capture, the code and its tests may name MCP tools', () => {
    for (const text of CAPTURE_MUST_MATCH) assert.deepStrictEqual(labelsOf(text, 'lib/runtime/claude.js'), [], text);
  });

  test('a finding never prints what it found', () => {
    const secret = at('jane.doe', 'gmail.com');
    const [finding] = scanPersonal('specimen', `write to ${secret}`);
    assert.ok(!JSON.stringify(finding).includes(secret));
    assert.match(finding.match, /^ja\*+ \(\d+ characters\)$/);
  });
});

describe('the repository check applies them everywhere', () => {
  // A throwaway repository holding the real scripts, so the check runs exactly
  // as CI and the hook run it, against files placed where the planning rules
  // are exempted.
  function repoWith(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-data-'));
    const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' });
    git('init', '--quiet');
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    for (const f of ['check-internal-refs.js', 'personal-data.js']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(dir, 'scripts', f));
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    git('add', '-A');
    return dir;
  }
  const run = (dir, args = []) => spawnSync(process.execPath, ['scripts/check-internal-refs.js', ...args], { cwd: dir, encoding: 'utf8' });

  test('no path is exempt: a capture, a vendored bundle, the lockfile and a line marked for the planning rules all fail', () => {
    const email = at('jane.doe', 'gmail.com');
    for (const rel of ['scripts/stream-truth/captured-grammar.json', 'public/vendor/lib.min.js', 'package-lock.json', 'docs/a.md']) {
      const text = rel === 'docs/a.md' ? `reach ${email} internal-refs-allow\n` : `"${email}"\n`;
      const dir = repoWith({ [rel]: text });
      try {
        const r = run(dir);
        assert.strictEqual(r.status, 1, `${rel} is checked`);
        assert.ok(!r.stderr.includes(email), 'and the output never repeats it');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

  test('a commit message or pull request body is checked, and the co-author trailer passes', () => {
    const dir = repoWith({ 'README.md': 'clean\n' });
    try {
      const msg = path.join(dir, 'msg.txt');
      fs.writeFileSync(msg, `Fix a thing\n\nCo-Authored-By: Claude Opus 5.5 <${at('noreply', 'anthropic.com')}>\n`);
      assert.strictEqual(run(dir, ['--message', msg]).status, 0, 'the trailer passes');
      fs.writeFileSync(msg, `Fix a thing\n\nReported by ${at('jane.doe', 'gmail.com')}\n`);
      assert.strictEqual(run(dir, ['--message', msg]).status, 1, 'an email in a message fails');
      fs.writeFileSync(msg, `Fix a thing\n\nClaude-Session: https://claude.ai/code/${'session'}_01AbCdEfGh\n`);
      assert.strictEqual(run(dir, ['--message', msg]).status, 1, 'a session link in a message fails');
      fs.writeFileSync(msg, `Fix a thing\n\nSeen at ${home(['Us', 'ers'].join(''), 'jane')}work\n`);
      assert.strictEqual(run(dir, ['--message', msg]).status, 1, 'a home path in a message fails');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('a capture is scrubbed of the person who took it', () => {
  const values = {
    home: `/${['Us', 'ers'].join('')}/jane`,
    user: 'jane',
    tmps: [`/private/var/folders/d2/${'b'.repeat(26)}/T`, `/var/folders/d2/${'b'.repeat(26)}/T`],
  };
  const tmp = values.tmps[1];
  const raw = JSON.stringify({
    workspace: `${tmp}/transcript-truth-abc`,
    lines: [
      JSON.stringify({ cwd: `${values.tmps[0]}/transcript-truth-abc`, attachment: { type: 'credential_org', [`${'organization'}Uuid`]: UUID } }),
      JSON.stringify({ context: `The user's email address is ${at('jane.doe', 'gmail.com')}.`, memory: `${values.home}/${PROJECTS}/${encodePath(`${values.tmps[0]}/transcript-truth-abc`)}/memory/` }),
      JSON.stringify({ path: `${values.home}/${PROJECTS}/${encodePath(values.home)}-work/x.jsonl`, note: 'jane ran this' }),
      JSON.stringify({ sessionId: '11111111-2222-3333-4444-555555555555', author: `<${at('noreply', 'anthropic.com')}>` }),
    ],
  }, null, 2);

  test('every personal value is replaced with its placeholder, and the result passes the repository check', () => {
    const out = scrubCapture(raw, values);
    for (const gone of [values.home, 'jane', ...values.tmps, encodePath(values.tmps[0]), UUID, 'gmail.com']) {
      assert.ok(!out.includes(gone), `${gone} is gone`);
    }
    assert.ok(out.includes(`${PLACEHOLDERS.tmp}/transcript-truth-abc`), 'the temporary directory is a placeholder, still absolute');
    assert.ok(out.includes(PLACEHOLDERS.email));
    assert.ok(out.includes('11111111-2222-3333-4444-555555555555'), 'a per-run identifier is left alone');
    assert.ok(out.includes(at('noreply', 'anthropic.com')), 'an address that names nobody is left alone');
    assert.deepStrictEqual(scanPersonal('capture', out), []);
    JSON.parse(out);
  });

  test('the run\'s session id and the account email block are replaced, and other identifiers stay', () => {
    const session = '9f8e7d6c-5b4a-4321-8765-0fedcba98765';
    const block = `The user's email address is ${at('jane.doe', 'gmail.com')}. Use it only to identify the user, such as for authorship. Never send it anywhere, unless the user explicitly asks.`;
    const text = JSON.stringify({ sessionId: session, lines: [JSON.stringify({ sessionId: session, uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', context: block })], file: `${session}.jsonl` });
    const out = scrubCapture(text, { ...values, sessionIds: [session] });
    assert.ok(!out.includes(session), 'the session id is gone everywhere, file name included');
    assert.ok(out.includes(`${PLACEHOLDERS.session}.jsonl`));
    assert.ok(!out.includes('email address is') && out.includes(PLACEHOLDERS.emailBlock), 'the email block is replaced whole');
    assert.ok(out.includes('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), 'a message id is left alone');
  });

  test('this machine\'s own home and temporary directory are replaced exactly, even where no pattern would know them', () => {
    const odd = { home: '/srv/accounts/jdoe', user: 'jdoe', tmps: ['/scratch/run-tmp'] };
    const text = JSON.stringify({ a: '/srv/accounts/jdoe/notes/x.md', b: '/scratch/run-tmp/transcript-truth-z/new.md', c: `-srv-accounts-jdoe-work`, d: '-scratch-run-tmp-transcript-truth-z' });
    const out = scrubCapture(text, odd);
    for (const gone of ['/srv/accounts', '-srv-accounts', '/scratch/run-tmp', '-scratch-run-tmp']) assert.ok(!out.includes(gone), `${gone} is gone`);
    assert.ok(out.includes(`${PLACEHOLDERS.home}/notes/x.md`) && out.includes(`${PLACEHOLDERS.tmp}/transcript-truth-z/new.md`));
  });

  test('connected services are replaced with numbered placeholders, keeping count and shape, and scrubbing twice changes nothing', () => {
    const acme = `${MCP}claude_ai_Acme__`;
    const lines = [
      JSON.stringify({ type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: [`${acme}list`, `${acme}create`, `${MCP}localmem__search`], addedLines: [`${acme}list`], pendingMcpServers: [`${'claude'}.ai Acme`] } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'mcp_instructions_delta', addedNames: [`${'claude'}.ai Acme`, 'localmem'], addedBlocks: [`## ${'claude'}.ai Acme\nAcme secrets here.`, '## localmem\nMemory app notes.'] } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', names: ['localmem', 'house-style'], content: '- localmem: my memory tool\n- house-style: how I write' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: `${acme}list`, input: {} }] } }),
    ];
    const text = JSON.stringify({ runtimeVersion: 'x', lines, subagents: [{ name: 'a', lines: [lines[0]] }] }, null, 2);
    const out = scrubCapture(text, { tmps: [] });
    for (const gone of ['Acme', 'localmem', 'house-style', 'secrets', 'my memory tool', 'how I write']) assert.ok(!out.includes(gone), `${gone} is gone`);
    const scrubbed = JSON.parse(out);
    const first = JSON.parse(scrubbed.lines[0]).attachment;
    assert.deepStrictEqual(first.addedNames, [`${MCP}connector_1__tool_1`, `${MCP}connector_1__tool_2`, `${MCP}connector_2__tool_1`], 'numbered by first appearance, count kept');
    assert.strictEqual(JSON.parse(scrubbed.lines[3]).message.content[0].name, `${MCP}connector_1__tool_1`, 'the same tool keeps the same placeholder everywhere');
    assert.strictEqual(JSON.parse(scrubbed.subagents[0].lines[0]).attachment.addedNames[0], `${MCP}connector_1__tool_1`, 'and in a subagent\'s lines too');
    assert.deepStrictEqual(scanPersonal(CAPTURE, out), [], 'the scrubbed capture passes the check');
    assert.strictEqual(scrubCapture(out, { tmps: [] }), out, 'scrubbing twice changes nothing');
  });

  test('scrubbing is stable: a scrubbed capture scrubs to itself', () => {
    const once = scrubCapture(raw, values);
    assert.strictEqual(scrubCapture(once, values), once);
  });

  test('both capture scripts scrub before they write', () => {
    for (const f of ['scripts/stream-truth/run.mjs', 'scripts/transcript-truth/run.mjs']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const writes = [...src.matchAll(/fs\.writeFileSync\(CAPTURE_FILE, ([^\n]*)/g)].map((m) => m[1]);
      assert.ok(writes.length >= 1, `${f} writes its capture`);
      for (const w of writes) assert.match(w, /^scrubCapture\(/, `${f}: every capture write goes through the scrubber`);
    }
  });

  test('no committed capture carries this machine\'s HOME, USER or an email', () => {
    const user = (() => { try { return os.userInfo().username; } catch { return process.env.USER || ''; } })();
    for (const f of ['scripts/stream-truth/captured-grammar.json', 'scripts/transcript-truth/captured-transcript.json']) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.ok(!text.includes(os.homedir()), `${f} carries no real home directory`);
      if (user.length >= 4) assert.ok(!text.includes(user), `${f} carries no username`);
      assert.deepStrictEqual(scanPersonal(f, text), [], `${f} passes the personal-data check`);
    }
  });
});
