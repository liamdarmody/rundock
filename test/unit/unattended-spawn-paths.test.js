'use strict';
// EVERY PLACE THE APP STARTS A PROCESS, AND WHAT AN AGENT IT STARTS IS TOLD
// WHEN A CARD IS REFUSED.
//
// A refused card is worded by who can be asked, and the permission hook tells
// the two apart by one thing: whether the agent was started with a
// conversation (RUNDOCK_CONVO_ID, which getSpawnEnv in lib/runtime/claude.js
// sets and nothing else does). A routine's agent is started with none, so it
// is told to carry on or to say it failed; a conversation's, a delegated
// agent's included, is told to stop and ask. So every spawn of an agent has to
// pass the conversation it belongs to, and only the scheduler's may pass none.
//
// This is the exact inventory, read from the source of every file the app
// loads. Each process it starts is listed by its file, the function it is in
// and the call that starts it:
//   - each spawn of an agent, with what it passes to getSpawnEnv, the
//     conversation its agent is started with, the notice that agent is given,
//     and the tests that drive it through a refused card and the real hook
//     (test/integration/spawn-path-wording.test.js);
//   - each other launch of the Claude CLI, with why no card can be raised for
//     it, and the test of the environment it is given
//     (test/unit/spawn-environments.test.js, or the source checks below);
//   - everything else, with what it runs.
// A launch added, moved or removed fails here until it is listed with its case.
//
// Bookkeeping only, read from the source and cheap on purpose (the preflight
// runs it first): what each spawn does is driven in the two files above.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const DRIVER = 'test/integration/spawn-path-wording.test.js';
const ENVIRONMENTS = 'test/unit/spawn-environments.test.js';
const HERE = 'test/unit/unattended-spawn-paths.test.js';
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// ── The inventory ──

// `passes` is the argument the call gives getSpawnEnv; `conversation` is what
// the agent is started with, as the driving tests assert it.
const AGENT_SPAWNS = [
  { at: 'lib/scheduler.js | beginRun | spawnClaude(argsFor(asAgent))', passes: 'null, run.hookToken', notice: 'unattended',
    what: "a routine's run, started by the scheduler",
    conversation: 'none',
    drivenBy: ["lib/scheduler.js beginRun: a routine's run is started with no conversation, and told to carry on or say it failed"] },
  { at: 'server.js | message chat | spawnClaude(args) #1', passes: 'convoId', notice: 'attended',
    what: "a conversation's turn, in the interactive spawn",
    conversation: "the message's conversation id, or 'default' when it names none",
    drivenBy: [
      "server.js, the chat message (interactive): a conversation's turn is started with its conversation, and told to stop and ask",
      'server.js, the chat message (interactive) with no conversation id: the default conversation, told to stop and ask',
    ] },
  { at: 'server.js | message chat | spawnClaude(args) #2', passes: 'convoId', notice: 'attended',
    what: "a conversation's turn, in the legacy spawn (one process per message)",
    conversation: "the message's conversation id, or 'default' when it names none",
    drivenBy: [
      "server.js, the chat message (legacy): a conversation's turn is started with its conversation, and told to stop and ask",
      'server.js, the chat message (legacy) with no conversation id: the default conversation too',
    ] },
  { at: 'lib/delegation/engine.js | startWithoutSession | spawnClaude(withoutResume(args))', passes: 'convoId', notice: 'attended',
    what: 'an agent started again fresh because its stored session is gone',
    conversation: 'the conversation of the agent whose session was refused',
    drivenBy: ['lib/delegation/engine.js startWithoutSession: a delegate started fresh, its stored session gone, keeps the conversation, and is told to stop and ask'] },
  { at: 'lib/delegation/engine.js | handleScopeReturn | spawnClaude(args)', passes: 'convoId', notice: 'attended',
    what: "the orchestrator started for a specialist's handback",
    conversation: 'the conversation the specialist handed back in',
    drivenBy: ["lib/delegation/engine.js handleScopeReturn: the orchestrator started for a specialist's handback keeps the conversation, and is told to stop and ask"] },
  { at: 'lib/delegation/engine.js | spawnResumedProcess | spawnClaude(args)', passes: 'convoId', notice: 'attended',
    what: 'a caller resumed after Rundock blocked its handoff',
    conversation: 'the conversation of the caller',
    drivenBy: ['lib/delegation/engine.js spawnResumedProcess: the caller resumed after a blocked handoff keeps the conversation, and is told to stop and ask'] },
  { at: 'lib/delegation/engine.js | handleDelegation | spawnClaude(delegateArgs)', passes: 'convoId', notice: 'attended',
    what: 'the agent delegated to',
    conversation: "the delegate message's conversation, which must have an agent answering in it, so one with no id starts nobody",
    drivenBy: [
      'lib/delegation/engine.js handleDelegation, the delegate: started with the conversation it was delegated in, and told to stop and ask',
      'a delegation with no conversation id starts nobody',
    ] },
  { at: 'lib/delegation/engine.js | handleDelegation | spawnClaude(resumeArgs)', passes: 'convoId', notice: 'attended',
    what: 'the parent resumed after its delegate finished',
    conversation: 'the conversation the delegate finished in',
    drivenBy: ['lib/delegation/engine.js handleDelegation, the parent resumed after its delegate finished: keeps the conversation, and is told to stop and ask'] },
];

