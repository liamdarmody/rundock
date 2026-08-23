'use strict';
// The picker's fixture, checked against what really produces the list.
//
// WHY THIS FILE EXISTS. Every other test of the picker asserts against a
// hand-written fixture shaped the way the picker reads it. That proves the
// picker agrees with its author. It cannot prove the picker agrees with skill
// discovery, and if discovery names the agent's display name under some other
// key, the agent-agnostic picker names nobody while every one of those tests
// stays green.
//
// It is the same shape as the absence this card is built around: an assertion
// that matches only your own reader passes whether or not it matches the
// producer. So this one drives the REAL discovery path, the same function the
// server calls to answer a client asking for skills, and feeds its output into
// the picker unmodified.
//
// The fixture stays in the other files, where it keeps those tests readable.
// This is the one that fails if the contract between them moves.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');

const { _internal: srv } = require('../../server.js');
const { invalidateAgentCache, discoverAgents } = require('../../lib/agents/discovery.js');
const { normalizeRoutine } = require('../../lib/agents/routines.js');
const model = require('../../public/routine-editor-model.js');
const { makeWorkspace, agentFile, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const SKILL = [
  '---',
  'name: Compile the ops summary',
  'description: Pull the numbers together and write the summary.',
  '---',
  '',
  'Compile the ops summary.',
  '',
].join('\n');

// A real workspace, discovered the way the server discovers it, with the
// result handed to the picker exactly as it reaches the client.
function realSkills() {
  const dir = makeWorkspace({
    agents: {
      piper: agentFile({
        name: 'piper', displayName: 'Piper', role: 'Ops summaries',
        type: 'specialist', order: 1, skills: ['ops-summary'],
      }),
    },
    skills: { 'ops-summary': SKILL },
  });
  // srv.setWorkspace, not the config module's: server.js closes over its own
  // WORKSPACE binding and discoverSkills reads that one.
  srv.setWorkspace(dir);
  invalidateAgentCache();
  try {
    return {
      skills: srv.discoverSkills(discoverAgents()),
      restore: () => { srv.setWorkspace(null); invalidateAgentCache(); },
    };
  } catch (e) {
    srv.setWorkspace(null);
    throw e;
  }
}

describe('the picker reads what discovery writes', () => {
  test('a real workspace produces a skill the picker can offer', () => {
    const real = realSkills();
    try {
      assert.strictEqual(real.skills.length, 1, 'sanity: the workspace has one skill');
      const choice = model.skillChoices({ skills: real.skills, agentId: null });
      assert.strictEqual(choice.options.length, 1,
        'the picker offers the skill discovery found, so the keys it filters on are the keys discovery writes');
      assert.strictEqual(choice.createSkill, false, 'a workspace with a skill is not a zero-skills workspace');
    } finally { real.restore(); }
  });

  // AC-1's second half. The agent-agnostic row names who runs the skill, and
  // that name comes from discovery rather than from the fixture.
  test('the row names the agent using the key discovery actually writes', () => {
    const real = realSkills();
    try {
      const option = model.skillChoices({ skills: real.skills, agentId: null }).options[0];
      assert.strictEqual(option.agentName, 'Piper',
        'the picker reads the agent display name from the key discovery writes it under');
      assert.strictEqual(option.agentId, 'piper');
      assert.strictEqual(option.name, 'Compile the ops summary');
    } finally { real.restore(); }
  });

  // AC-2 against the real payload: the scoped entry filters on the agent id
  // discovery writes, not one the fixture invented.
  test('scoping filters on the agent id discovery actually writes', () => {
    const real = realSkills();
    try {
      assert.strictEqual(model.skillChoices({ skills: real.skills, agentId: 'piper' }).options.length, 1);
      assert.strictEqual(model.skillChoices({ skills: real.skills, agentId: 'somebody-else' }).options.length, 0);
    } finally { real.restore(); }
  });

  // The value a saved routine carries has to survive the trip back through the
  // data model, or the routine names a skill nothing resolves.
  test('a draft built from the real payload round-trips through the data model', () => {
    const real = realSkills();
    try {
      const option = model.skillChoices({ skills: real.skills, agentId: null }).options[0];
      const draft = model.routineDraft({
        skill: { id: option.id, slug: option.slug, name: option.name },
        agentId: option.agentId, frequency: 'monday', time: '07:00', runOn: 'local',
      });
      assert.ok(draft, 'the real payload builds a routine');

      // The identifier is the skill's own directory name, which is how a skill
      // is named everywhere else, and the instruction the routine carries names
      // that same identifier.
      assert.strictEqual(draft.skill, 'ops-summary');
      assert.strictEqual(draft.skill, real.skills[0].slug);
      assert.match(draft.prompt, /ops-summary/);

      const readBack = normalizeRoutine({
        name: draft.name, schedule: draft.schedule, skill: draft.skill,
        prompt: draft.prompt, runOn: draft.runOn,
      });
      assert.strictEqual(readBack.skill, 'ops-summary', 'the skill survives the data model');
      assert.strictEqual(readBack.runOn, 'local');
      assert.strictEqual(readBack.name, 'Compile the ops summary');
    } finally { real.restore(); }
  });

  // Named one by one, so a rename in discovery fails here with the key in the
  // message rather than somewhere downstream with an empty picker.
  test('discovery writes every key the picker reads', () => {
    const real = realSkills();
    try {
      const skill = real.skills[0];
      for (const key of ['id', 'slug', 'name', 'assignedAgents']) {
        assert.ok(key in skill, `skill discovery no longer writes "${key}", which the picker reads`);
      }
      assert.ok(Array.isArray(skill.assignedAgents) && skill.assignedAgents.length,
        'the picker offers only skills an agent has, so this list is what it filters on');
      for (const key of ['id', 'name']) {
        assert.ok(key in skill.assignedAgents[0],
          `skill discovery no longer writes assignedAgents[].${key}, which the picker reads`);
      }
    } finally { real.restore(); }
  });
});
