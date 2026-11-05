'use strict';
// RUNDOCK READS AN AGENT FILE AS THE INSTALLED CLAUDE CODE DID, CASE BY CASE.
//
// Whether Claude Code loads an agent file decides what a routine runs as: the
// agent, with its instructions and its `tools:` line, or a plain session
// without either. lib/agents/claude-code-load.js is Rundock's reading of that,
// and the scheduler and the test stub both act on it. CI has no Claude Code,
// so test/fixtures/claude-cli-agent-load.json is what the real CLI did with
// each case, measured by test/tools/claude-cli-agent-load-probe.js (run by
// hand, against a stand-in for the messages API, so no account is used). This
// holds the reading, the stub's refusal line, and the writer to that record.
//
// When the CLI changes, the probe is run again and its record replaces the
// fixture; any case the reading then answers differently fails here, by name.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');
const { readAgentFile } = require('../../lib/agents/claude-code-load.js');
const { loadableAgentNames, agentNotFoundLine } = require('../helpers/claude-code-agents.js');
const { appendRoutineBlock } = require('../../lib/agents/routines.js');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

after(cleanup);

const RECORD = require('../fixtures/claude-cli-agent-load.json');
const byName = (name) => {
  const found = RECORD.cases.find(c => c.name === name);
  assert.ok(found, `the record has the case "${name}"`);
  return found;
};
// The cases run as an agent. One case has no agent: it is the plain session
// a fallback starts, run while the agent's file is present, and nothing is
// loaded in it by design.
const AS_AGENT = RECORD.cases.filter(c => c.agent !== null);
// A folder holding the case's agent file where the probe put it.
function workspaceFor(c, prefix) {
  const ws = makeTempDir(prefix);
  fs.mkdirSync(path.join(ws, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'agents', c.fileName || 'probe.md'), c.file);
  return ws;
}

test('the record names the Claude Code it measured, and every case was run', () => {
  assert.match(String(RECORD.claudeCode), /^\d+\.\d+\.\d+$/);
  assert.ok(RECORD.cases.length >= 15);
  for (const c of RECORD.cases) {
    assert.ok(c.observed && c.observed.exitCode !== 'timeout', `${c.name}: the run ended by itself`);
  }
});

describe('the reading loads what Claude Code loaded and refuses what it refused', () => {
  for (const c of AS_AGENT) {
    test(c.name, () => {
      const read = readAgentFile(c.file);
      // The agent asked for is loaded when its file loads and is that agent.
      const loads = read.loads && read.name === c.agent;
      assert.strictEqual(loads, c.observed.loaded,
        `Claude Code ${c.observed.loaded ? 'loaded' : 'refused'} it; the reading says ${read.loads ? 'it loads' : read.why}`);
      if (!read.loads) assert.ok(!read.unmodeled, 'and refuses it by a rule it models, rather than by not knowing');
    });
  }
});

describe('a refusal is the line and the exit code the stub gives', () => {
  for (const c of AS_AGENT.filter(x => !x.observed.loaded)) {
    test(c.name, () => {
      assert.strictEqual(c.observed.exitCode, 1);
      // The stub's line, computed from a workspace holding the same file.
      const ws = workspaceFor(c, 'rundock-agent-load-');
      assert.strictEqual(c.observed.stderr, agentNotFoundLine(c.agent, loadableAgentNames(ws)),
        'word for word, built-in agents and their order included');
    });
  }
  test('and a file that loads says nothing on stderr and exits cleanly', () => {
    for (const c of RECORD.cases.filter(x => x.observed.loaded)) {
      assert.strictEqual(c.observed.exitCode, 0, c.name);
      assert.strictEqual(c.observed.stderr, '', c.name);
    }
  });
});

