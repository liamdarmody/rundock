'use strict';
// The routine editor's model: what the editor offers, in what words, and what
// it refuses.
//
// WHY A MODEL MODULE EXISTS AT ALL. Every criterion this card is judged
// against is a statement about copy or about what can be chosen, and both were
// otherwise going to live inside template literals in a view, where nothing
// can read them but a browser. Pulling them into a node-requireable module is
// what makes "the local option says this and not that" a test rather than a
// screenshot.
//
// THE ABSENCE THIS FILE EXISTS FOR. Release 1 runs routines in one place: the
// computer Rundock is open on. The other option, an always-on machine, is
// reserved and refused. So the only option a user can pick is the one whose
// whole point is that it does NOT run while the computer is off, and copying
// the other option's promise onto it would advertise the single thing this
// release cannot do, on the surface where the choice is made. The string is
// named as a constant below and asserted absent from the local option.
//
// NOTHING HERE READS THE MACHINE IT RUNS ON. No clock, no locale, no ambient
// time zone. Every time zone in this file is constructed, and every label is
// arithmetic rather than a locale formatter, so the same run happens in
// London, in Auckland, and at 23:59.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const model = require('../../public/routine-editor-model.js');
const { RUN_ON_SUPPORTED } = require('../../lib/agents/routines.js');

// The promise that belongs to the always-on option and to nothing else. Named
// once, here, so the assertion of absence says which string it means rather
// than gesturing at a shape.
const OFF_COMPUTER_PROMISE = 'while your computer is off';

// A workspace with two agents and three skills, one of which belongs to
// nobody. Built here rather than read from a fixture so what each assertion
// depends on is visible next to it.
function skillFixture() {
  return [
    { id: 'ops-summary', slug: 'ops-summary', name: 'Compile the ops summary',
      assignedAgents: [{ id: 'piper', name: 'Piper' }] },
    { id: 'standup-notes', slug: 'standup-notes', name: 'Draft the stand-up notes',
      assignedAgents: [{ id: 'piper', name: 'Piper' }] },
    { id: 'reading-digest', slug: 'reading-digest', name: 'Refresh the reading digest',
      assignedAgents: [{ id: 'doc', name: 'Doc' }] },
    // Assigned to nobody. A routine is declared on an agent file, so this
    // one has no file to be written into and must not be offered.
    { id: 'weekly-digest', slug: 'weekly-digest', name: 'Send the weekly digest',
      assignedAgents: [] },
  ];
}

