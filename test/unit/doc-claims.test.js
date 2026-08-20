'use strict';
// Doc claims pinned to behaviour.
//
// Three of four docs audited on 2026-08-13 carried claims that had been false
// for weeks. The one that had not rotted is docs/RUNTIME-ADAPTER.md, whose
// claims are pinned by test/unit/runtime-adapter.test.js reading its needles.
// That is the only mechanism in this repository that has PREVENTED rot rather
// than found it afterwards. A link checker catches a broken reference; it
// cannot catch a sentence that quietly stopped being true.
//
// These pins are behavioural. They call the code the claim is about and assert
// the claim, rather than asserting that a string appears in a source file. A
// source-shape pin can only tell you the words are still there, which is the
// half that was never in doubt.
//
// Scope is deliberate: the card says pick the claims whose falsity would
// mislead a contributor most, and do not attempt to pin prose wholesale.

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const promptLib = require('../../lib/agents/prompt.js');
const { _internal: srv } = require('../../server.js');
const { makeWorkspace, standardTeam, cleanup } = require('../helpers/workspace.js');

const ROOT = path.join(__dirname, '..', '..');
after(cleanup);

function useWorkspace(opts) {
  const dir = makeWorkspace(opts);
  srv.setWorkspace(dir);
  return dir;
}

const routinesDoc = fs.readFileSync(path.join(ROOT, 'docs', 'ROUTINES.md'), 'utf-8');
const skillsDoc = fs.readFileSync(path.join(ROOT, 'docs', 'SKILLS.md'), 'utf-8');

// ---------------------------------------------------------------------------
// docs/SKILLS.md: what actually reaches the model
// ---------------------------------------------------------------------------

describe('SKILLS.md: only slugs are injected into the prompt', () => {
  // The claim: "Rundock injects a bare list of slugs into the agent's prompt
  // (`Skills: alpha, beta`) and nothing else: no description, no summary."
  //
  // This one matters because the doc builds advice on top of it. It tells
  // authors to open the body with a clear trigger sentence and to name the
  // skill so the slug alone carries a hint, BECAUSE the slug is all the model
  // sees when deciding whether to open it. If a description ever started
  // reaching the prompt, that advice would be wrong and nothing would say so.
  test('a skill name and description do not reach the roster line', () => {
    const roster = (() => {
      useWorkspace({ agents: standardTeam() });
      const prev = promptLib.wirePromptDeps({
        discoverSkills: () => [{
          slug: 'linkedin-hooks',
          name: 'LinkedIn Hook Generator',
          description: 'SENTINEL_DESCRIPTION_MUST_NOT_REACH_THE_PROMPT',
          assignedAgents: [{ id: 'content-lead' }],
        }],
      });
      try {
        return promptLib.buildTeamRoster('chief-of-staff');
      } finally {
        promptLib.wirePromptDeps(prev);
      }
    })();

    assert.match(roster, /Skills: linkedin-hooks/, 'the slug is injected');
    // The half nothing asserted before, and the half the doc's advice rests
    // on: authors are told the slug is all the model sees when deciding
    // whether to open a skill. If a description started arriving, that advice
    // would be wrong and nothing would say so.
    assert.doesNotMatch(roster, /SENTINEL_DESCRIPTION/, 'no description reaches the prompt');
    assert.doesNotMatch(roster, /LinkedIn Hook Generator/, 'no display name reaches the prompt');
  });

  test('the doc says it is pinned, and names this file', () => {
    assert.match(skillsDoc, /doc-claims\.test\.js/,
      'SKILLS.md must name the test that pins it, so the next editor moves both');
  });
});

// ---------------------------------------------------------------------------
// docs/ROUTINES.md: the catch-up window
// ---------------------------------------------------------------------------

describe('ROUTINES.md: same-day catch-up', () => {
  const { getNextRun } = require('../../lib/scheduler.js');

  // The claim: the catch-up window is the calendar day for daily routines and
  // the weekday for weekly ones. The scheduler fires anything still due today
  // on its next tick, because a past-due target deliberately STAYS today. The
  // previous behaviour rolled it to tomorrow, which meant a routine could only
  // fire in the single millisecond its time matched exactly.
  const hh = (d) => String(d.getHours()).padStart(2, '0');
  const mm = (d) => String(d.getMinutes()).padStart(2, '0');

  test('a daily routine whose time passed earlier today is still due today', () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    // Guard: if the clock is within three hours of midnight, "earlier today"
    // is yesterday and the case under test is not the one being exercised.
    if (earlier.toDateString() !== now.toDateString()) return;

    const next = getNextRun(`every day at ${hh(earlier)}:${mm(earlier)}`, null);
    assert.ok(next, 'a past-due daily routine still has a next run');
    assert.strictEqual(next.toDateString(), now.toDateString(),
      'it stays TODAY rather than rolling to tomorrow, which is the catch-up');
    assert.ok(next <= now, 'and it is already due, so the next tick fires it');
  });

  test('a weekly routine on its own weekday behaves the same', () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    if (earlier.toDateString() !== now.toDateString()) return;

    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()];
    const next = getNextRun(`every ${weekday} at ${hh(earlier)}:${mm(earlier)}`, null);
    assert.ok(next, 'a past-due weekly routine on its weekday still has a next run');
    assert.strictEqual(next.toDateString(), now.toDateString());
    assert.ok(next <= now);
  });

  // A catch-up window without suppression is not a feature, it is a
  // double-fire. The two claims are pinned together because they are only
  // correct together.
  test('a routine that already ran today is suppressed rather than caught up', () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    if (earlier.toDateString() !== now.toDateString()) return;

    const schedule = `every day at ${hh(earlier)}:${mm(earlier)}`;
    const ranJustNow = new Date(now.getTime() - 60 * 1000).toISOString();
    assert.strictEqual(getNextRun(schedule, ranJustNow), null,
      'having already run today, it is not due again');
  });

  test('the doc says it is pinned, and names this file', () => {
    assert.match(routinesDoc, /doc-claims\.test\.js/,
      'ROUTINES.md must name the test that pins it, so the next editor moves both');
  });

  test('the doc does not also claim there is no catch-up', () => {
    // It did, in the same document that described the window, for weeks. That
    // contradiction is what this card was written to catch, so it is pinned
    // rather than merely corrected.
    assert.doesNotMatch(routinesDoc, /There is no catch-up/i,
      'ROUTINES.md must not contradict the catch-up window it documents');
  });
});