// The stub itself, run as the scheduler runs a routine, in a folder holding
// each case's file with the stub told to load agent files: it exits and
// writes to stderr as Claude Code did, case by case, the plain session
// included. What the integration tests see a broken file do is this.
describe('the test stub, run as a routine is run, ends as Claude Code ended', () => {
  const { routineArgv } = require('../tools/claude-cli-agent-load-probe.js');
  const STUB = path.join(__dirname, '..', 'helpers', 'stub-claude', 'claude');
  for (const c of RECORD.cases) {
    test(c.name, () => {
      const ws = workspaceFor(c, 'rundock-agent-load-stub-');
      fs.writeFileSync(path.join(ws, 'stub-scenario.json'), JSON.stringify({ loadAgentFiles: true }));
      const home = makeTempDir('rundock-agent-load-stub-home-');
      const ran = spawnSync(process.execPath, [STUB, ...routineArgv(ws, randomUUID(), c.agent)],
        { cwd: ws, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 30000 });
      assert.strictEqual(ran.status, c.observed.exitCode, `the stub exited ${ran.status}: ${ran.stderr}`);
      assert.strictEqual(ran.stderr.trimEnd(), c.observed.stderr, 'and said what Claude Code said');
    });
  }
});

// Claude Code finds an agent by the name: line in its file, not by the file's
// name on disk, and so do the stub and the reading.
test('an agent is found by its name line, whatever its file is called', () => {
  const c = byName('a file whose name on disk differs from its name line');
  assert.notStrictEqual(c.fileName, `${c.agent}.md`, 'the file is named for something else');
  assert.strictEqual(c.observed.loaded, true, 'and Claude Code loaded it as the agent its name line names');
  const ws = workspaceFor(c, 'rundock-agent-load-name-');
  assert.ok(loadableAgentNames(ws).includes(c.agent), 'the stub finds it by that name');
  assert.ok(!loadableAgentNames(ws).includes(path.basename(c.fileName, '.md')), 'and not by the name of the file');
});

describe('the writer', () => {
  // The base file the probe wrote each routine into, so the files the record
  // calls "as the writer writes it now" can be rebuilt from today's writer. A
  // writer that changes what it writes fails here until the probe is run again.
  const BASE = '---\nname: probe\ndescription: Probes the loader\n---\n\nYou are the probe agent. PROBE-AGENT-INSTRUCTIONS\n';
  const pairs = RECORD.cases.filter(c => /as the writer writes it now$/.test(c.name));

  test('every routine value it quotes was refused bare and loaded quoted', () => {
    assert.strictEqual(pairs.length, 3, 'a colon and a space, a leading backtick, and stray quotation marks');
    for (const now of pairs) {
      const before = byName(now.name.replace(/writes it now$/, 'used to write it'));
      assert.strictEqual(before.observed.loaded, false, `${before.name}: Claude Code refused the bare value`);
      assert.strictEqual(now.observed.loaded, true, `${now.name}: and loaded the quoted one`);
    }
  });

  test('the files the record calls this writer\'s are what it writes today', () => {
    for (const now of pairs) {
      const prompt = readAgentFile(now.file).data.routines[0].prompt;
      assert.strictEqual(appendRoutineBlock(BASE, { name: 'r', schedule: 'every day at 07:00', prompt }), now.file, now.name);
    }
  });
});

// What a routine's agent file buys it, measured at the tool surface: an agent
// whose `tools:` line leaves out Bash is not offered Bash, and when the model
// asks for it anyway the call is refused and nothing runs. The same agent
// with no `tools:` line ran the same command, so the stand-in really can make
// a run use Bash.
test('a tools line that leaves out Bash keeps a routine from running Bash', () => {
  const limited = byName('a tools line without Bash, and the model asks for Bash');
  assert.strictEqual(limited.observed.loaded, true, 'the agent loaded');
  assert.ok(!limited.observed.toolsOffered.includes('Bash'), 'Bash was not among the tools offered');
  assert.strictEqual(limited.observed.results[0].refused, true, 'the call was refused');
  assert.strictEqual(limited.observed.sentinelCreated, false, 'and the file it would have made does not exist');

  const open = byName('no tools line, and the model asks for Bash');
  assert.ok(open.observed.toolsOffered.includes('Bash'));
  assert.strictEqual(open.observed.results[0].refused, false);
  assert.strictEqual(open.observed.sentinelCreated, true, 'without the line, the same call made the file');
});

