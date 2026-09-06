'use strict';
// The workspace file-access boundary, end to end through the REAL hook
// binary: scripts/permission-hook.js is spawned exactly as the runtime
// spawns it, with the tool request on stdin, and its stdout decision is
// asserted together with the server-side card flow and the persisted
// folder grants.
//
// The incident this replays: an agent wrote the workspace CLAUDE.md to the
// user's home directory with zero friction. After this feature, that write
// produces a permission card; approving with "Always allow this folder"
// persists a per-workspace grant that silences the next card for that
// folder only.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const h = require('../helpers/harness.js');
const { canonicalize } = require('../../scripts/permission-hook.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');

let client;
before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

// Run the real hook binary with a tool request; resolves with its decision.
function runHook(toolName, toolInput, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [HOOK], {
      cwd: h.workspaceDir,
      env: {
        ...process.env,
        RUNDOCK: '1',
        RUNDOCK_PORT: String(h.port),
        RUNDOCK_WORKSPACE: h.workspaceDir,
        RUNDOCK_CONVO_ID: 'boundary-test',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.on('close', () => {
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`hook output unparseable: ${out}`)); }
    });
    proc.stdin.write(JSON.stringify({ tool_name: toolName, tool_input: toolInput, session_id: 's-boundary' }));
    proc.stdin.end();
  });
}

function decisionOf(hookOutput) {
  return hookOutput.hookSpecificOutput ? hookOutput.hookSpecificOutput.permissionDecision : null;
}
function reasonOf(hookOutput) {
  return hookOutput.hookSpecificOutput ? hookOutput.hookSpecificOutput.permissionDecisionReason : null;
}

