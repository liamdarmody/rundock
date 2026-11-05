'use strict';
// What Rundock writes into an agent file still loads in Claude Code.
//
// Claude Code reads the part between the --- lines as YAML and drops the WHOLE
// file when it cannot, which takes the agent's instructions and its `tools:`
// line with it. Rundock reads the same lines with its own parser, which never
// complained, so a routine prompt like "Summarize: inbox" was written as it
// stood and the file it went into stopped loading, with nothing on either side
// saying so. In a conversation that is a plain session with no tools line; in a
// routine it is a run that cannot start as its agent.
//
// So every value is judged twice here. Claude Code's reading, which no test
// can run, is the model in test/helpers/claude-code-agents.js: a strict YAML
// reader that refuses what a YAML reader refuses, and nothing it cannot read.
// Rundock's reading is its own parser, and a value has to come back from it
// exactly as it went in: quoting is how a value is written, never part of it.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  appendRoutineBlock, updateRoutineBlock, readRoutineBlock, parseRoutineBlocks, normalizeRoutine,
} = require('../../lib/agents/routines.js');
const { extractFrontmatterText, parseRoutines } = require('../../lib/agents/discovery.js');
const { readAgentFile, readYaml } = require('../helpers/claude-code-agents.js');

const AGENT = [
  '---',
  'name: lead',
  'description: Runs the team',
  'routines:',
  '  - name: existing',
  '    schedule: every day at 08:00',
  '    prompt: Run the digest',
  '    enabled: true',
  '---',
  '',
  'You are the lead.',
  '',
].join('\n');

// The values that broke a file, and their near neighbours. Each is something a
// person types into a routine as an ordinary sentence.
const AWKWARD = [
  'Summarize: inbox, calendar and tasks',
  '`npm test` then report what failed',
  '"Summarize" the inbox, then file it',
  "'Weekly' review",
  'Check issue #4 before the stand-up',
  'Ends with a colon:',
  '@team needs the update',
  '- a dash first',
  '[draft] tidy the notes',
  '{project} weekly',
  '* starred items only',
  '& the rest',
  '! urgent first',
  '| piped',
  '> quoted',
  '% done',
  '? open questions',
  ', a comma first',
  'Tabs\tinside',
  ' leading space',
  'trailing space ',
  'A backslash \\ and a "quote"',
];

// The routine block Claude Code reads, by name.
function claudeCodeRoutine(content, name) {
  const read = readAgentFile(content);
  assert.ok(read.loads, `Claude Code loads the file (${read.why || ''})\n${content}`);
  const found = (read.data.routines || []).filter(r => r && r.name === name);
  assert.strictEqual(found.length, 1, `Claude Code reads one routine named ${JSON.stringify(name)}`);
  return found[0];
}

// The routine block Rundock reads, by name, through the parser the roster is
// built from, which is the reading the scheduler sends and the plan hash reads.
function rundockRoutine(content, name) {
  const routine = parseRoutines(extractFrontmatterText(content)).find(r => r.name === name);
  assert.ok(routine, `Rundock reads a routine named ${JSON.stringify(name)}`);
  return routine;
}

describe('a routine created with an awkward prompt', () => {
  for (const prompt of AWKWARD) {
    test(`loads in Claude Code and reads back unchanged: ${JSON.stringify(prompt)}`, () => {
      const next = appendRoutineBlock(AGENT, { name: 'awkward', schedule: 'every day at 07:00', prompt });
      assert.strictEqual(claudeCodeRoutine(next, 'awkward').prompt, prompt, 'Claude Code reads the prompt that was written');
      assert.strictEqual(rundockRoutine(next, 'awkward').prompt, prompt, 'and so does Rundock');
      assert.strictEqual(readRoutineBlock(next, 'awkward').prompt, prompt, 'by the read-back every writer checks against');
    });
  }
});

describe('a routine whose name is awkward', () => {
  for (const name of ['Inbox: triage', '`deploy` check', '"Morning" briefing']) {
    test(`is written, found again by its name, and loads: ${JSON.stringify(name)}`, () => {
      const next = appendRoutineBlock(AGENT, { name, schedule: 'every day at 07:00', prompt: 'Run it' });
      assert.strictEqual(claudeCodeRoutine(next, name).prompt, 'Run it');
      assert.strictEqual(rundockRoutine(next, name).name, name);
      // The writers address a block by its name, so an edit has to find it.
      const edited = updateRoutineBlock(next, name, { paused: true });
      assert.notStrictEqual(edited, next, 'an edit finds the block by the name it was written with');
      assert.strictEqual(readRoutineBlock(edited, name).paused, true);
      assert.ok(readAgentFile(edited).loads);
    });
  }
});