// WHAT A FALLBACK GIVES UP, MEASURED. The plain session a fallback starts
// passes no --agent, so the agent's file is not loaded even while it is
// present, and its tools: line goes with it: the same file that kept the
// agent from Bash above, and the same request for Bash, and the plain session
// ran it. This is the loss the fallback's notice states, and why a file
// Rundock could not check is never run this way.
test('the plain session a fallback starts runs without the file\'s tools line, while the file is present', () => {
  const limited = byName('a tools line without Bash, and the model asks for Bash');
  const plain = byName('the same tools line, run as the plain session a fallback starts, and the model asks for Bash');
  assert.strictEqual(plain.agent, null, 'run with no --agent');
  assert.strictEqual(plain.file, limited.file, 'beside the same file');
  assert.deepStrictEqual(plain.steps, limited.steps, 'asked for the same command');
  assert.strictEqual(plain.observed.loaded, false, 'the agent\'s instructions did not reach the model');
  assert.ok(plain.observed.toolsOffered.includes('Bash'), 'Bash was offered');
  assert.strictEqual(plain.observed.results[0].refused, false, 'the call ran');
  assert.strictEqual(plain.observed.sentinelCreated, true, 'and made the file the agent was kept from making');
});

// The probe started Claude Code with the arguments the scheduler gives a
// routine, read off the scheduler's own spawn in a workspace like the probe's
// folder: Code mode, no settings or MCP file, no model. A scheduler that
// starts routines differently fails here until the probe is changed and run
// again.
test('the probe starts Claude Code exactly as the scheduler starts a routine, and the plain session after it', async () => {
  const { routineArgv, PROMPT } = require('../tools/claude-cli-agent-load-probe.js');
  const config = require('../../lib/config.js');
  const claude = require('../../lib/runtime/claude.js');
  const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');
  const original = config.getWorkspace();
  const ws = makeTempDir('rundock-agent-load-argv-');
  const realSpawn = claude.spawnClaude;
  const prevDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
  const cached = require.cache[SCHEDULER_KEY];
  const spawns = [];
  try {
    config.setWorkspace(ws);
    // As spawnClaude hands them to the CLI: its internal model marker, which
    // asks for no --model at all, never reaches the binary. The first child
    // refuses the agent as Claude Code does, so the scheduler starts the
    // plain session; that one finishes.
    claude.spawnClaude = (args, options) => {
      spawns.push(args.filter(a => a !== claude.INHERIT_MARKER));
      const child = new EventEmitter();
      if (spawns.length === 1) fs.writeSync(options.stdio[2], `${byName('no name line').observed.stderr}\n`);
      setImmediate(() => child.emit('close', spawns.length === 1 ? 1 : 0));
      return child;
    };
    delete require.cache[SCHEDULER_KEY];
    const sched = require(SCHEDULER_KEY);
    sched.wireSchedulerDeps({ getWssClients: () => [], getDisallowedTools: () => '' });
    sched.executeRoutine({ id: 'probe', name: 'probe', fileName: 'probe.md', description: 'Probes the loader' },
      { name: 'r', prompt: PROMPT }, 'probe:r');
    for (let i = 0; i < 400 && !(sched.routineState['probe:r'] && sched.routineState['probe:r'].status !== 'running'); i++) {
      await new Promise(r => setTimeout(r, 5));
    }
  } finally {
    claude.spawnClaude = realSpawn;
    claude.wireClaudeRuntimeDeps(prevDeps);
    config.setWorkspace(original);
    delete require.cache[SCHEDULER_KEY];
    if (cached) require.cache[SCHEDULER_KEY] = cached;
  }
  assert.strictEqual(spawns.length, 2, 'the agent, refused, then the plain session');
  const [agent, plain] = spawns;
  assert.deepStrictEqual(agent, routineArgv(ws, agent[agent.indexOf('--session-id') + 1], 'probe'));
  assert.deepStrictEqual(plain, routineArgv(ws, plain[plain.indexOf('--session-id') + 1], null),
    'the plain session is the probe\'s case with no agent, argument for argument');
});