describe('routine editor: choosing a skill', () => {
  // AC-1
  test('a skill can be chosen with no agent selected first', () => {
    const choice = model.skillChoices({ skills: skillFixture(), agentId: null });
    assert.deepStrictEqual(
      choice.options.map(o => o.id).sort(),
      ['ops-summary', 'reading-digest', 'standup-notes'],
      'every agent\'s skills are offered when no agent has been chosen',
    );
    assert.strictEqual(choice.createSkill, false);
  });

  // AC-1: the agent-agnostic list has to say who runs each skill, since the
  // reader has not picked one and the name is the only thing that answers it.
  test('with no agent selected each row names the agent that runs it', () => {
    const choice = model.skillChoices({ skills: skillFixture(), agentId: null });
    const byId = Object.fromEntries(choice.options.map(o => [o.id, o]));
    assert.strictEqual(byId['ops-summary'].agentName, 'Piper');
    assert.strictEqual(byId['reading-digest'].agentName, 'Doc');
  });

  // AC-2
  test('from an agent\'s page the choice is scoped to that agent', () => {
    const choice = model.skillChoices({ skills: skillFixture(), agentId: 'piper' });
    assert.deepStrictEqual(
      choice.options.map(o => o.id).sort(),
      ['ops-summary', 'standup-notes'],
      'a skill belonging to another agent is not offered',
    );
  });

  // AC-2: scoped rows carry no agent name, because there is only one agent and
  // repeating it on every row is noise.
  test('a scoped row does not repeat the agent it was scoped to', () => {
    const choice = model.skillChoices({ skills: skillFixture(), agentId: 'piper' });
    for (const option of choice.options) assert.strictEqual(option.agentName, null);
  });

  // A skill nothing is assigned to cannot be scheduled: a routine lives in an
  // agent file, so there is no file to write it into. Offering it would build
  // a picker whose selection has nowhere to go.
  test('a skill assigned to no agent is not offered', () => {
    for (const agentId of [null, 'piper']) {
      const choice = model.skillChoices({ skills: skillFixture(), agentId });
      assert.ok(
        !choice.options.some(o => o.id === 'weekly-digest'),
        'a skill with no agent has no file a routine could be written into',
      );
    }
  });

  // AC-4, AC-13. Driven through the same function the editor calls, with an
  // empty workspace, rather than by asserting a branch exists.
  test('a workspace with no skills offers the create-a-skill path', () => {
    const choice = model.skillChoices({ skills: [], agentId: null });
    assert.deepStrictEqual(choice.options, []);
    assert.strictEqual(choice.createSkill, true, 'the zero-skills state offers a way to make one');
    assert.ok(choice.createSkillLabel && choice.createSkillLabel.trim(), 'the offer has words on it');
  });

  // AC-4: the same offer has to appear when an agent is selected and that
  // agent has nothing, which is the likelier way to meet it.
  test('an agent with no skills of its own offers the same path', () => {
    const choice = model.skillChoices({ skills: skillFixture(), agentId: 'nobody' });
    assert.deepStrictEqual(choice.options, []);
    assert.strictEqual(choice.createSkill, true);
  });

  // The lead line above the picker answers the question the entry point left
  // open: whose skills am I looking at. Scoped, it names the agent; agnostic,
  // it says so rather than naming nobody.
  test('the lead line names the agent when the choice was scoped to one', () => {
    assert.strictEqual(model.stepLead({ agentName: 'Piper' }), 'Step 1 of 2. Pick a skill Piper already has.');
    assert.strictEqual(model.stepLead({ agentName: null }), 'Step 1 of 2. Pick a skill any of your agents already has.');
    assert.strictEqual(model.stepLead(), 'Step 1 of 2. Pick a skill any of your agents already has.');
  });

  // AC-17 is the owner's to sign off, and this is the part of it a diff can
  // carry: the zero-skills copy offers something rather than reporting a fault.
  test('the zero-skills copy names no error', () => {
    const choice = model.skillChoices({ skills: [], agentId: null });
    const words = `${choice.createSkillLabel} ${choice.emptyLead}`.toLowerCase();
    for (const alarm of ['error', 'failed', 'cannot', 'unable', 'invalid', 'missing']) {
      assert.ok(!words.includes(alarm), `the offer must not read as a fault: found "${alarm}"`);
    }
  });
});

describe('routine editor: the schedule is built, not typed', () => {
  // AC-3
  test('a schedule is assembled from the offered words', () => {
    assert.strictEqual(
      model.buildSchedule({ frequency: 'monday', time: '07:00' }),
      'every monday at 07:00',
    );
    assert.strictEqual(
      model.buildSchedule({ frequency: 'day', time: '06:30' }),
      'every day at 06:30',
    );
  });

  // AC-3: the point of a sentence builder is that an expression cannot be
  // reached through it. Each of these is a real thing someone would type.
  test('an expression typed into either field builds nothing', () => {
    for (const attempt of [
      { frequency: '0 5 * * *', time: '07:00' },
      { frequency: 'day', time: '0 5 * * *' },
      { frequency: 'weekday', time: '07:00' },
      { frequency: 'day', time: '7:00' },
      { frequency: 'day', time: '07:15' },
      { frequency: 'Monday', time: '07:00' },
      { frequency: 'day', time: '' },
      { frequency: '', time: '07:00' },
    ]) {
      assert.strictEqual(
        model.buildSchedule(attempt), null,
        `${JSON.stringify(attempt)} must not assemble into a schedule`,
      );
    }
  });

  // Every value the builder offers has to be one the scheduler recognises, or
  // the editor writes routines that never fire and says nothing. Pinned
  // against the format the scheduler documents rather than against itself.
  test('every offered combination matches the schedule format the scheduler reads', () => {
    const recognised = /^every (day|monday|tuesday|wednesday|thursday|friday|saturday|sunday) at ([01]\d|2[0-3]):[0-5]\d$/;
    for (const frequency of model.FREQUENCIES) {
      for (const time of model.times()) {
        const built = model.buildSchedule({ frequency: frequency.value, time: time.value });
        assert.match(built, recognised, `${frequency.value} at ${time.value} is not a schedule the scheduler reads`);
      }
    }
  });

  // Labels are arithmetic, not a locale formatter, so this run says the same
  // thing on every machine.
  test('times read as plain clock words', () => {
    const byValue = Object.fromEntries(model.times().map(t => [t.value, t.label]));
    assert.strictEqual(byValue['07:00'], '7:00am');
    assert.strictEqual(byValue['00:00'], '12:00am');
    assert.strictEqual(byValue['00:30'], '12:30am');
    assert.strictEqual(byValue['12:00'], '12:00pm');
    assert.strictEqual(byValue['13:30'], '1:30pm');
    assert.strictEqual(byValue['23:30'], '11:30pm');
    assert.strictEqual(model.times().length, 48);
  });
});

