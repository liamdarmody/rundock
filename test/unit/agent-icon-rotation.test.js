'use strict';
// The glyph the guide reserves cannot be handed to somebody else's agent.
//
// An agent with no `icon` of its own is given one from a fixed rotation. The
// rotation carried the hexagon, and docs/AGENTS.md reserves that hexagon for
// the platform guide, so the seventh icon-less agent in a workspace was handed
// the guide's own glyph and the two became indistinguishable in the org chart
// and the sidebar.
//
// THE RESERVED GLYPH IS A LITERAL HERE, NOT A CONSTANT READ FROM THE CODE.
// The first draft of this file read it from the module under test. With no
// such export the comparison was against undefined, every icon differed from
// it, and the whole behavioural test passed against the unfixed code: a proof
// that could not fail. The glyph is the fact this file is about, so it is
// written down here, and the code's own constant is checked AGAINST it.
//
// TWO PROOFS, AND THEY PROVE DIFFERENT THINGS.
//
// The first drives discovery over a roster of icon-less agents long enough to
// exhaust the rotation, and reads the icons off the agents a user would see.
// That is the surface: a rotation is only ever met through an assigned icon.
//
// The second reads the rotation itself, because the first can only ever fail
// once somebody has already shipped a collision. A rotation extended by one
// more glyph next year is a new roster length, and the behavioural test would
// have to have guessed it. Reading the array the assignment indexes into is
// what makes the removal permanent rather than merely done.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const discovery = require('../../lib/agents/discovery.js');
const { _internal: srv } = require('../../server.js');
const { makeWorkspace, agentFile, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const ROOT = path.join(__dirname, '..', '..');

// U+2B21 WHITE HEXAGON, the glyph docs/AGENTS.md reserves for the guide.
const RESERVED = '⬡';

// Long enough to run past the end of the rotation whatever its length, so the
// test does not encode the count it is checking. File order is not guaranteed
// by readdirSync, which is why every assertion below is about the SET of
// glyphs handed out rather than about which agent got which.
const ROSTER = 12;

describe('the auto-assign rotation and the glyph the guide reserves', () => {
  test('no icon-less agent is ever handed the guide\'s glyph', () => {
    const agents = {};
    for (let i = 0; i < ROSTER; i++) {
      const slug = `filler-${String(i).padStart(2, '0')}`;
      agents[slug] = agentFile({ name: slug, role: 'Filler', type: 'specialist', order: i + 1 });
    }
    // THE PREMISE, ASSERTED RATHER THAN ASSUMED. This roster only exercises
    // the rotation while the fixtures declare no icon of their own. The
    // builder does not write one today; the day it does, every assertion below
    // would be about the fixture rather than about the rotation and would pass
    // whatever the rotation contained.
    for (const [slug, content] of Object.entries(agents)) {
      assert.ok(!/^icon:/m.test(content),
        `${slug} declares its own icon, so this roster no longer exercises the rotation`);
    }
    srv.setWorkspace(makeWorkspace({ agents }));

    const discovered = discovery.discoverAgents().filter(a => a.id.startsWith('filler-'));
    assert.strictEqual(discovered.length, ROSTER, 'sanity: every filler agent was discovered');

    // THE SANITY CHECK PROVES WHAT IT CLAIMS. "Every agent has some icon" was
    // the first version, and it holds just as well when the icons came from
    // anywhere at all, which would leave the collision assertion below vacuous.
    // These two say the icons came from the rotation and that the whole of it
    // was walked, which is what makes the absence below meaningful.
    const handed = discovered.map(a => a.icon);
    const rotation = discovery.AUTO_ASSIGNED_ICONS;
    for (const icon of handed) {
      assert.ok(rotation.includes(icon),
        `an icon-less agent was handed ${icon}, which is not in the rotation at all`);
    }
    assert.deepStrictEqual([...new Set(handed)].sort(), [...rotation].sort(),
      `a roster of ${ROSTER} is longer than the rotation, so every glyph in it must have been `
      + 'handed out; anything missing means the rotation was not the source');

    const collided = discovered.filter(a => a.icon === RESERVED).map(a => a.id);
    assert.deepStrictEqual(collided, [],
      `an icon-less agent was handed ${RESERVED}, which the guide reserves, so the two are `
      + 'indistinguishable in the org chart and the sidebar');
  });

  test('the reserved glyph is absent from the rotation, so it cannot be added back', () => {
    // Read from the exported array the assignment indexes into, NOT from a
    // copy and not from the source text. A test that reads its own copy stays
    // green while the real rotation grows a reserved glyph back.
    const rotation = discovery.AUTO_ASSIGNED_ICONS;
    assert.ok(Array.isArray(rotation) && rotation.length > 0,
      'the rotation the assignment uses is exported, so a test can read the same array');
    assert.ok(!rotation.includes(RESERVED),
      `${RESERVED} is reserved for the guide and must not be in the rotation; `
      + `found ${JSON.stringify(rotation)}`);
    // Every glyph in it is distinct, which is the property the rotation exists
    // for and the one a careless edit breaks alongside the reserved glyph.
    assert.strictEqual(new Set(rotation).size, rotation.length, 'the rotation repeats a glyph');
  });

  test('the glyph the code reserves is the glyph the guide actually wears', () => {
    // Three places name it and they must not drift: the constant, the guide's
    // own scaffolded file, and the page that tells a user it is reserved.
    assert.strictEqual(discovery.GUIDE_RESERVED_ICON, RESERVED,
      'the constant the code reserves by is not the glyph this file is about');
    const scaffold = fs.readFileSync(path.join(ROOT, 'scaffold', 'rundock-guide.md'), 'utf-8');
    assert.match(scaffold, new RegExp(`^icon: ${RESERVED}$`, 'm'),
      'the guide the scaffold ships does not wear the glyph the code reserves for it');
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'AGENTS.md'), 'utf-8');
    assert.ok(doc.includes(RESERVED),
      'the page that tells a user which glyph is reserved does not name this one');
  });
});
