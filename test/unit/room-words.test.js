'use strict';
// THE WORDS OF THE HELPERS PANEL: its title, the line saying how fast the
// plan's allowance goes, a row's step and state, a helper's label, the note
// under the composer, the Codex notice and the Allow card's title. Each form
// is held here word for word, because the page draws only what these give.
//
// The module is asserted to exist before it is used, so a page without it
// fails here on an assertion rather than on a require that throws.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '..', 'public', 'room-words.js');
function words(...wanted) {
  assert.ok(fs.existsSync(FILE), 'public/room-words.js exists');
  const m = require(FILE);
  for (const name of wanted) assert.strictEqual(typeof m[name], 'function', `RundockRoomWords.${name} is a function`);
  return m;
}
const mate = (name) => ({ name });
const other = { name: null };

describe('the panel\'s title says who started what', () => {
  const cases = [
    ['two teammates', 'Wren', ['Ash', 'Rowan'], 0, 'Wren started 2 teammates'],
    ['two teammates and a helper', 'Wren', ['Ash', 'Rowan'], 1, 'Wren started 2 teammates and a helper'],
    ['two teammates and two helpers', 'Wren', ['Ash', 'Rowan'], 2, 'Wren started 2 teammates and 2 helpers'],
    ['two helpers', 'Wren', [], 2, 'Wren started 2 helpers'],
    ['a helper', 'Wren', [], 1, 'Wren started a helper'],
    ['one teammate, by name', 'Wren', ['Rowan'], 0, 'Wren started Rowan'],
    ['one teammate and a helper', 'Wren', ['Rowan'], 1, 'Wren started Rowan and a helper'],
    ['two helpers on Codex', 'Fern', [], 2, 'Fern started 2 helpers'],
    ['a helper on Codex', 'Fern', [], 1, 'Fern started a helper'],
  ];
  for (const [what, lead, teammates, helpers, said] of cases) {
    test(`${what}: "${said}"`, () => {
      assert.strictEqual(words('title').title(lead, teammates, helpers), said);
    });
  }
});