describe('routine editor: where it runs', () => {
  // AC-5
  test('the local option renders "This computer"', () => {
    const local = model.runOnOptions().find(o => o.value === 'local');
    assert.ok(local, 'the local option is offered');
    assert.strictEqual(local.name, 'This computer');
  });

  // AC-6
  test('the local option renders "Runs while Rundock is open here"', () => {
    const local = model.runOnOptions().find(o => o.value === 'local');
    assert.strictEqual(local.meta, 'Runs while Rundock is open here.');
  });

  // AC-7, AC-14. THE ASSERTION OF ABSENCE.
  //
  // An absence on its own is worth nothing: this passes against a module that
  // returns an empty object. So the same string is asserted PRESENT on the
  // option it belongs to, in the same test. The pair is the claim: the words
  // exist in this module, and they are not on the option a user can pick.
  test('no string on the local option promises running while the computer is off', () => {
    const options = model.runOnOptions();
    const local = options.find(o => o.value === 'local');
    const alwaysOn = options.find(o => o.value === 'agent-computer');

    const localCopy = [local.name, local.meta, local.sentence, local.setupLabel]
      .filter(Boolean).join(' ').toLowerCase();
    assert.ok(
      !localCopy.includes(OFF_COMPUTER_PROMISE),
      `the local option must not carry "${OFF_COMPUTER_PROMISE}": it is the one thing it cannot do`,
    );

    const alwaysOnCopy = [alwaysOn.name, alwaysOn.meta, alwaysOn.sentence, alwaysOn.setupLabel]
      .filter(Boolean).join(' ').toLowerCase();
    assert.ok(
      alwaysOnCopy.includes(OFF_COMPUTER_PROMISE),
      'the promise belongs to the always-on option, so its absence elsewhere means something',
    );
  });

  // AC-7, widened past the one phrase. Any way of saying the same thing on the
  // local option is the same defect.
  test('the local option promises nothing about the computer being closed', () => {
    const local = model.runOnOptions().find(o => o.value === 'local');
    const copy = [local.name, local.meta, local.sentence].filter(Boolean).join(' ').toLowerCase();
    for (const phrase of ['computer is off', 'laptop is closed', 'even when closed', 'always on', '24/7', 'while you are away']) {
      assert.ok(!copy.includes(phrase), `the local option must not say "${phrase}"`);
    }
  });

  // AC-8. The run-on words are read off the chosen option, so an option that
  // is not local produces different words through the same code path. A fixed
  // string cannot satisfy both halves.
  test('the run-on words come from the option rather than a fixed string', () => {
    const args = { frequency: 'monday', time: '07:00', skillName: 'Compile the ops summary' };
    assert.strictEqual(
      model.previewSentence({ ...args, runOn: 'local' }),
      'Every Monday at 7:00am, run: Compile the ops summary, on this computer.',
    );
    assert.strictEqual(
      model.previewSentence({ ...args, runOn: 'agent-computer' }),
      'Every Monday at 7:00am, run: Compile the ops summary, on your Agent Computer.',
    );
  });

  // AC-8, the second reader of the same variable: the confirmation line.
  test('the confirmation line reads its second sentence off the same option', () => {
    assert.strictEqual(
      model.readyCaption({ zone: 'Europe/London', runOn: 'local' }),
      'London time. Runs while Rundock is open here.',
    );
    assert.notStrictEqual(
      model.readyCaption({ zone: 'Europe/London', runOn: 'agent-computer' }),
      model.readyCaption({ zone: 'Europe/London', runOn: 'local' }),
    );
  });

  // agent-computer is reserved, not offered. It appears as a way to find out
  // what it is, and it cannot be picked.
  test('the always-on option cannot be chosen in this release', () => {
    const options = model.runOnOptions();
    assert.deepStrictEqual(
      options.filter(o => o.selectable).map(o => o.value), ['local'],
      'local is the only choice this release can honour',
    );
    const alwaysOn = options.find(o => o.value === 'agent-computer');
    assert.strictEqual(alwaysOn.selectable, false);
    assert.ok(alwaysOn.setupLabel, 'it is a way in rather than a dead row');
  });

  // The client's idea of what can run and the server's are one fact. Written
  // in two places because a browser module cannot require the server's, so it
  // is pinned instead of duplicated silently.
  test('what the editor offers matches what the data model supports', () => {
    assert.deepStrictEqual(model.RUN_ON_SUPPORTED, RUN_ON_SUPPORTED);
  });
});

