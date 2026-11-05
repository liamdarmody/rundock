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

after(cleanup);

const RECORD = require('../fixtures/claude-cli-agent-load.json');
const byName = (name) => {
  const found = RECORD.cases.find(c => c.name === name);
  assert.ok(found, `the record has the case "${name}"`);
  return found;
};

test('the record names the Claude Code it measured, and every case was run', () => {
  assert.match(String(RECORD.claudeCode), /^\d+\.\d+\.\d+$/);
  assert.ok(RECORD.cases.length >= 12);
  for (const c of RECORD.cases) {
    assert.ok(c.observed && c.observed.exitCode !== 'timeout', `${c.name}: the run ended by itself`);
  }
});

describe('the reading loads what Claude Code loaded and refuses what it refused', () => {
  for (const c of RECORD.cases) {
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
  for (const c of RECORD.cases.filter(x => !x.observed.loaded)) {
    test(c.name, () => {
      assert.strictEqual(c.observed.exitCode, 1);
      // The stub's line, computed from a workspace holding the same file.
      const ws = makeTempDir('rundock-agent-load-');
      fs.mkdirSync(path.join(ws, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(ws, '.claude', 'agents', 'probe.md'), c.file);
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

// The probe started Claude Code with the arguments the scheduler gives a
// routine, read off the scheduler's own spawn in a workspace like the probe's
// folder: Code mode, no settings or MCP file, no model. A scheduler that
// starts routines differently fails here until the probe is changed and run
// again.
test('the probe starts Claude Code exactly as the scheduler starts a routine', () => {
  const { routineArgv, PROMPT } = require('../tools/claude-cli-agent-load-probe.js');
  const config = require('../../lib/config.js');
  const claude = require('../../lib/runtime/claude.js');
  const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');
  const original = config.getWorkspace();
  const ws = makeTempDir('rundock-agent-load-argv-');
  const realSpawn = claude.spawnClaude;
  const prevDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
  const cached = require.cache[SCHEDULER_KEY];
  let argv = null;
  try {
    config.setWorkspace(ws);
    // As spawnClaude hands them to the CLI: its internal model marker, which
    // asks for no --model at all, never reaches the binary.
    claude.spawnClaude = (args) => { argv = args.filter(a => a !== claude.INHERIT_MARKER); return new EventEmitter(); };
    delete require.cache[SCHEDULER_KEY];
    const sched = require(SCHEDULER_KEY);
    sched.wireSchedulerDeps({ getWssClients: () => [], getDisallowedTools: () => '' });
    sched.executeRoutine({ id: 'probe', name: 'probe', fileName: 'probe.md', description: 'Probes the loader' },
      { name: 'r', prompt: PROMPT }, 'probe:r');
  } finally {
    claude.spawnClaude = realSpawn;
    claude.wireClaudeRuntimeDeps(prevDeps);
    config.setWorkspace(original);
    delete require.cache[SCHEDULER_KEY];
    if (cached) require.cache[SCHEDULER_KEY] = cached;
  }
  assert.ok(argv, 'the scheduler reached the spawn');
  assert.deepStrictEqual(argv, routineArgv(ws, argv[argv.indexOf('--session-id') + 1], 'probe'));
});