describe('the rate line says how fast the plan\'s allowance goes', () => {
  test('N reads in words, twice to six times, and is never more than six', () => {
    const { rateLine } = words('rateLine');
    const said = [2, 3, 4, 5, 6, 7, 9].map((n) => rateLine('Wren', [mate('Ash'), mate('Rowan')], n, []));
    assert.deepStrictEqual(said.map((s) => s.slice(s.indexOf('up to ') + 6, s.indexOf(' as fast'))),
      ['twice', 'three times', 'four times', 'five times', 'six times', 'six times', 'six times']);
  });

  test('two teammates by name', () => {
    assert.strictEqual(words('rateLine').rateLine('Wren', [mate('Ash'), mate('Rowan')], 3, []),
      'Ash and Rowan work at the same time, so your plan\'s allowance is used up to three times as fast while they work.');
  });

  test('two teammates and a helper outside the team, counted as the lead\'s', () => {
    assert.strictEqual(words('rateLine').rateLine('Wren', [mate('Ash'), mate('Rowan'), other], 4, []),
      'Ash, Rowan and Wren\'s helper work at the same time, so your plan\'s allowance is used up to four times as fast while they work.');
  });

  test('the lead\'s helpers counted together, where the first of them started', () => {
    assert.strictEqual(words('rateLine').rateLine('Wren', [other, mate('Ash'), other], 4, []),
      'Wren\'s 2 helpers and Ash work at the same time, so your plan\'s allowance is used up to four times as fast while they work.');
  });

  test('a Codex lead\'s two helpers', () => {
    assert.strictEqual(words('rateLine').rateLine('Fern', [other, other], 3, []),
      'Fern\'s 2 helpers work at the same time, so your plan\'s allowance is used up to three times as fast while they work.');
  });

  test('one helper outside the team with nobody else running', () => {
    assert.strictEqual(words('rateLine').rateLine('Wren', [other], 2, []),
      'Wren\'s helper works at the same time as Wren, so your plan\'s allowance is used up to twice as fast while it works.');
  });

  test('one teammate with others running names the lead and them', () => {
    assert.strictEqual(words('rateLine').rateLine('Wren', [mate('Rowan')], 3, ['Ash']),
      'Rowan works at the same time as Wren and Ash, so your plan\'s allowance is used up to three times as fast while they work.');
  });

  test('one teammate with nobody else running', () => {
    assert.strictEqual(words('rateLine').rateLine('Wren', [mate('Rowan')], 2, []),
      'Rowan works while Wren carries on, so your plan\'s allowance is used up to twice as fast while Rowan works.');
  });

  test('one helper outside the team with others running takes the teammate\'s form', () => {
    assert.strictEqual(words('rateLine').rateLine('Wren', [other], 3, ['Ash']),
      'Wren\'s helper works at the same time as Wren and Ash, so your plan\'s allowance is used up to three times as fast while they work.');
  });

  test('more than five teammates', () => {
    assert.strictEqual(words('rateLine').rateLine('Wren', Array(6).fill(mate('Ash')), 6, []),
      'Up to five of these teammates work at the same time, so your plan\'s allowance is used up to six times as fast while they work.');
  });

  test('more than five, any of them a helper outside the team', () => {
    assert.strictEqual(words('rateLine').rateLine('Wren', [...Array(5).fill(mate('Ash')), other], 6, []),
      'Up to five of these helpers work at the same time, so your plan\'s allowance is used up to six times as fast while they work.');
  });

  test('nobody to name says nothing', () => {
    assert.strictEqual(words('rateLine').rateLine('Wren', [], 2, []), '');
  });

  test('six helpers started one at a time, the sixth stopped by the cap', () => {
    const { rateLine } = words('rateLine');
    const seen = [1, 2, 3, 4, 5].map((k) => rateLine('Fern', Array(k).fill(other), k + 1, []));
    seen.push(rateLine('Fern', Array(5).fill(other), 6, []));
    assert.deepStrictEqual(seen, [
      'Fern\'s helper works at the same time as Fern, so your plan\'s allowance is used up to twice as fast while it works.',
      'Fern\'s 2 helpers work at the same time, so your plan\'s allowance is used up to three times as fast while they work.',
      'Fern\'s 3 helpers work at the same time, so your plan\'s allowance is used up to four times as fast while they work.',
      'Fern\'s 4 helpers work at the same time, so your plan\'s allowance is used up to five times as fast while they work.',
      'Fern\'s 5 helpers work at the same time, so your plan\'s allowance is used up to six times as fast while they work.',
      'Fern\'s 5 helpers work at the same time, so your plan\'s allowance is used up to six times as fast while they work.',
    ]);
  });
});

describe('a row\'s step and state', () => {
  const step = (type, detail = null) => ({ type, detail });
  const cases = [
    ['Read', step('Read', 'Content-Metrics-October.md'), 'Working: reading Content-Metrics-October.md'],
    ['Write', step('Write', 'report.md'), 'Working: writing report.md'],
    ['Edit', step('Edit', 'plan.md'), 'Working: editing plan.md'],
    ['MultiEdit', step('MultiEdit', 'plan.md'), 'Working: editing plan.md'],
    ['NotebookEdit', step('NotebookEdit', 'cells.ipynb'), 'Working: editing cells.ipynb'],
    ['Codex fileChange, by the path\'s last part', step('fileChange', 'decks/q3/deck.md'), 'Working: editing deck.md'],
    ['Bash', step('Bash'), 'Working: running a command'],
    ['commandExecution', step('commandExecution', 'ls rates'), 'Working: running a command'],
    ['Grep', step('Grep'), 'Working: searching the workspace'],
    ['Glob', step('Glob'), 'Working: searching the workspace'],
    ['WebFetch', step('WebFetch'), 'Working: reading a web page'],
    ['WebSearch', step('WebSearch'), 'Working: searching the web'],
    ['webSearch', step('webSearch', 'rates'), 'Working: searching the web'],
    ['a connector tool', step('mcp__example__search'), 'Working: using a connector'],
    ['mcpToolCall', step('mcpToolCall', 'notes/search'), 'Working: using a connector'],
    ['no step', null, 'Working'],
    ['any other tool', step('TodoWrite'), 'Working'],
    ['a file tool with no name', step('Read'), 'Working'],
  ];
  for (const [what, s, said] of cases) {
    test(`running, ${what}: "${said}"`, () => {
      assert.strictEqual(words('stateWords').stateWords({ state: 'running', step: s }), said);
    });
  }
  test('the other states', () => {
    const { stateWords } = words('stateWords');
    assert.deepStrictEqual([
      stateWords({ state: 'completed', step: null }),
      stateWords({ state: 'failed', step: null }),
      stateWords({ state: 'killed', step: null }),
      stateWords({ state: 'waiting', step: null }),
      stateWords({ state: 'killed', step: null, capped: true }),
    ], ['Done', 'Stopped before finishing', 'Stopped before finishing', 'Waiting. Starts when one finishes', 'Stopped. At most five helpers run at once.']);
  });
  test('a file\'s name is its last part', () => {
    const { fileName } = words('fileName');
    assert.deepStrictEqual([fileName('out/report.md'), fileName('report.md'), fileName('a\\b\\c.md')], ['report.md', 'report.md', 'c.md']);
  });
});