describe('routine editor: the caveat', () => {
  // AC-9
  test('the caveat states that routines run on the machine they were made on', () => {
    assert.match(model.RUN_ON_CAVEAT, /machine they were made on/i);
  });

  // AC-9, the second half of what the multi-machine decision requires: a
  // workspace opened on four computers is four locals, and the copy has to say
  // so rather than be silent.
  test('the caveat says a workspace on more than one computer runs on each', () => {
    assert.match(model.RUN_ON_CAVEAT, /more than one computer/i);
    assert.match(model.RUN_ON_CAVEAT, /each of them/i);
  });

  // AC-10. The caveat belongs to the field where the choice is made, so the
  // model hands it back as part of that field rather than as a loose export a
  // help page could be the only reader of.
  test('the caveat is part of the run-on field itself', () => {
    const field = model.runOnField();
    assert.strictEqual(field.caveat, model.RUN_ON_CAVEAT);
    assert.deepStrictEqual(field.options, model.runOnOptions());
    assert.ok(field.label, 'the field is labelled where it is shown');
  });
});

describe('routine editor: what save produces', () => {
  const skill = skillFixture()[0];

  test('a draft carries the schedule, the skill and where it runs', () => {
    const draft = model.routineDraft({
      skill, agentId: 'piper', frequency: 'monday', time: '07:00', runOn: 'local',
    });
    assert.strictEqual(draft.agentId, 'piper');
    assert.strictEqual(draft.schedule, 'every monday at 07:00');
    assert.strictEqual(draft.skill, 'ops-summary');
    assert.strictEqual(draft.runOn, 'local');
    assert.strictEqual(draft.name, 'Compile the ops summary');
    assert.match(draft.prompt, /ops-summary/, 'the routine runs the skill that was chosen');
  });

  // The reserved value is refused at the point a routine is made, not just
  // hidden in the picker.
  test('a draft naming the reserved target is refused', () => {
    assert.strictEqual(model.routineDraft({
      skill, agentId: 'piper', frequency: 'monday', time: '07:00', runOn: 'agent-computer',
    }), null);
  });

  test('a draft with an unbuildable schedule is refused', () => {
    assert.strictEqual(model.routineDraft({
      skill, agentId: 'piper', frequency: 'weekday', time: '07:00', runOn: 'local',
    }), null);
  });

  test('a draft with no skill is refused', () => {
    assert.strictEqual(model.routineDraft({
      skill: null, agentId: 'piper', frequency: 'monday', time: '07:00', runOn: 'local',
    }), null);
  });

  // AC-11. Where save goes is the model's answer rather than a view's, so it
  // is one fact with one reader.
  test('save returns to the list', () => {
    assert.strictEqual(model.SAVE_DESTINATION, 'routines');
  });
});