describe('workspace file-access boundary', () => {
  test('an in-workspace write is allowed instantly with no card', async () => {
    const since = client.messages.length;
    const out = await runHook('Write', { file_path: path.join(h.workspaceDir, 'notes.md'), content: 'x' });
    assert.strictEqual(decisionOf(out), 'allow');
    await h.delay(300);
    const cards = client.messages.slice(since).filter(m => m.type === 'control_request');
    assert.strictEqual(cards.length, 0, 'no permission card for in-workspace writes');
  });

  test('the incident replayed: a home-directory write produces a card; denying blocks it', async () => {
    const target = path.join(os.homedir(), 'CLAUDE.md');
    const since = client.messages.length;
    const pending = runHook('Write', { file_path: target, content: 'stray' });
    const { msg } = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'boundary card' });
    assert.strictEqual(msg.request.tool_name, 'Write');
    assert.strictEqual(msg.request.resolved_path, canonicalize(target), 'the card names the real target, canonically');
    client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: 'boundary-test', allow: false });
    const out = await pending;
    assert.strictEqual(decisionOf(out), 'deny', 'the write never happens');
  });

  test('"Always allow this folder" persists a per-workspace grant; the next access in that folder is silent', async () => {
    const grantDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-grant-'));
    const target1 = path.join(grantDir, 'export-one.md');
    let since = client.messages.length;
    const pending1 = runHook('Write', { file_path: target1, content: 'one' });
    const { msg } = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'first boundary card' });
    // The folder-grant response: allow AND remember the folder.
    client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: 'boundary-test', allow: true, grantDir });
    const out1 = await pending1;
    assert.strictEqual(decisionOf(out1), 'allow');

    const grants = JSON.parse(fs.readFileSync(path.join(h.workspaceDir, '.rundock', 'permissions.json'), 'utf-8'));
    assert.ok(grants.allowedDirs.includes(canonicalize(grantDir)), 'grant encoded into the workspace, canonically');

    since = client.messages.length;
    const out2 = await runHook('Write', { file_path: path.join(grantDir, 'export-two.md'), content: 'two' });
    assert.strictEqual(decisionOf(out2), 'allow', 'granted folder allows without a card');
    await h.delay(300);
    const cards = client.messages.slice(since).filter(m => m.type === 'control_request');
    assert.strictEqual(cards.length, 0, 'no second card for the granted folder');

    // The grant covers that folder only, never the machine.
    since = client.messages.length;
    const pending3 = runHook('Write', { file_path: path.join(os.homedir(), 'other.md'), content: 'x' });
    const card3 = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'ungranted folder still cards' });
    client.send({ type: 'permission_response', requestId: card3.msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pending3), 'deny');
  });

  test('outside reads are governed too', async () => {
    const since = client.messages.length;
    const pending = runHook('Read', { file_path: path.join(os.homedir(), 'somefile.txt') });
    const { msg } = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'read boundary card' });
    client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pending), 'deny');
  });

  test('CODE MODE: a shell command reaching outside cards, while one staying inside does not', async () => {
    // The seam, replayed through the real hook process. Code mode auto-
    // approves everything the classifier returns null for, and a shell
    // command was never classified, so a write outside the workspace happened
    // with no card at all while an Edit of the same file raised one.
    //
    // Both halves are asserted together on purpose. A test that only proved
    // the card appears would still pass if the change carded EVERY command in
    // code mode, which would make code mode unusable and is the obvious way
    // to overshoot this fix.
    const CODE = { RUNDOCK_CODE_MODE: '1' };

    let since = client.messages.length;
    const inside = await runHook('Bash', { command: 'npm test' }, CODE);
    assert.strictEqual(decisionOf(inside), 'allow', 'code mode still runs ordinary commands without asking');
    await h.delay(300);
    assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0,
      'an ordinary command raises no card in code mode');

    since = client.messages.length;
    const target = path.join(os.homedir(), 'stray-from-a-command.txt');
    const pending = runHook('Bash', { command: `touch ${target}` }, CODE);
    const { msg } = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'shell boundary card' });
    assert.strictEqual(msg.request.tool_name, 'Bash');
    assert.strictEqual(msg.request.resolved_path, canonicalize(target), 'the card names where the command reaches, canonically');
    client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pending), 'deny', 'the command never runs');
  });

  test('CODE MODE: a command reaching two places names the one no decision covers', async () => {
    // Shell requests are never answered from a standing folder grant (see the
    // knowledge-mode test below for why), so what this pins is the reporting:
    // a command that reaches more than one place outside carries all of them,
    // and the card leads with the first. A single reported target was how a
    // second one used to ride along unseen.
    const CODE = { RUNDOCK_CODE_MODE: '1' };
    const first = path.join(os.tmpdir(), 'boundary-two', 'export.md');
    const second = path.join(os.homedir(), '.ssh-not-really', 'key');

    const since = client.messages.length;
    const pending = runHook('Bash', { command: `cp a.md ${first} && cp key ${second}` }, CODE);
    const { msg } = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'two-crossing card' });
    const reported = (msg.request.crossings || []).map(c => c.path);
    assert.deepStrictEqual(reported, [canonicalize(first), canonicalize(second)], 'both targets reach the card, in order');
    assert.strictEqual(msg.request.grant_dir, null,
      'and no folder is offered to remember, because a folder does not answer a command');
    client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pending), 'deny');
  });

  test('CODE MODE: turning the sandbox off is itself the boundary question', async () => {
    // The escape hatch, which is the only signal here that does not depend on
    // reading command text. When the spawned runtime's sandbox denies a
    // command it is retried with dangerouslyDisableSandbox, and the retry
    // arrives at this hook carrying the flag. The command text is deliberately
    // one that would NOT card on its own, so the flag alone is what is being
    // proven.
    const since = client.messages.length;
    const pending = runHook('Bash',
      { command: 'make install', dangerouslyDisableSandbox: true },
      { RUNDOCK_CODE_MODE: '1' });
    const { msg } = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'sandbox escape card' });
    assert.strictEqual(msg.request.grant_dir, null,
      'no standing folder grant is offered: a sandbox escape is not about one folder');
    client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pending), 'deny');
  });

  test('a folder grant never lets a COMMAND run uncarded, however the folder was granted', async () => {
    // A folder grant and a command approval answer different questions. The
    // grant answers "may an agent touch this folder"; a shell card answers
    // "may this command run". The second cannot be inferred from the first,
    // because the command is arbitrary: everything in it runs, not only the
    // part that touches the granted folder.
    //
    // Without this, granting one folder from one file card silently retires
    // the per-command card for every later command that happens to name that
    // folder. `rm -rf * ; touch <granted>/x` reaches the hook, its only
    // crossing is covered, and it runs with nothing shown. That is a
    // REGRESSION of a control that already existed, delivered by a change
    // whose whole purpose is to add one.
    const granted = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-cmd-'));

    // Establish the grant through a FILE card, which is the only place a
    // folder grant is offered.
    let since = client.messages.length;
    const pendingFile = runHook('Write', { file_path: path.join(granted, 'report.md'), content: 'x' });
    const fileCard = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'file card' });
    client.send({ type: 'permission_response', requestId: fileCard.msg.request_id, conversationId: 'boundary-test', allow: true, grantDir: granted });
    assert.strictEqual(decisionOf(await pendingFile), 'allow');

    // The grant does what it promises for FILE access: silent, no card.
    since = client.messages.length;
    assert.strictEqual(decisionOf(await runHook('Write', { file_path: path.join(granted, 'again.md'), content: 'y' })), 'allow');
    await h.delay(300);
    assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0,
      'the grant still answers file access without a card');

    // A command whose only crossing is inside that same granted folder must
    // still be shown, because what is being approved is the command.
    since = client.messages.length;
    const pendingCmd = runHook('Bash', { command: `rm -rf * ; touch ${path.join(granted, 'x')}` });
    const cmdCard = await client.waitFor(m => m.type === 'control_request',
      { since, label: 'the command is still shown despite the grant' });
    assert.strictEqual(cmdCard.msg.request.tool_name, 'Bash');
    assert.strictEqual(cmdCard.msg.request.grant_dir, null,
      'and no folder grant is offered on it, because remembering a folder would not answer this question');
    client.send({ type: 'permission_response', requestId: cmdCard.msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pendingCmd), 'deny');
  });

  // The reason text is asserted for BOTH refused folders, not inferred from one.
  test('the global ~/.claude protection still wins outright (deny, no card), with a reason naming why', async () => {
    for (const folder of ['agents', 'skills']) {
      const since = client.messages.length;
      const out = await runHook('Write', { file_path: path.join(os.homedir(), '.claude', folder, 'x.md'), content: 'x' });
      assert.strictEqual(decisionOf(out), 'deny', `deterministic deny for the global ${folder}/ folder, not a card`);
      assert.match(reasonOf(out), /reads the agents and skills.*workspace.*never the global.*change nothing/is,
        `the reason for ${folder}/ names what Rundock reads, and that the edit changes nothing it can see`);
      await h.delay(300);
      assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0,
        `no permission card for the refused ${folder}/ write`);
    }
  });

  // THE COPY-IN PATH, END TO END. A user may want a global agent or skill
  // added to their workspace: the guide agent lists what is in the global
  // folder (a read) and copies one INTO the workspace (a write, inside).
  // Neither step may card, because the refusal above only governs editing
  // the global file in place, a different act entirely. This is the case a
  // later tightening would most easily break by accident, so it gets its
  // own end-to-end proof rather than being inferred from the read test and
  // the deny test separately.
  test('the copy-in path: reading a global skill file and writing its content into the workspace both raise no card', async () => {
    const globalSkill = path.join(os.homedir(), '.claude', 'skills', 'shared-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(globalSkill), { recursive: true });
    const content = '# Shared Skill\n\nSomething useful, defined once, globally.\n';
    fs.writeFileSync(globalSkill, content);

    let since = client.messages.length;
    const readOut = await runHook('Read', { file_path: globalSkill });
    assert.strictEqual(decisionOf(readOut), 'allow', 'listing the global skill is a free read');
    await h.delay(200);
    assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0,
      'no card for reading the global copy');

    const workspaceSkill = path.join(h.workspaceDir, '.claude', 'skills', 'shared-skill', 'SKILL.md');
    since = client.messages.length;
    const writeOut = await runHook('Write', { file_path: workspaceSkill, content });
    assert.strictEqual(decisionOf(writeOut), 'allow', 'copying it into the workspace is an ordinary inside write');
    await h.delay(200);
    assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0,
      'no card for writing the copy into the workspace either: the refusal governs the global file in place, not this');
  });

  // The following two are claims about what a person sees, driven through
  // the real hook against the server; h.boot() isolates HOME to a fresh
  // temp dir.
  test('reading a transcript, a global agent file, and a global skill file raises no card', async () => {
    const home = os.homedir();
    const targets = [
      path.join(home, '.claude', 'projects', 'flattened-ws', 'session.jsonl'),
      path.join(home, '.claude', 'agents', 'some-agent.md'),
      path.join(home, '.claude', 'skills', 'some-skill', 'SKILL.md'),
    ];
    for (const target of targets) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'x');
      const since = client.messages.length;
      const out = await runHook('Read', { file_path: target });
      assert.strictEqual(decisionOf(out), 'allow', `${target} reads without a card`);
      await h.delay(200);
      assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0,
        `${target}: no card raised`);
    }
  });

  test('Code mode does not auto-approve a refusal: the deterministic denials outrank it', async () => {
    // PRE-EXISTING, found while narrowing the surface refusal. The refusals
    // are enforcement rather than a prompt, so nothing may answer them for the
    // reader, and Code mode was doing exactly that: it auto-approves anything
    // the boundary did not tag as an outside crossing, and a refused edit is
    // tagged as nothing at all, so it fell through the hole in the middle.
    //
    // The cost was the whole point of the agents/skills denial. In Code mode a
    // write to the GLOBAL agents folder was allowed, landed where the app
    // never reads, and reported success, which is the silent failure that
    // refusal exists to prevent, in the one mode a developer is most likely to
    // be running.
    const home = os.homedir();
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    const CODE = { RUNDOCK_CODE_MODE: '1' };

    for (const target of [
      path.join(home, '.claude', 'agents', 'dev.md'),      // refused: Rundock reads the workspace copy
      path.join(home, '.claude', 'settings.json'),          // refused: the runtime rejects it underneath
      path.join(home, '.claude', 'commands', 'note.md'),
    ]) {
      const since = client.messages.length;
      const out = await runHook('Write', { file_path: target, content: 'x' }, CODE);
      assert.strictEqual(decisionOf(out), 'deny', `${path.basename(target)} stays refused in Code mode`);
      await h.delay(150);
      assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0,
        `${path.basename(target)} is refused without asking, in Code mode too`);
    }

    // AND CODE MODE STILL DOES ITS JOB. An ordinary in-workspace write is
    // still auto-approved, or this fix has simply broken the mode.
    const ordinary = await runHook('Write', { file_path: path.join(h.workspaceDir, 'note.md'), content: 'x' }, CODE);
    assert.strictEqual(decisionOf(ordinary), 'allow', 'Code mode still auto-approves ordinary work');
  });

  test('a file-tool write to a persistence surface is refused in both modes, a shell write to one still cards and names persistence, and writing to scratch does neither', async () => {
    const home = os.homedir();
    const surfaceTarget = path.join(home, '.claude', 'settings.json');

    // THE FILE-EDIT TOOLS ARE REFUSED, NOT CARDED, in both modes and with no
    // card raised at all. Measured against the runtime: it rejects every
    // file-tool write under its own home as a sensitive file whatever is
    // approved here, so a card offering to allow one is a promise this
    // product cannot keep, and approving it and being refused anyway teaches
    // the reader that the card means nothing.
    for (const extraEnv of [{}, { RUNDOCK_CODE_MODE: '1' }]) {
      const since = client.messages.length;
      const out = await runHook('Write', { file_path: surfaceTarget, content: 'x' }, extraEnv);
      assert.strictEqual(decisionOf(out), 'deny', 'refused outright, in both modes');
      await h.delay(200);
      assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0,
        'and refused without asking, because there was no honest question to put');
    }

    // A SHELL WRITE TO THE SAME PATH STILL CARDS. The runtime's own refusal
    // covers the file-edit tools, not a redirect, and the sandbox grants this
    // folder to the command layer, so a shell write can genuinely land here.
    // Carding it is therefore the honest answer, and the tag the card carries
    // is what names persistence to the reader.
    for (const extraEnv of [{}, { RUNDOCK_CODE_MODE: '1' }]) {
      const since = client.messages.length;
      const pending = runHook('Bash', { command: `echo x > ${surfaceTarget}` }, extraEnv);
      const { msg } = await client.waitFor(m => m.type === 'control_request'
        && m.request && m.request.boundary === true, { since, label: 'persistence-surface shell write card' });
      const crossing = (msg.request.crossings || [])[0];
      assert.ok(crossing, 'the crossing reaches the card');
      assert.strictEqual(crossing.persistenceSurface, true, 'tagged as a persistence surface, in both modes');
      assert.strictEqual(crossing.secret, false);
      client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: 'boundary-test', allow: false });
      assert.strictEqual(decisionOf(await pending), 'deny');
    }

    const scratchTarget = path.join(home, '.claude', 'cache', 'fetched-page.html');
    fs.mkdirSync(path.dirname(scratchTarget), { recursive: true });
    const since = client.messages.length;
    const out = await runHook('Write', { file_path: scratchTarget, content: 'x' });
    assert.strictEqual(decisionOf(out), 'allow', 'a routine stash in scratch is not the storm this release exists to end');
    await h.delay(200);
    assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0);
  });

  // The read-only re-grading and the settings.json grant-directory fix are
  // both placed BEFORE the standing-grant test below establishes a broad
  // grant over the whole runtime home: once that grant exists, every crossing
  // inside `~/.claude` other than the secrets tier is answered silently by
  // it, which would prove nothing about either fix on its own merits.
  test('a read-only shell command against a persistence surface raises no card: the failing scenario this release fixes', async () => {
    // The reported failure happens in Code mode, where an ordinary command
    // is already auto-approved and the only cards left are boundary ones: a
    // plain `ls`/`cat` against the agent's own agents/skills folders raised
    // TWO of them. A write reaching the same folders, whatever shape the
    // command takes, still has to card.
    const CODE = { RUNDOCK_CODE_MODE: '1' };
    const home = os.homedir();
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'agents', 'dev.md'), 'x');
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'spec-writer'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'spec-writer', 'SKILL.md'), 'x');

    let since = client.messages.length;
    let out = await runHook('Bash', { command: `ls ${path.join(home, '.claude', 'agents')}` }, CODE);
    assert.strictEqual(decisionOf(out), 'allow');
    await h.delay(200);
    assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0,
      'listing the global agents folder raises no card');

    since = client.messages.length;
    out = await runHook('Bash', { command: `cat ${path.join(home, '.claude', 'skills', 'spec-writer', 'SKILL.md')}` }, CODE);
    assert.strictEqual(decisionOf(out), 'allow');
    await h.delay(200);
    assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0,
      'reading a global skill file the same way raises no card');

    since = client.messages.length;
    const pendingRm = runHook('Bash', { command: `rm -rf ${path.join(home, '.claude', 'agents', 'dev.md')}` }, CODE);
    const rmCard = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'a write command still cards' });
    client.send({ type: 'permission_response', requestId: rmCard.msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pendingRm), 'deny');

    since = client.messages.length;
    const pendingEcho = runHook('Bash', { command: `echo x > ${path.join(home, '.claude', 'hooks', 'y')}` }, CODE);
    const echoCard = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'a redirected echo still cards' });
    client.send({ type: 'permission_response', requestId: echoCard.msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pendingEcho), 'deny');

    since = client.messages.length;
    const pendingCompound = runHook('Bash',
      { command: `ls ${path.join(home, '.claude', 'agents')} && rm -rf ${path.join(home, '.claude', 'agents', 'dev.md')}` }, CODE);
    const compoundCard = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'a compound command with a non-read-only segment still cards' });
    client.send({ type: 'permission_response', requestId: compoundCard.msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pendingCompound), 'deny');
  });

  test('no crossing at settings.json offers the runtime home root as a folder to remember, so nothing approved there can silence a later hooks/ write', async () => {
    const home = os.homedir();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

    const settingsTarget = path.join(home, '.claude', 'settings.json');

    // The file-tool write is refused before any card, so it offers nothing to
    // remember by construction. Asserted rather than assumed, because "no
    // grant is offered" and "no card is drawn" are different claims and only
    // the second is true here.
    let since = client.messages.length;
    const refused = await runHook('Write', { file_path: settingsTarget, content: 'x' });
    assert.strictEqual(decisionOf(refused), 'deny');
    await h.delay(150);
    assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0,
      'nothing to remember, because nothing was asked');

    // A SHELL write to the same file does still card, and it is the crossing
    // that could carry a grant. settings.json is the one persistence-surface
    // FILE, so the directory beside it is not a sub-folder of the runtime home,
    // it IS the root: offering that would silence agents/, skills/, plugins/,
    // commands/ and hooks/ in one click, which is the wide grant this release
    // removed returning through the crossing shaped unlike the others.
    since = client.messages.length;
    const pendingSettings = runHook('Bash', { command: `echo x > ${settingsTarget}` });
    const settingsCard = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'settings.json shell write card' });
    assert.strictEqual(settingsCard.msg.request.grant_dir, null,
      'the runtime home root is never offered as a folder to remember');
    client.send({ type: 'permission_response', requestId: settingsCard.msg.request_id, conversationId: 'boundary-test', allow: true });
    assert.strictEqual(decisionOf(await pendingSettings), 'allow');

    // Nothing was remembered, so an unrelated persistence-surface crossing
    // still cards on its own merits.
    since = client.messages.length;
    const pendingHooks = runHook('Bash', { command: `echo x > ${path.join(home, '.claude', 'hooks', 'pretool.sh')}` });
    const hooksCard = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'hooks/ write still cards' });
    assert.strictEqual(hooksCard.msg.request.crossings[0].persistenceSurface, true);
    client.send({ type: 'permission_response', requestId: hooksCard.msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pendingHooks), 'deny');
  });

  test('a standing grant over the whole runtime home does not silence the credentials file, proven at the production call site', async () => {
    // /api/permission-request in lib/http-router.js, driven through the
    // real hook with a standing grant already recorded, not crossingCovered
    // called directly. Reverting that handler to boundaryGrantCovers (its
    // pre-change form) would make the grant below cover credentials too.
    const home = os.homedir();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

    // A SHELL write, not the Write tool. commands/ is a persistence surface,
    // and a file-tool edit to one is now refused outright rather than carded,
    // because the runtime rejects those writes itself whatever is approved
    // here. That refusal covers the file-edit tools only, which is the same
    // set the runtime's own rule covers: a shell redirect can genuinely land
    // in this folder, so it still cards, and it is the crossing left that can
    // carry a grant. The grant directory below is the client's choice in its
    // response, not something the card has to have offered.
    let since = client.messages.length;
    const pendingGrant = runHook('Bash', { command: `echo x > ${path.join(home, '.claude', 'commands', 'note.md')}` });
    const grantCard = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'establish the broad grant' });
    client.send({
      type: 'permission_response', requestId: grantCard.msg.request_id, conversationId: 'boundary-test',
      allow: true, grantDir: path.join(home, '.claude'),
    });
    assert.strictEqual(decisionOf(await pendingGrant), 'allow');

    // The credentials file is named by the secrets registry and must not be
    // covered by the same broad grant that just answered an ordinary write.
    since = client.messages.length;
    const target = path.join(home, '.claude', '.credentials.json');
    const pendingCred = runHook('Read', { file_path: target });
    const credCard = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'credentials still card despite the broad grant' });
    assert.strictEqual(credCard.msg.request.crossings[0].secret, true);
    client.send({ type: 'permission_response', requestId: credCard.msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pendingCred), 'deny');
  });

  test('the credentials file cards on both a read and a write, with and without code mode, always with the secret marker and no grant directory', async () => {
    const home = os.homedir();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const target = path.join(home, '.claude', '.credentials.json');

    for (const tool of ['Read', 'Write']) {
      for (const extraEnv of [{}, { RUNDOCK_CODE_MODE: '1' }]) {
        const label = `${tool}${extraEnv.RUNDOCK_CODE_MODE ? ' in code mode' : ''}`;
        const since = client.messages.length;
        const toolInput = tool === 'Write' ? { file_path: target, content: 'x' } : { file_path: target };
        const pending = runHook(tool, toolInput, extraEnv);
        const { msg } = await client.waitFor(m => m.type === 'control_request'
          && m.request && m.request.boundary === true, { since, label: `${label}: credentials card` });
        const crossing = (msg.request.crossings || [])[0];
        assert.ok(crossing, `${label}: the crossing reaches the card`);
        assert.strictEqual(crossing.secret, true, `${label}: the secret marker is set`);
        assert.strictEqual(msg.request.grant_dir, null, `${label}: no grant directory is offered for the secrets tier`);
        client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: 'boundary-test', allow: false });
        assert.strictEqual(decisionOf(await pending), 'deny', `${label}: the request is not silently allowed`);
      }
    }
  });
});
