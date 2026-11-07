'use strict';
// Whose clock a schedule follows, and which zone the window is told.
//
// THE SERVER AND THE WINDOW CAN BE IN DIFFERENT ZONES. A Rundock on a server
// reached through a tunnel puts the window on the person's own computer and
// the scheduler somewhere else. The scheduler sets a slot's hour on its own
// process's clock, so a schedule is read in the server's zone, and the window
// has to be told which zone that is rather than name its own.
//
// THE ZONE IS SET HERE, AND CHANGED HERE, ON PURPOSE. This process starts in
// UTC, and UTC plays the window. Each roster is built with process.env.TZ set
// to the zone the server is in for that test, which Node follows at once
// inside one process, and the zone goes back to UTC before the window draws
// anything. Nothing here reads the zone of the machine it runs on.
process.env.TZ = 'UTC';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { agentFile, makeWorkspace, cleanup } = require('../helpers/workspace.js');
const { invalidateAgentCache, rosterMessage } = require('../../lib/agents/discovery.js');
const sched = require('../../lib/scheduler.js');
const config = require('../../lib/config.js');

after(cleanup);

const WINDOW_ZONE = 'UTC';
// Wednesday 7 October 2026, 05:00 UTC: 06:00 in London and 01:00 in New York,
// so the routine's hour is still ahead in every zone used here and its next
// run is today's slot.
const NOW = new Date(Date.UTC(2026, 9, 7, 5, 0));
const SCHEDULE = 'every day at 08:00';

/** Run `fn` as the server does, in `zone`, then come back to the window's. */
function asServer(zone, fn) {
  process.env.TZ = zone;
  try { return fn(); } finally { process.env.TZ = WINDOW_ZONE; }
}

function workspace() {
  return makeWorkspace({
    agents: {
      piper: agentFile({
        name: 'piper', displayName: 'Piper', type: 'specialist', order: 1,
        routines: [{ name: 'Morning briefing', schedule: SCHEDULE, prompt: 'Run the morning-briefing skill.', enabled: true }],
      }),
    },
  });
}

/**
 * Hold the scheduler on one workspace and one instant for the length of `fn`,
 * with its stores read from that workspace, and put everything back after.
 */
function onWorkspace(dir, fn) {
  const previousWorkspace = config.getWorkspace();
  config.setWorkspace(dir);
  sched.loadRoutineState();
  invalidateAgentCache();
  const previousDeps = sched.wireSchedulerDeps({ now: () => NOW, getWssClients: () => [] });
  try {
    return fn();
  } finally {
    sched.wireSchedulerDeps(previousDeps);
    config.setWorkspace(previousWorkspace);
    invalidateAgentCache();
  }
}

/**
 * The roster a server in `zone` sends: built by the one builder every roster
 * goes through, and turned into JSON and back the way the socket carries it.
 */
function rosterFrom(zone, dir) {
  return asServer(zone, () => onWorkspace(dir, () => JSON.parse(JSON.stringify(rosterMessage()))));
}

/** Run `fn` with this process's Intl answering `options` for the default zone. */
function withIntlAnswering(options, fn) {
  const real = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function () { return { resolvedOptions: () => options }; };
  try { return fn(); } finally { Intl.DateTimeFormat = real; }
}

describe('the server says which zone it reads a schedule in', () => {
  test('a roster carries the zone the server process is in', () => {
    const dir = workspace();
    assert.strictEqual(rosterFrom('Europe/London', dir).zone, 'Europe/London');
    assert.strictEqual(rosterFrom('America/New_York', dir).zone, 'America/New_York');
  });

  // Read when the roster is built, never once at start: a server whose zone
  // moves under it reports the move in the next roster it sends.
  test('the zone is read each time a roster is built, not kept from the first', () => {
    const dir = workspace();
    const seen = ['Europe/London', 'America/New_York', 'Europe/London'].map(zone => rosterFrom(zone, dir).zone);
    assert.deepStrictEqual(seen, ['Europe/London', 'America/New_York', 'Europe/London']);
  });
});

describe('a server that reports no zone', () => {
  // The path failing: the runtime gives no zone. The server says nothing
  // rather than guess, and ICU's own word for not knowing counts as nothing.
  test('a runtime with no zone, or one that does not know it, reports none', () => {
    const dir = workspace();
    assert.strictEqual(withIntlAnswering({}, () => rosterFrom('Europe/London', dir)).zone, null);
    assert.strictEqual(withIntlAnswering({ timeZone: 'Etc/Unknown' }, () => rosterFrom('Europe/London', dir)).zone, null);
  });
});

describe('the reported zone is for showing, and is stored nowhere', () => {
  // The scheduler's two stores are what the tick decides with. A zone written
  // into either is a second input beside the last run, which is the defect the
  // stores are kept apart to prevent. So the same pass is run twice, once with
  // the server reporting its zone and once with it reporting none, and both
  // files must come out byte for byte the same.
  test('a pass with and without the field leaves both scheduler files byte-identical', (t) => {
    function pass(reports) {
      const dir = workspace();
      const run = () => asServer('Europe/London', () => onWorkspace(dir, () => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        try {
          sched.startScheduler();
          t.mock.timers.tick(60_000);
        } finally {
          sched.stopScheduler();
          t.mock.timers.reset();
        }
        const zone = rosterMessage().zone;
        sched.saveRoutineState();
        sched.saveRoutineSlots();
        return {
          zone,
          state: fs.readFileSync(path.join(dir, '.rundock', 'routine-state.json')),
          slots: fs.readFileSync(path.join(dir, '.rundock', 'routine-slots.json')),
        };
      }));
      return reports ? run() : withIntlAnswering({}, run);
    }
    const withField = pass(true);
    const without = pass(false);
    assert.strictEqual(withField.zone, 'Europe/London', 'sanity: the first pass reported a zone');
    assert.strictEqual(without.zone, null, 'sanity: the second reported none');
    assert.ok(withField.slots.includes('Morning briefing'), 'sanity: the tick wrote the routine\'s slot');
    assert.ok(withField.state.equals(without.state), 'routine-state.json differs with the zone reported');
    assert.ok(withField.slots.equals(without.slots), 'routine-slots.json differs with the zone reported');
    for (const file of [withField.state, withField.slots]) {
      assert.ok(!file.includes('London'), 'the reported zone reached a scheduler file');
    }
  });
});