// The Claude CLI started for something other than an agent of Rundock's. None
// of these can raise a card: each is given the app's own environment, which
// never carries RUNDOCK (only getSpawnEnv and the Codex glue set it, for the
// processes they start), and the hook decides nothing outside Rundock. Each
// says why it cannot be driven end to end, and which test here covers it.
const OTHER_CLAUDE_LAUNCHES = [
  { at: 'lib/runtime/claude.js | spawnClaude | spawn(resolveClaudeBin())',
    why: 'the one function every agent spawn above starts through: it passes on the environment it is given and adds nothing, so each agent spawn\'s own test drives it',
    testedBy: [ENVIRONMENTS, 'the funnel every agent spawn goes through passes on the environment it is given'] },
  { at: 'lib/runtime/claude-console.js | checkConnection | spawn(bin)',
    why: 'the reconnect card\'s check: a one-word turn from the home folder, with no --settings, so none of the workspace\'s hooks are configured for it, and the app\'s own environment',
    testedBy: [ENVIRONMENTS, 'the connection check runs from the home folder with no settings and no environment of Rundock\'s'] },
  { at: 'lib/runtime/claude-console.js | openClaudeConsole | spawn(c.command)',
    why: 'opens a terminal window for the person to sign in themselves: no agent of Rundock\'s, no --settings, and no environment of Rundock\'s',
    testedBy: [ENVIRONMENTS, 'the sign-in console is opened with no environment of Rundock\'s'] },
  { at: 'server.js | getRuntimeStatus | execSync(`"${resolveClaudeBin()}" --version`)',
    why: 'asks for the version and exits: it starts no agent and runs no tool',
    testedBy: [HERE, 'the app never marks its own environment as Rundock\'s'] },
  { at: 'lib/runtime/claude-lookup.js | readClaudeVersion | execFileSync(bin)',
    why: 'asks a copy the lookup found, or the one spawnClaude is about to start, for its version (`--version`, no shell), with the app\'s own environment, and exits: it starts no agent and runs no tool',
    testedBy: [HERE, 'the app never marks its own environment as Rundock\'s'] },
  { at: 'electron/main.js | findClaude | execSync(`"${bin}" --version`)',
    why: 'the desktop asks for the version and exits: it starts no agent and runs no tool',
    testedBy: [HERE, 'the app never marks its own environment as Rundock\'s'] },
  { at: 'electron/main.js | isClaudeAuthenticated | execSync(\'claude --print "test" --output-format text\')',
    why: 'the desktop\'s sign-in check, run in its main process with no --settings and the desktop\'s own environment, so the hook decides nothing for it; it cannot be started from a test without the desktop',
    testedBy: [ENVIRONMENTS, 'the hook decides nothing for a process started with the app\'s own environment'] },
];