describe('routine editor: the words it ships', () => {
  // AC-12. The repository's check (npm run check:refs) runs over every tracked
  // file and is the enforcement. This narrows it to the copy this card adds
  // and to the word list the workspace guide states, so the criterion is
  // discharged from the diff rather than from a command nobody ran here.
  const BANNED = ['leverage', 'streamline', 'empower', 'utilize', 'robust', 'seamless', 'dive into'];

  function everyString(value, out = []) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) everyString(v, out);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) everyString(v, out);
    return out;
  }

  function copyShipped() {
    return everyString([
      model.runOnField(),
      model.FREQUENCIES,
      model.times(),
      model.skillChoices({ skills: [], agentId: null }),
      model.skillChoices({ skills: skillFixture(), agentId: null }),
      model.previewSentence({ frequency: 'monday', time: '07:00', skillName: 'A skill', runOn: 'local' }),
      model.readyCaption({ zone: 'Europe/London', runOn: 'local' }),
      model.timezoneCaption({ zone: 'Europe/London', agentName: 'Piper' }),
      model.timezoneCaption({ zone: 'Europe/London', agentName: null }),
      model.STEP_LEADS,
    ]);
  }

  test('no banned word reaches the editor\'s copy', () => {
    for (const line of copyShipped()) {
      for (const word of BANNED) {
        assert.ok(!line.toLowerCase().includes(word), `"${word}" in: ${line}`);
      }
    }
  });

  test('no em dash or en dash reaches the editor\'s copy', () => {
    for (const line of copyShipped()) {
      assert.ok(!/[\u2014\u2013]/.test(line), `dash in: ${line}`);
    }
  });

  test('the copy is UK spelling', () => {
    for (const line of copyShipped()) {
      assert.ok(!/\b\w+ize[sd]?\b/i.test(line), `US spelling in: ${line}`);
      assert.ok(!/\bcolor\b/i.test(line), `US spelling in: ${line}`);
    }
  });

  // The files this card adds carry no dash either, which is what the
  // repository's own check enforces across the tree.
  test('the files this card adds carry no em dash or en dash', () => {
    const root = path.join(__dirname, '..', '..');
    for (const rel of ['public/routine-editor-model.js', 'test/unit/routine-editor-model.test.js']) {
      const text = fs.readFileSync(path.join(root, rel), 'utf-8');
      assert.ok(!/[\u2014\u2013]/.test(text), `${rel} carries a dash the repository check refuses`);
    }
  });
});

describe('routine editor: time zones are words, and never the runner\'s', () => {
  // The zone is always supplied. Reading the runner's would make every
  // assertion below a statement about the machine rather than about the code.
  test('a zone renders as its place name', () => {
    assert.strictEqual(model.timezoneWords('Europe/London'), 'London');
    assert.strictEqual(model.timezoneWords('America/New_York'), 'New York');
    assert.strictEqual(model.timezoneWords('Australia/Sydney'), 'Sydney');
  });

  test('no offset ever appears', () => {
    for (const zone of ['Europe/London', 'America/New_York', 'Pacific/Auckland', 'UTC']) {
      const caption = model.timezoneCaption({ zone, agentName: 'Piper' });
      assert.ok(!/GMT|UTC[+-]|[+-]\d{2}:?\d{2}/.test(caption), `an offset leaked for ${zone}: ${caption}`);
    }
  });

  test('the caption names the agent when there is one, and the team when there is not', () => {
    assert.match(model.timezoneCaption({ zone: 'Europe/London', agentName: 'Piper' }), /^Your time zone: London\. Piper reads/);
    assert.match(model.timezoneCaption({ zone: 'Europe/London', agentName: null }), /^Your time zone: London\. Your agents read/);
  });

  test('an absent zone drops the caption rather than inventing one', () => {
    assert.strictEqual(model.timezoneCaption({ zone: '', agentName: 'Piper' }), null);
    assert.strictEqual(model.timezoneWords(''), null);
  });
});