describe('a value edited into an existing routine', () => {
  for (const prompt of AWKWARD.slice(0, 4)) {
    test(`loads and reads back unchanged: ${JSON.stringify(prompt)}`, () => {
      const next = updateRoutineBlock(AGENT, 'existing', { prompt });
      assert.strictEqual(claudeCodeRoutine(next, 'existing').prompt, prompt);
      assert.strictEqual(rundockRoutine(next, 'existing').prompt, prompt);
    });
  }
});

describe('what does not change', () => {
  test('an ordinary value is written as it always was, with no quotes', () => {
    const next = appendRoutineBlock(AGENT, {
      name: 'daily-check', schedule: 'every day at 09:00', prompt: 'Run the daily check', skill: 'daily-check', timezone: 'Europe/London',
    });
    const block = next.slice(next.indexOf('- name: daily-check'));
    assert.match(block, /\n {4}schedule: every day at 09:00\n/);
    assert.match(block, /\n {4}prompt: Run the daily check\n/);
    assert.match(block, /\n {4}skill: daily-check\n/);
    assert.match(block, /\n {4}timezone: Europe\/London\n/);
    assert.match(block, /\n {4}enabled: true\n/);
  });

  test('a prompt written by hand with quotes reads as it did before: quotes and all', () => {
    // Rundock has always sent a hand-quoted prompt with its quotes, and the
    // plan an approval was given for is hashed from that text. Reading it any
    // other way would change what an approved routine runs, and lapse the
    // approval, for a file nobody touched. Only the form Rundock itself
    // writes is read back as the value inside it.
    const handWritten = AGENT.replace('prompt: Run the digest', 'prompt: "Run the digest"');
    const routine = normalizeRoutine(parseRoutineBlocks(extractFrontmatterText(handWritten))[0]);
    assert.strictEqual(routine.prompt, '"Run the digest"');
  });

  test('clearing a field still writes it empty, which reads back as absent', () => {
    const next = updateRoutineBlock(AGENT, 'existing', { timezone: '' });
    assert.match(next, /\n {4}timezone: \n/);
    assert.strictEqual(readRoutineBlock(next, 'existing').timezone, '');
  });
});

describe('the model of Claude Code\'s reading refuses what Claude Code refuses', () => {
  // The three ways a nested value was seen to drop a file against the real
  // CLI, and the one leniency it showed at the top level. If the model stops
  // refusing these, every test above it can pass on a file Claude Code drops.
  const nested = (line) => `---\nname: lead\ndescription: Runs the team\nroutines:\n  - name: r\n    ${line}\n---\n`;
  for (const [what, line] of [
    ['a colon and a space in a prompt', 'prompt: Summarize: inbox'],
    ['a prompt that starts with a backtick', 'prompt: `npm test` then report'],
    ['a stray quote', 'prompt: "Summarize" the inbox'],
  ]) {
    test(what, () => {
      const read = readAgentFile(nested(line));
      assert.strictEqual(read.loads, false);
      assert.match(read.why, /YAML cannot be read/);
    });
  }

  test('a starter prompt with a stray quote drops the file too', () => {
    const read = readAgentFile('---\nname: lead\ndescription: Runs the team\nprompts:\n  - "First" prompt\n---\n');
    assert.strictEqual(read.loads, false);
  });

  test('a top-level value with a colon in it is tolerated, as Claude Code tolerates it', () => {
    const read = readAgentFile('---\nname: lead\ndescription: Runs the team: all of it\n---\n');
    assert.strictEqual(read.loads, true);
    assert.strictEqual(read.data.description, 'Runs the team: all of it');
  });

  test('no name, or no description, and the file does not load', () => {
    assert.match(readAgentFile('---\ndescription: Runs the team\n---\n').why, /no name/);
    assert.match(readAgentFile('---\nname: lead\n---\n').why, /no description/);
  });

  test('a duplicated key, and a tab in the indentation, are refused', () => {
    assert.throws(() => readYaml('a: 1\na: 2'), /appears twice/);
    assert.throws(() => readYaml('a:\n\tb: 1'), /tab/);
  });
});