// Everything else the app starts, none of it the Claude CLI.
const NOT_CLAUDE = [
  { at: 'codex-appserver.js | _spawn | spawn(this._binPath)', runs: 'the Codex app-server, whose approvals are answered through lib/runtime/codex-glue.js, never through this hook' },
  { at: 'codex.js | resolveCodexBin | exec(lookupCmd)', runs: 'a lookup of the Codex binary on the PATH' },
  { at: "codex.js | detectCodex | exec(platform === 'win32' ? 'where.exe codex' : 'which codex')", runs: 'a lookup of the Codex binary on the PATH' },
  { at: 'codex.js | detectCodex | exec(`"${bin}" --version`)', runs: "Codex's version" },
  { at: 'electron/main.js | findClaude | execSync(lookupCmd)', runs: 'a lookup of the Claude binary on the PATH' },
  { at: 'electron/main.js | ensureClaudeOnUserPath | execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`)', runs: 'a PowerShell change to the Windows PATH' },
  { at: 'electron/main.js | launchCodexSignIn | spawn(`start "Sign in to Codex" cmd /k ""${bin}" login"`)', runs: "Codex's own sign-in, on Windows" },
  { at: "electron/main.js | launchCodexSignIn | spawn('open')", runs: "Codex's own sign-in, on macOS" },
  { at: "electron/main.js | launchCodexSignIn | spawn('x-terminal-emulator')", runs: "Codex's own sign-in, on Linux" },
  { at: "lib/packages/extension-source.js | acquireWithGit | execFileSync('git')", runs: 'git, to fetch an extension' },
  { at: "lib/packages/extension-source.js | listRefsWithGit | execFileSync('git')", runs: "git, to list an extension's tags" },
  { at: "lib/packages/extension-source.js | listTagCommitsWithGit | execFile('git')", runs: "git, to list an extension's tag commits" },
  { at: "lib/protocol/handlers/files.js | handleRevealInFinder | spawn('open')", runs: 'the Finder, to show a file' },
  { at: "lib/protocol/handlers/workspace.js | handlePickFolder | execFile('osascript')", runs: 'the folder picker' },
  { at: "lib/runtime/claude.js | psCommand | execFileSync('ps')", runs: "ps, to read a process's command line" },
  { at: 'lib/runtime/claude.js | resolveClaudeBin | execSync(lookupCmd)', runs: 'a lookup of the Claude binary on the PATH' },
  { at: "lib/runtime/claude.js | killProcessTree | spawn('taskkill')", runs: 'taskkill, to stop an agent on Windows' },
  { at: "scripts/code-mode-git.js | git | execFileSync('git')", runs: "git, for the hook's Code-mode checks" },
  { at: "server.js | getRuntimeStatus | execSync(isWindows ? 'where.exe claude' : 'which claude')", runs: 'a lookup of the Claude binary on the PATH' },
];

// The files that load child_process at all. A new one fails here, so a launch
// through a name this scan does not know cannot arrive unseen with it.
const LOADS_CHILD_PROCESS = [
  'codex-appserver.js', 'codex.js', 'electron/main.js', 'lib/delegation/engine.js', 'lib/packages/extension-source.js',
  'lib/protocol/handlers/files.js', 'lib/protocol/handlers/workspace.js', 'lib/runtime/claude-console.js', 'lib/runtime/claude-lookup.js', 'lib/runtime/claude.js',
  'scripts/code-mode-git.js', 'server.js',
];

// ── Reading the source ──

// Every file the app loads: the modules at the root, lib/ and electron/, and
// each script under scripts/ that any of those, or another such script,
// requires (the permission hook and what it loads). The build and test
// scripts in scripts/ are not the app.
function appFiles() {
  const out = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.add(p);
    }
  };
  for (const f of ['server.js', 'search.js', 'codex.js', 'codex-appserver.js', 'permission-routing.js']) out.add(path.join(ROOT, f));
  walk(path.join(ROOT, 'lib'));
  walk(path.join(ROOT, 'electron'));
  const queue = [...out];
  while (queue.length) {
    const f = queue.shift();
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) {
      let r = path.resolve(path.dirname(f), m[1]);
      if (!r.endsWith('.js')) r += '.js';
      if (!fs.existsSync(r) || out.has(r) || !rel(r).startsWith('scripts/')) continue;
      out.add(r);
      queue.push(r);
    }
  }
  return [...out].sort();
}