describe('a helper outside the team is named from a closed map', () => {
  test('each type\'s label, and Helper for any other', () => {
    const { helperLabel } = words('helperLabel');
    assert.deepStrictEqual(['Explore', 'Plan', 'web-fetch', 'general-purpose', undefined, 'claude', 'made-up', '<b>x</b>', 'constructor'].map(helperLabel),
      ['Search helper', 'Planning helper', 'Web helper', 'Helper', 'Helper', 'Helper', 'Helper', 'Helper', 'Helper']);
  });
  test('within a panel a repeated label takes its number', () => {
    assert.deepStrictEqual(words('numbered').numbered(['Helper', 'Search helper', 'Helper', 'Search helper', 'Helper', 'Ash']),
      ['Helper', 'Search helper', 'Helper 2', 'Search helper 2', 'Helper 3', 'Ash']);
  });
});

describe('the note under the composer', () => {
  const cases = [
    ['one teammate', [mate('Ash')], 'Ash is still working. Your message goes to Wren.'],
    ['two teammates', [mate('Ash'), mate('Rowan')], 'Ash and Rowan are still working. Your message goes to Wren.'],
    ['a teammate and a helper', [mate('Ash'), other], 'Ash and Wren\'s helper are still working. Your message goes to Wren.'],
    ['two helpers', [other, other], 'Wren\'s 2 helpers are still working. Your message goes to Wren.'],
    ['nobody', [], ''],
  ];
  for (const [what, members, said] of cases) {
    test(`${what}: "${said}"`, () => {
      assert.strictEqual(words('noteWords').noteWords('Wren', 'Wren', members), said);
    });
  }
});

describe('the Codex notice and the Allow card\'s title', () => {
  test('the notice, for three helpers and for one', () => {
    const { codexNotice } = words('codexNotice');
    assert.strictEqual(codexNotice('Fern', 3), 'Fern started 3 helpers. Codex starts helpers straight away, so this wasn\'t asked first. Stop any you don\'t want.');
    assert.strictEqual(codexNotice('Fern', 1), 'Fern started a helper. Codex starts helpers straight away, so this wasn\'t asked first. Stop any you don\'t want.');
  });
  test('the Allow card\'s title, for two teammates and for one', () => {
    const { allowTitle } = words('allowTitle');
    assert.deepStrictEqual([allowTitle('Wren', ['Ash', 'Rowan']), allowTitle('Wren', ['Rowan'])],
      ['Wren wants to start 2 teammates', 'Wren wants to start Rowan']);
  });
  test('"Asked by" names the helper and its lead', () => {
    const { askedBy } = words('askedBy');
    assert.deepStrictEqual([askedBy('Ash', 'Wren'), askedBy('Search helper', 'Wren'), askedBy('rates', 'Fern')],
      ['Asked by Ash, helping Wren', 'Asked by Search helper, helping Wren', 'Asked by rates, helping Fern']);
  });
  test('Stop names its row', () => {
    const { stopLabel } = words('stopLabel');
    assert.deepStrictEqual(['Ash', 'Search helper', 'rates'].map(stopLabel), ['Stop Ash', 'Stop Search helper', 'Stop rates']);
  });
});