// A call that starts a process: Node's launchers by name, as a function or a
// method (`.exec(` is left out: it is a regular expression's), and the app's
// own funnel for agents.
const LAUNCH = /(?<![\w$])(spawnClaude|spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(|(?<![\w$.])(exec)\s*\(/g;
const codeOf = (line) => (/^\s*(\*|\/\*|\/\/)/.test(line) ? '' : line.replace(/\/\/.*$/, ''));

// The function a call is in: a property it is the value of, the message
// handler in server.js, a function or method, or a top-level binding.
function contextOf(lines, i) {
  const own = lines[i].match(/^\s+(\w+):\s*(?:async\s*)?\([^)]*\)\s*=>/);
  if (own) return own[1];
  for (let j = i; j >= 0; j--) {
    const l = lines[j];
    let m;
    if ((m = l.match(/^\s+if \(msg\.type === '(\w+)'\)/))) return `message ${m[1]}`;
    if ((m = l.match(/^(?:async\s+)?function\s+(\w+)\s*\(/))) return m[1];
    if ((m = l.match(/^ {2}(?:async\s+)?(?!(?:if|for|while|switch|catch)\b)(\w+)\s*\([^)]*\)\s*\{\s*$/))) return m[1];
    if ((m = l.match(/^(?:const|let)\s+(\w+)\s*=/))) return m[1];
  }
  return '(top level)';
}

// The call's arguments, to its closing parenthesis, and the first of them.
function argsFrom(text, at) {
  let depth = 0;
  let k = at;
  let first = null;
  for (; k < text.length; k++) {
    const c = text[k];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth--; } else if (c === ',' && depth === 0 && first === null) first = text.slice(at, k);
  }
  return { first: (first === null ? text.slice(at, k) : first).trim(), all: text.slice(at, k) };
}

function launches() {
  const sites = [];
  for (const file of appFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    let offset = 0;
    lines.forEach((line, i) => {
      const c = codeOf(line);
      for (const m of c.matchAll(LAUNCH)) {
        if (/function\s+$/.test(c.slice(0, m.index))) continue;
        const { first, all } = argsFrom(text, offset + m.index + m[0].length);
        sites.push({ base: `${rel(file)} | ${contextOf(lines, i)} | ${m[1] || m[2]}(${first})`, callee: m[1] || m[2], all, line: i + 1, file: rel(file) });
      }
      offset += line.length + 1;
    });
  }
  // The same call twice in one function is told apart by its order there.
  const count = new Map();
  for (const s of sites) count.set(s.base, (count.get(s.base) || 0) + 1);
  const seen = new Map();
  for (const s of sites) {
    const n = (seen.get(s.base) || 0) + 1;
    seen.set(s.base, n);
    s.at = count.get(s.base) > 1 ? `${s.base} #${n}` : s.base;
  }
  return sites;
}

// ── The inventory against the source ──

describe('every process the app starts is in the inventory, with its case', () => {
  const sites = launches();
  const listed = [...AGENT_SPAWNS, ...OTHER_CLAUDE_LAUNCHES, ...NOT_CLAUDE].map((e) => e.at);

  test('every process the app starts is listed, and nothing listed has gone', () => {
    const found = sites.map((s) => s.at);
    const unlisted = found.filter((at) => !listed.includes(at));
    const gone = listed.filter((at) => !found.includes(at));
    assert.deepStrictEqual({ unlisted, gone }, { unlisted: [], gone: [] },
      'every process the app starts is listed: add a new one with its case, and remove one that has gone');
    assert.strictEqual(new Set(listed).size, listed.length, 'and each is listed once');
    // A pattern that stopped matching would find nothing and pass the lines
    // above; the scan is held to the inventory's own size, and to the files.
    assert.strictEqual(found.length, listed.length);
    assert.ok(appFiles().map(rel).includes('scripts/permission-hook.js'), 'the hook and what it loads are read too');
  });

  test('only the files listed load child_process at all', () => {
    const loading = appFiles().filter((f) => /require\(\s*'(?:node:)?child_process'\s*\)/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
    assert.deepStrictEqual(loading, [...LOADS_CHILD_PROCESS].sort());
  });

  test('every agent is started through spawnClaude, with the conversation the inventory names', () => {
    const agents = sites.filter((s) => s.callee === 'spawnClaude');
    assert.deepStrictEqual(agents.map((s) => s.at).sort(), AGENT_SPAWNS.map((e) => e.at).sort());
    for (const s of agents) {
      const entry = AGENT_SPAWNS.find((e) => e.at === s.at);
      const env = s.all.match(/env:\s*getSpawnEnv\(([^()]*)\)/);
      assert.ok(env, `${s.at} (line ${s.line}) is given getSpawnEnv's environment`);
      assert.strictEqual(env[1].trim(), entry.passes, `${s.at} passes ${entry.passes}`);
      assert.strictEqual(entry.notice, entry.passes.split(',')[0] === 'null' ? 'unattended' : 'attended');
    }
    assert.deepStrictEqual(AGENT_SPAWNS.filter((e) => e.notice === 'unattended').map((e) => e.at), ['lib/scheduler.js | beginRun | spawnClaude(argsFor(asAgent))'],
      'only the scheduler starts an agent with no conversation');
  });

  test('getSpawnEnv is called nowhere but in those spawns', () => {
    let calls = 0;
    for (const file of appFiles()) {
      const code = fs.readFileSync(file, 'utf8').split('\n').map(codeOf).join('\n');
      calls += [...code.matchAll(/(?<![\w$])getSpawnEnv\s*\(/g)].filter((m) => !/function\s+$/.test(code.slice(Math.max(0, m.index - 9), m.index))).length;
    }
    assert.strictEqual(calls, AGENT_SPAWNS.length);
  });

  test('each agent spawn names the tests that drive it, and they are there', () => {
    const driver = fs.readFileSync(path.join(ROOT, DRIVER), 'utf8').split("\\'").join("'");
    for (const entry of AGENT_SPAWNS) {
      assert.ok(entry.drivenBy.length >= 1, `${entry.at} names a test`);
      for (const name of entry.drivenBy) assert.ok(driver.includes(`test('${name}'`), `${DRIVER} drives ${entry.at}: "${name}"`);
    }
    for (const entry of OTHER_CLAUDE_LAUNCHES) {
      const [file, name] = entry.testedBy;
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8').split("\\'").join("'");
      assert.ok(text.includes(`test('${name}'`), `${entry.at} is covered by ${file}: "${name}"`);
    }
  });
});

// ── What only the source can say ──

describe('nothing else gives a process the conversation or the mark', () => {
  test('the app never marks its own environment as Rundock\'s', () => {
    const writes = [];
    for (const file of appFiles()) {
      const code = fs.readFileSync(file, 'utf8').split('\n').map(codeOf).join('\n');
      // The mark and the conversation: the two the hook reads to decide.
      for (const m of code.matchAll(/process\.env\.(RUNDOCK|RUNDOCK_CONVO_ID)\s*=(?!=)|process\.env\[['"](RUNDOCK|RUNDOCK_CONVO_ID)['"]\]\s*=(?!=)/g)) writes.push(`${rel(file)}: ${m[1] || m[2]}`);
    }
    assert.deepStrictEqual(writes, []);
    // The two environments that mark a process as Rundock's: an agent's
    // (getSpawnEnv) and the Codex app-server's, which names no conversation
    // and never runs this hook.
    const marked = appFiles().filter((f) => /RUNDOCK: '1'/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
    assert.deepStrictEqual(marked, ['lib/runtime/claude.js', 'lib/runtime/codex-glue.js']);
    const named = appFiles().filter((f) => /\.RUNDOCK_CONVO_ID\s*=(?!=)/.test(fs.readFileSync(f, 'utf8'))).map(rel);
    assert.deepStrictEqual(named, ['lib/runtime/claude.js'], 'and only getSpawnEnv names a conversation');
  });

  test('a chat message with no conversation id is the default conversation, never none', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(server, /const convoId = msg\.conversationId \|\| 'default';/);
  });
});
