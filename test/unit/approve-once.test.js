'use strict';
// A plan is approved once, and never again unless the routine changes; and
// the connectors tab edits the file the runtime reads.
//
// The approval walks read the hash's own inputs rather than a copy of them:
// the exported field list drives which edits invalidate, so a field joining
// or leaving the hash moves these tests with it or reddens them.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const {
  PLAN_FIELDS, computePlanHash, planApproved, APPROVAL_PENDING, stampPendingApprovals,
  markApprovalFeatureRan,
  normalizeRoutine, parseRoutineBlocks, updateRoutineBlock, appendRoutineBlock,
  migrateAgentRoutines, readRoutineBlock,
} = require('../../lib/agents/routines.js');
const scheduler = require('../../lib/scheduler.js');
const settings = require('../../public/views/settings.js');
const { agentFile, makeWorkspace, cleanup } = require('../helpers/workspace.js');
const { after } = require('node:test');

after(cleanup);

const RUNNABLE = { name: 'digest', schedule: 'every day at 07:00', prompt: 'go', runOn: 'local', enabled: true };
const approve = (routine) => ({ ...routine, planApprovedHash: computePlanHash(routine) });

describe('what approval covers is read from the hash inputs, not restated', () => {
  // The exported field list is the single source. Which edits invalidate an
  // approval is derived from it here, so the claim "an edited skill
  // invalidates approval; an edited schedule does not" is proven against the
  // hash's own inputs in both directions.
  test('every plan field invalidates an approval when edited, and only plan fields do', () => {
    const base = approve({ ...RUNNABLE, skill: 'ops-summary' });
    assert.strictEqual(planApproved(base), true, 'sanity: the fixture is approved');

    for (const field of PLAN_FIELDS) {
      const edited = { ...base, [field]: 'changed-' + String(base[field] || '') };
      assert.strictEqual(planApproved(edited), false,
        `editing "${field}" changes what the routine does, so the standing approval must lapse`);
    }

    // The other side: fields the hash deliberately excludes. Changing WHEN a
    // routine runs, or whether it is running at all, is not a new plan.
    for (const [field, value] of Object.entries({
      schedule: 'every weekday at 09:30', timezone: 'Australia/Sydney',
      enabled: false, paused: true, name: 'renamed',
    })) {
      assert.ok(!PLAN_FIELDS.includes(field),
        `sanity: "${field}" is not a plan field, or this test's premise moved`);
      const edited = { ...base, [field]: value };
      assert.strictEqual(planApproved(edited), true,
        `editing "${field}" changes when or whether, not what, so approval survives`);
    }
  });

  // The card's own named pair, pinned by name rather than through the field
  // list. The walk above reads PLAN_FIELDS, so a field quietly dropped from
  // the hash would drop out of the walk with it; these two lines cannot
  // follow the list anywhere, which is what makes the walk honest.
  test('an edited skill invalidates approval; an edited schedule does not', () => {
    const base = approve({ ...RUNNABLE, skill: 'ops-summary' });
    assert.strictEqual(planApproved({ ...base, skill: 'different-skill' }), false,
      'running a different skill is a different plan, whatever the hash inputs currently say');
    assert.strictEqual(planApproved({ ...base, schedule: 'every weekday at 09:30' }), true,
      'moving a routine is the same plan, whatever the hash inputs currently say');
  });

  test('absence is never-approved, and so is the written pending word', () => {
    assert.strictEqual(planApproved({ ...RUNNABLE }), false, 'no record means nobody approved');
    assert.strictEqual(planApproved({ ...RUNNABLE, planApprovedHash: APPROVAL_PENDING }), false,
      'the sentinel a file uses to say "awaiting approval" can never read as approval');
    assert.strictEqual(planApproved(null), false, 'nothing is not approved either');
  });

  // The stored planHash stamp is a record, not the judge: a hand edit that
  // leaves the stamp stale must still lapse the approval, because the
  // comparison recomputes from the live fields.
  test('a hand-edited plan lapses approval even when the stamped hash went stale', () => {
    const base = approve(RUNNABLE);
    const handEdited = { ...base, prompt: 'do something else', planHash: base.planApprovedHash };
    assert.strictEqual(planApproved(handEdited), false,
      'the live fields decide, so a stale stamp cannot carry an approval the person never gave');
  });
});

describe('the scheduler refuses an unapproved plan, visibly', () => {
  test('an unapproved routine is refused with its own word, and approval clears it', () => {
    assert.strictEqual(scheduler.routineRefusal({ ...RUNNABLE }), 'approval',
    'an unapproved plan does not run unattended, and the refusal names why');
    assert.strictEqual(scheduler.routineRefusal(approve(RUNNABLE)), null,
      'the one tap is the whole of what was missing');
  });

  test('the switch never shadows the approval, and the approval never shadows a deeper fault', () => {
    assert.strictEqual(scheduler.routineRefusal({ ...RUNNABLE, enabled: false }), 'approval',
      'off AND unapproved reports the approval, so turning it on surfaces the tap instead of a silent stop');
    assert.strictEqual(scheduler.routineRefusal({ ...RUNNABLE, prompt: '' }), 'prompt',
      'a routine with nothing to run has a deeper fault than its missing approval');
  });

  // The row's model consumes the published word: the offer to turn on is
  // withheld while approval is the real blocker, and the approval line is
  // shown with the plan named.
  test('the row shows the plan and the one tap, and only for the approval word', () => {
    const m = require('../../public/routines-model.js');
    const offer = m.approvalOffer({ refusal: 'approval', skill: 'ops-summary', prompt: 'go' });
    assert.ok(offer, 'an unapproved routine gets the approval line');
    assert.match(offer.text, /ops-summary/, 'the sentence names the plan being consented to');
    assert.match(offer.text, /unattended/, 'and says what approving allows');
    assert.strictEqual(m.approvalOffer({ refusal: 'enabled' }), null, 'any other refusal draws no approval line');
    assert.strictEqual(m.approvalOffer({}), null, 'a roster without the field draws none, because a server that predates the feature has nothing unapproved');
    assert.strictEqual(m.somethingElseStopsIt({ schedule: 'every day at 07:00', scheduleReadable: true, prompt: 'go', refusal: 'approval' }), true,
      'and the Turn on offer is withheld while approval is what actually stands in the way');
  });
});

describe('approval persists in the file, which is what a restart reads', () => {
  test('an approval written to the agent file survives a fresh parse, and an edit lapses it', () => {
    let content = agentFile({
      name: 'piper', displayName: 'Piper', type: 'specialist', order: 1,
      routines: [{ name: 'digest', schedule: 'every day at 07:00', prompt: 'go', enabled: true }],
    });
    // The server-side approval: computed from the block as it stands, then
    // written beside it with the moment it happened.
    const block = readRoutineBlock(content, 'digest', 0);
    const hash = computePlanHash(normalizeRoutine(block));
    content = updateRoutineBlock(content, 'digest', {
      planApprovedHash: hash, planApprovedAt: new Date().toISOString(),
    }, 0);

    // "Across a restart" is a fresh read of the same bytes: the file is the
    // store, and nothing in memory is allowed to matter.
    const rereadBlock = readRoutineBlock(content, 'digest', 0);
    const reread = normalizeRoutine(rereadBlock);
    assert.strictEqual(planApproved(reread), true, 'the approval is in the bytes, so a restart still has it');
    assert.strictEqual(scheduler.routineRefusal(reread), null, 'and the tick runs it without asking again');

    // Then the plan changes, and the standing approval lapses by mismatch,
    // with nothing having to remember to revoke anything.
    const edited = updateRoutineBlock(content, 'digest', { prompt: 'do something else' }, 0);
    const editedRoutine = normalizeRoutine(readRoutineBlock(edited, 'digest', 0));
    assert.strictEqual(planApproved(editedRoutine), false, 'an edited plan is a new question');
    assert.strictEqual(scheduler.routineRefusal(editedRoutine), 'approval', 'and the tick asks it');
  });

  test('a newly created routine arrives pending, in as many words', () => {
    const base = agentFile({ name: 'piper', displayName: 'Piper', type: 'specialist', order: 1, routines: [] });
    const next = appendRoutineBlock(base, { name: 'fresh', schedule: 'every day at 07:00', prompt: 'go' });
    const routine = normalizeRoutine(readRoutineBlock(next, 'fresh', 0));
    assert.strictEqual(routine.planApprovedHash, APPROVAL_PENDING,
      'the file says the plan awaits approval rather than leaving it to be inferred from absence');
    assert.strictEqual(planApproved(routine), false);
    assert.strictEqual(scheduler.routineRefusal(routine), 'approval', 'so the first run meets the approval step');
  });
});

describe('the grandfather line: an upgrade never stops work you already run', () => {
  test('migration approves every pre-existing routine as it stands, switched on or not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-migrate-'));
    const agentDir = path.join(dir, '.claude', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    // The real <workspace>/.claude/agents/<name>.md layout, so the feature
    // marker resolves inside this test's own workspace and cannot be reached
    // by a sibling temp dir climbing to a shared ancestor.
    const file = path.join(agentDir, 'piper.md');
    // A pre-approval-era file: routines with none of the migrated keys, one
    // running today and one switched off.
    fs.writeFileSync(file, [
      '---', 'name: piper', 'displayName: Piper', 'type: specialist', 'order: 1',
      'routines:',
      '  - name: running', '    schedule: every day at 07:00', '    prompt: go', '    enabled: true',
      '  - name: dormant', '    schedule: every day at 07:00', '    prompt: go', '    enabled: false',
      '---', '',
    ].join('\n'));
    try {
      const migrated = migrateAgentRoutines(file, fs.readFileSync(file, 'utf-8'));
      const running = normalizeRoutine(readRoutineBlock(migrated, 'running', 0));
      const dormant = normalizeRoutine(readRoutineBlock(migrated, 'dormant', 0));
      assert.strictEqual(planApproved(running), true,
        'a routine already running carries its consent over: stopping it to ask again would be the upgrade halting work you asked for');
      assert.ok(running.planApprovedAt == null,
        'and no approval moment is invented for it, because there is no such moment to record');
      assert.strictEqual(planApproved(dormant), true,
        'a dormant routine is neither new nor edited: the approval step is for plans made or changed '
        + 'after the feature, and an upgrade must not re-question files it did not write');
      assert.strictEqual(require('../../lib/scheduler.js').routineRefusal(dormant), 'enabled',
        'so the only thing between it and a run is the switch, exactly as before the upgrade');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The discriminator both ways: the file tells a pre-feature plan from a
  // later one. A key-less block in a file whose siblings carry the key is a
  // later addition, or a record that was lost, and either way meets the step.
  test('a key-less block beside an approved sibling is pending, not grandfathered', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-mixed-'));
    const agentDir = path.join(dir, '.claude', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    // The real <workspace>/.claude/agents/<name>.md layout, so the feature
    // marker resolves inside this test's own workspace and cannot be reached
    // by a sibling temp dir climbing to a shared ancestor.
    const file = path.join(agentDir, 'piper.md');
    fs.writeFileSync(file, [
      '---', 'name: piper', 'type: specialist', 'order: 1', 'routines:',
      '  - name: established', '    schedule: every day at 07:00', '    prompt: go',
      '    enabled: true', '    planApprovedHash: ' + computePlanHash(normalizeRoutine({ prompt: 'go', runOn: 'local' })),
      '  - name: newcomer', '    schedule: every day at 07:00', '    prompt: go', '    enabled: true',
      '---', '',
    ].join('\n'));
    try {
      const migrated = migrateAgentRoutines(file, fs.readFileSync(file, 'utf-8'));
      const newcomer = normalizeRoutine(readRoutineBlock(migrated, 'newcomer', 0));
      assert.strictEqual(planApproved(newcomer), false,
        'a key-less block in a feature-aware file is a later addition or a lost record: it meets the step');
      assert.strictEqual(require('../../lib/scheduler.js').routineRefusal(newcomer), 'approval');
      const established = normalizeRoutine(readRoutineBlock(migrated, 'established', 0));
      assert.strictEqual(planApproved(established), true, 'and the sibling whose record stands keeps it');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // the lost-record rule, in the ordinary single-routine file. Once the
  // approval feature has demonstrably run in a workspace, a routine whose
  // record is hand-stripped is a plan awaiting a fresh tap, never re-approved
  // by absence, even though it is the only routine and has no sibling to
  // borrow the signal from.
  test('a single routine whose approval record is stripped after the feature ran is refused, not re-approved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-lost-'));
    const agentDir = path.join(dir, '.claude', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    const file = path.join(agentDir, 'piper.md');
    try {
      // The workspace has been through the feature: its durable marker is set.
      markApprovalFeatureRan(dir);
      // A single-routine file whose only approval record has been removed by
      // a hand edit of the frontmatter.
      fs.writeFileSync(file, [
        '---', 'name: piper', 'type: specialist', 'order: 1', 'routines:',
        '  - name: solo', '    schedule: every day at 07:00', '    prompt: an edited plan',
        '    enabled: true', '    planHash: ' + computePlanHash(normalizeRoutine({ prompt: 'an edited plan', runOn: 'local' })),
        '---', '',
      ].join('\n'));
      const migrated = migrateAgentRoutines(file, fs.readFileSync(file, 'utf-8'));
      const solo = normalizeRoutine(readRoutineBlock(migrated, 'solo', 0));
      assert.strictEqual(planApproved(solo), false,
        'absence of the record in a workspace the feature has touched is never-approved, not approved');
      assert.strictEqual(scheduler.routineRefusal(solo), 'approval', 'so the tick asks for a fresh tap');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The save-agent bound: a whole agent file written verbatim, carrying
  // key-less routine blocks, is stamped pending by the writer rather than
  // grandfathered by the migration. A block that already carries a record is
  // left as it stands, so saving an edited agent never lapses an approval.
  test('stampPendingApprovals marks new routine blocks and leaves standing ones alone', () => {
    const approvedHash = computePlanHash(normalizeRoutine({ prompt: 'keep', runOn: 'local' }));
    const content = [
      '---', 'name: piper', 'type: specialist', 'routines:',
      '  - name: brought-in', '    schedule: every day at 07:00', '    prompt: go', '    enabled: true',
      '  - name: standing', '    schedule: every day at 07:00', '    prompt: keep',
      '    enabled: true', '    planApprovedHash: ' + approvedHash,
      '---', '',
    ].join('\n');
    const stamped = stampPendingApprovals(content);
    assert.strictEqual(normalizeRoutine(readRoutineBlock(stamped, 'brought-in', 0)).planApprovedHash, APPROVAL_PENDING,
      'a routine block arriving with no record is stamped pending, so it meets the tap');
    assert.strictEqual(normalizeRoutine(readRoutineBlock(stamped, 'standing', 0)).planApprovedHash, approvedHash,
      'and a block whose record stands is untouched, so an edited agent keeps its approvals');
  });
});

describe('the approve message, driven through the real dispatch', () => {
  const config = require('../../lib/config.js');
  const { invalidateAgentCache, discoverAgents } = require('../../lib/agents/discovery.js');
  const { buildDispatch } = require('../../lib/protocol/handlers/index.js');

  function fixture() {
    const dir = makeWorkspace({
      agents: {
        piper: agentFile({
          name: 'piper', displayName: 'Piper', type: 'specialist', order: 1,
          routines: [{ name: 'digest', schedule: 'every day at 07:00', prompt: 'go', enabled: true }],
        }),
      },
    });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    invalidateAgentCache();
    discoverAgents();
    const sent = [];
    const ctx = {
      agents: { invalidateAgentCache: () => invalidateAgentCache(), discoverSkills: () => [], flagRosterRefresh: () => {} },
      workspace: { isInsideWorkspace: (p) => p.startsWith(dir) },
      broadcast: () => {},
    };
    const ws = { send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
    const file = path.join(dir, '.claude', 'agents', 'piper.md');
    return {
      dir, ctx, ws, sent, file,
      approve: (msg) => buildDispatch().approve_routine_plan(ctx, ws,
        { type: 'approve_routine_plan', agentId: 'piper', name: 'digest', occurrence: 0, ...msg }),
      restore: () => { config.setWorkspace(original); invalidateAgentCache(); },
    };
  }

  test('the tap lands in the file, hashed from what is on disk, and is announced', () => {
    const f = fixture();
    try {
      // The file was edited after the page was drawn; the approval must cover
      // the plan as it stands NOW, which is the whole reason the client sends
      // no hash of its own.
      let content = fs.readFileSync(f.file, 'utf-8');
      content = updateRoutineBlock(content, 'digest', { prompt: 'the newer plan' }, 0);
      fs.writeFileSync(f.file, content);
      invalidateAgentCache();
      discoverAgents();

      f.approve({});
      const routine = normalizeRoutine(readRoutineBlock(fs.readFileSync(f.file, 'utf-8'), 'digest', 0));
      assert.strictEqual(routine.prompt, 'the newer plan');
      assert.strictEqual(planApproved(routine), true, 'the approval covers the plan on disk at the tap');
      assert.ok(routine.planApprovedAt, 'and records when the person tapped');
      assert.ok(f.sent.some(m => m.type === 'routine_plan_approved'), 'and the change is announced');
    } finally { f.restore(); }
  });

  test('a routine the roster knows but the file no longer carries is refused, not invented', () => {
    const f = fixture();
    try {
      f.approve({ name: 'never-written' });
      const refusal = f.sent.find(m => m.type === 'routine_action_error');
      assert.ok(refusal, 'the refusal goes to the routines list');
      assert.match(refusal.message, /could not be approved/);
    } finally { f.restore(); }
  });

  test('an agent nobody has is refused on the locate road', () => {
    const f = fixture();
    try {
      const before = fs.readFileSync(f.file, 'utf-8');
      f.approve({ agentId: 'nobody' });
      const refusal = f.sent.find(m => m.type === 'routine_action_error');
      assert.ok(refusal && /not found/.test(refusal.message));
      assert.strictEqual(fs.readFileSync(f.file, 'utf-8'), before,
        'and no file changed on the way to the refusal');
    } finally { f.restore(); }
  });

  test('a file whose frontmatter cannot be addressed refuses rather than claiming approval', () => {
    const f = fixture();
    try {
      // The Windows-line-endings shape: the writer returns the content
      // unchanged because the frontmatter regex cannot address it, and the
      // read-back guard must turn that silence into a refusal instead of an
      // announcement about a write that never happened.
      fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf-8').replace(/\n/g, '\r\n'));
      f.approve({});
      const refusal = f.sent.find(m => m.type === 'routine_action_error');
      assert.ok(refusal && /could not be approved/.test(refusal.message),
        'the guard read back what landed, found nothing, and said so');
      assert.ok(!f.sent.some(m => m.type === 'routine_plan_approved'), 'and no approval was announced');
    } finally { f.restore(); }
  });
});

describe('a routine reaching a file through save_agent meets the step, not the grandfather', () => {
  const config = require('../../lib/config.js');
  const { invalidateAgentCache, discoverAgents } = require('../../lib/agents/discovery.js');
  const { buildDispatch } = require('../../lib/protocol/handlers/index.js');

  function saveAgentFixture() {
    const dir = makeWorkspace({ agents: {} });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    invalidateAgentCache();
    const sent = [];
    const ctx = {
      agents: {
        validateAgentSlug: () => true, invalidateAgentCache: () => invalidateAgentCache(),
        discoverSkills: () => [], flagRosterRefresh: () => {}, maybeCompleteSetup: () => {},
      },
      workspace: { isInsideWorkspace: (pth) => pth.startsWith(dir) },
    };
    const ws = { send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
    const file = path.join(dir, '.claude', 'agents', 'piper.md');
    return {
      dir, sent, file,
      save: (content) => buildDispatch().save_agent(ctx, ws, { type: 'save_agent', name: 'piper', content }),
      restore: () => { config.setWorkspace(original); invalidateAgentCache(); },
    };
  }

  test('a whole agent file written with a key-less routine block lands pending, and does not run unattended', () => {
    const f = saveAgentFixture();
    try {
      // The RUNDOCK:SAVE_AGENT shape: a whole agent file, verbatim, carrying a
      // routine the approval step has never seen.
      f.save([
        '---', 'name: piper', 'displayName: Piper', 'type: specialist', 'order: 1', 'routines:',
        '  - name: brought-in', '    schedule: every day at 07:00', '    prompt: go', '    enabled: true',
        '---', '',
      ].join('\n'));
      assert.ok(f.sent.some(m => m.type === 'agent_saved'), 'the agent saved');
      const routine = normalizeRoutine(readRoutineBlock(fs.readFileSync(f.file, 'utf-8'), 'brought-in', 0));
      assert.strictEqual(routine.planApprovedHash, APPROVAL_PENDING,
        'the writer stamped the plan pending, so it is not grandfathered into running');
      assert.strictEqual(scheduler.routineRefusal(routine), 'approval', 'and the tick asks for the tap');
    } finally { f.restore(); }
  });

  test('saving an agent whose routine already carries an approval keeps it', () => {
    const f = saveAgentFixture();
    try {
      const approvedHash = computePlanHash(normalizeRoutine({ prompt: 'go', runOn: 'local' }));
      f.save([
        '---', 'name: piper', 'displayName: Piper', 'type: specialist', 'order: 1', 'routines:',
        '  - name: standing', '    schedule: every day at 07:00', '    prompt: go',
        '    enabled: true', '    planApprovedHash: ' + approvedHash,
        '---', '',
      ].join('\n'));
      const routine = normalizeRoutine(readRoutineBlock(fs.readFileSync(f.file, 'utf-8'), 'standing', 0));
      assert.strictEqual(planApproved(routine), true,
        'an edited agent whose routine keeps its record keeps its approval: the save does not lapse it');
    } finally { f.restore(); }
  });
});

describe('the connectors tab edits the file the runtime reads', () => {
  const MCP = JSON.stringify({
    mcpServers: {
      notion: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: 'x' } },
      granola: { url: 'https://mcp.granola.ai/mcp' },
    },
  }, null, 2);

  test('rows state what each connector can reach, and name credential keys without values', () => {
    const state = settings.connectorsParse(MCP);
    assert.strictEqual(state.servers.length, 2);
    const byName = Object.fromEntries(state.servers.map(srv => [srv.name, srv]));
    assert.strictEqual(byName.notion.transport, 'command');
    assert.match(byName.notion.target, /npx -y @notionhq\/notion-mcp-server/);
    assert.deepStrictEqual(byName.notion.envKeys, ['NOTION_TOKEN'], 'keys are named');
    assert.strictEqual(byName.granola.transport, 'url');
    const html = settings.connectorsSectionHtml(state);
    assert.doesNotMatch(html, /NOTION_TOKEN.*x|"x"/, 'and values never reach the page');
    assert.match(html, /NOTION_TOKEN/, 'while the key itself is stated');
    assert.match(html, /travels with this folder/, 'scope is a meaning, not a badge');
  });

  test('a missing file is an offer and a broken file is an error, never each other', () => {
    const missing = settings.connectorsParse(null);
    assert.strictEqual(missing.missing, true);
    assert.match(settings.connectorsSectionHtml(missing), /No connectors configured/);
    const broken = settings.connectorsParse('{ not json');
    assert.ok(broken.error, 'a config that cannot be read is a fault to report');
    assert.match(settings.connectorsSectionHtml(broken), /could not be read/,
      'and it is never rendered as an empty state a person would trust');
  });

  // A SENTENCE RENDERED IN THE VALUE STYLE IS A SENTENCE THE READER LOSES.
  // That style clips to one line with an ellipsis, which is right for a
  // command or a URL and silently eats the second half of a paragraph. It ate
  // the empty state's explanation, and it ate the line of feedback the add
  // button writes, which is why the button was reported as doing nothing: it
  // worked, and its answer was clipped to invisibility. Pinned by counting,
  // because the failure is silent in a browser and looks like clean markup
  // in a diff.
  test('the sentences render in the prose style, and only real values keep the clipping one', () => {
    const rendered = [
      settings.connectorsSectionHtml(settings.connectorsParse(null)),
      settings.connectorsSectionHtml(settings.connectorsParse('{ not json')),
      settings.connectorsSectionHtml(settings.connectorsParse(MCP)),
    ].join('\n');
    for (const sentence of [
      'No connectors configured',
      'Workspace connectors live in',
      'Connectors are read from',
      'could not be read',
    ]) {
      const at = rendered.indexOf(sentence);
      assert.ok(at !== -1, `the rendered markup carries "${sentence}"`);
      const opensAt = rendered.lastIndexOf('<', at);
      assert.ok(rendered.slice(opensAt, at).includes('settings-prose'),
        `"${sentence}" is a sentence, so it wraps rather than being clipped to one line`);
    }
    assert.match(rendered, /class="settings-value" title=/,
      'a command or URL keeps the clipping style, with its full text still reachable by title');
  });

  // The three tests that stood here drove the two-field add form: a merge
  // round-trip, the refusal to write after a failed read, and the refusal to
  // replace a connector somebody configured. The form is gone, and with it
  // connectorsAdd and connectorsMerge, because a name and one free-text field
  // cannot express what a connector actually needs to start (a command's
  // arguments, an HTTP server's auth, credentials either way), so its ordinary
  // outcome was an entry that looked accepted and could never run. Adding is
  // now a conversation with the guide, the same route Files, Skills and the
  // routine editor already take. Nothing asserts on the removed path because
  // there is no longer a path: the guide writes through the ordinary file
  // tools, and the guarantees that belong to THAT write are the subject of the
  // follow-up that gives it a verification step.

  test('a workspace whose connector file could not be read shows why, never the empty state', () => {
    // The two are opposite claims about the same workspace: "there are none"
    // and "we could not find out". Drawing the first when the second is true
    // tells somebody their connectors are gone. This guard used to be proven
    // by the add form's refuse-after-failed-read test; the form has gone and
    // the distinction has not, so it is asserted directly here.
    const failed = settings.connectorsSectionHtml({
      servers: [], missing: false, readFailed: true,
      error: 'Could not read .mcp.json, so its connectors are not shown. Reopen this tab to retry.',
    });
    assert.match(failed, /Could not read \.mcp\.json/, 'the reason the panel is empty is on the panel');
    assert.doesNotMatch(failed, /No connectors configured/,
      'a file that could not be read is not a workspace with no connectors');
    // AND NOTHING ELSE. Both the ordinary error branch and this one print the
    // reason, so printing it proves little; what this state alone withholds is
    // the rest of the panel. Inviting a change to a file whose contents are
    // unknown, or describing a connector landscape this read never
    // established, is the failure the early return exists to prevent.
    // The stub is installed here on purpose. Without it the affordance is
    // omitted because no guide resolves, and the assertion would pass with the
    // read-failed early return deleted, proving nothing about the branch its
    // message names.
    global.getGuide = () => ({ id: 'agent-doc-1', type: 'platform', name: 'rundock-guide', displayName: 'Doc' });
    try {
      const withGuide = settings.connectorsSectionHtml({
        servers: [], missing: false, readFailed: true,
        error: 'Could not read .mcp.json, so its connectors are not shown. Reopen this tab to retry.',
      });
      assert.doesNotMatch(withGuide, /Talk to Doc/,
        'a read that failed does not invite an add against a file it could not read, even with a guide present');
    } finally {
      delete global.getGuide;
    }
    assert.doesNotMatch(failed, /Account connectors are added at claude\.ai/,
      'nor does it describe the wider connector picture it never established');
    assert.doesNotMatch(failed, /Connectors are read from/);
  });

  test('the guide accessor the add affordance calls is the one the running client declares, returning an object with an id', () => {
    // THE DOUBLE IS COMPARED AGAINST THE REAL CONTRACT. The affordance calls a
    // bare global `getGuide()` and interpolates `.id`. Every test here supplies
    // that itself, so renaming the accessor, moving it out of reach as a bare
    // global, or returning a shape without `id` would leave the button
    // silently absent (or carrying `data-agent-id="undefined"`) with the whole
    // suite still green. This reads the client's own declaration instead.
    const appSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');
    assert.match(appSrc, /^function getGuide\s*\(/m,
      'getGuide is declared as a bare function in the client, reachable as a global from the settings module');

    // And it returns something carrying the property the markup interpolates.
    const body = /^function getGuide\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*$/m.exec(appSrc);
    assert.ok(body, 'the declaration is readable, or this proves nothing about its result');
    const agents = [{ id: 'agent-doc-1', type: 'platform', name: 'rundock-guide', displayName: 'Doc' }, { id: 'other', type: 'team' }];
    const resolved = new Function('agents', body[1])(agents);
    assert.ok(resolved && typeof resolved.id === 'string' && resolved.id,
      'the guide it resolves carries the id this markup interpolates');
    assert.strictEqual(resolved.id, 'agent-doc-1', 'and it is the platform agent, which is what the guide is');
    assert.ok(typeof resolved.displayName === 'string' && resolved.displayName,
      'and it carries the display name this copy puts in a sentence, rather than only the slug');

    // The no-guide branch is the product's own empty answer, not merely the
    // symbol being absent under node: a workspace with no platform agent.
    assert.strictEqual(new Function('agents', body[1])([{ id: 'x', type: 'team' }]), undefined,
      'a workspace with no platform agent resolves no guide, which is the branch that must draw nothing');
  });

  test('adding a connector is handed to the guide, and the affordance is absent when there is no guide', () => {
    // The three surfaces that already do this (Files, Skills, the routine
    // editor) all guard on the guide existing and render nothing without one,
    // rather than offering a button that opens no conversation. A workspace
    // with no platform agent is the ordinary case for a folder somebody just
    // opened, so the empty branch is the one that must not draw a dead button.
    const withoutGuide = settings.connectorsSectionHtml(settings.connectorsParse(MCP));
    assert.doesNotMatch(withoutGuide, /Talk to Doc/,
      'no guide, no button: a control that opens nothing is worse than no control');

    global.getGuide = () => ({ id: 'agent-doc-1', type: 'platform', name: 'rundock-guide', displayName: 'Doc' });
    try {
      const withGuide = settings.connectorsSectionHtml(settings.connectorsParse(MCP));
      assert.match(withGuide, /Talk to Doc/);
      // The id travels as data, read back by the handler, rather than being
      // interpolated into the handler string where a quote would break it.
      assert.match(withGuide, /data-agent-id="agent-doc-1"[^>]*onclick="startConversation\(this\.dataset\.agentId\)"/,
        'the agent id is passed as data and read back, never spliced into the handler');
      // The form it replaced must be gone from the markup entirely, or both
      // routes are offered and the broken one still wins.
      assert.doesNotMatch(withGuide, /connector-name|connector-target|Add to \.mcp\.json/,
        'the two-field form is gone, not merely hidden beside its replacement');
    } finally {
      delete global.getGuide;
    }
  });

  // ===== FOUR SOURCES: workspace .mcp.json / .codex/config.toml, and
  // user-global ~/.claude.json / ~/.codex/config.toml =====
  //
  // Fixtures below are shaped like the real files this was built against: a
  // workspace .codex/config.toml with `[mcp_servers.<name>]` tables and
  // `env_vars` naming (never valuing) credentials, and a user-global
  // ~/.claude.json whose top-level `mcpServers` is the operator's own reach.

  test('the Codex TOML parser reads sections, command/args/url and credential key names, ignoring what is not a connector', () => {
    const toml = [
      '# Generated by System/Codex/manage_adapters.py. Do not edit.',
      '[[skills.config]]',
      'name = "playwright-trace"',
      'enabled = false',
      '',
      '[mcp_servers.notion]',
      'command = "npx"',
      'args = ["-y", "@notionhq/notion-mcp-server"]',
      'env_vars = ["OPENAPI_MCP_HEADERS"]',
      'enabled = false',
      '',
      '[mcp_servers.mailerlite]',
      'url = "https://mcp.mailerlite.com/mcp"',
      'enabled = true',
      '',
      '[projects."/Users/liam/vault"]',
      'trust_level = "trusted"',
    ].join('\n');
    const parsed = settings.connectorsParseToml(toml);
    assert.strictEqual(parsed.servers.length, 2, 'the skills table and the projects table are not connectors');
    const byName = Object.fromEntries(parsed.servers.map((s) => [s.name, s]));
    assert.strictEqual(byName.notion.transport, 'command');
    assert.match(byName.notion.target, /npx -y @notionhq\/notion-mcp-server/);
    assert.deepStrictEqual(byName.notion.envKeys, ['OPENAPI_MCP_HEADERS'],
      'env_vars names the credential Codex copies in, and is read as a key name, not a value');
    assert.strictEqual(byName.mailerlite.transport, 'url');
    assert.strictEqual(byName.mailerlite.target, 'https://mcp.mailerlite.com/mcp');
  });

  test('a missing Codex config is an offer; a config that reads but names nothing is neither an error', () => {
    const missing = settings.connectorsParseToml(null);
    assert.strictEqual(missing.missing, true);
    assert.strictEqual(missing.error, null);
    const empty = settings.connectorsParseToml('model = "gpt-5"\nmcp_servers = {}\n');
    assert.deepStrictEqual(empty.servers, [], 'an inline empty table names no server, and is not mistaken for one');
    assert.strictEqual(empty.error, null);
  });

  test('~/.claude.json is read the same shape as .mcp.json, but names itself when it is broken', () => {
    const parsed = settings.connectorsParseUserGlobalJson(JSON.stringify({
      mcpServers: { goldfish: { command: '/Applications/Goldfish.app/Contents/MacOS/goldfish-mcp', args: [], type: 'stdio' } },
    }));
    assert.strictEqual(parsed.servers.length, 1);
    assert.strictEqual(parsed.servers[0].name, 'goldfish');
    assert.strictEqual(parsed.servers[0].transport, 'command');
    const broken = settings.connectorsParseUserGlobalJson('{ not json');
    assert.match(broken.error, /~\/\.claude\.json/, 'the broken file names itself, not the unrelated workspace .mcp.json');
  });

  describe('one row per connector name, merged across every source that defines it', () => {
    const claudeWorkspace = settings.connectorsParse(JSON.stringify({
      mcpServers: {
        notion: { command: '/abs/run-with-vault-env.sh', args: ['OPENAPI_MCP_HEADERS', 'node', 'cli.mjs'] },
        getlogos: { command: 'npx', args: ['-y', 'getlogos@0.1.2', '--mcp'] },
      },
    }));
    const codexWorkspace = settings.connectorsParseToml([
      '[mcp_servers.notion]',
      'command = "npx"',
      'args = ["-y", "@notionhq/notion-mcp-server"]',
      'env_vars = ["OPENAPI_MCP_HEADERS"]',
      '',
      '[mcp_servers.mailerlite]',
      'url = "https://mcp.mailerlite.com/mcp"',
    ].join('\n'));
    const claudeUserGlobal = settings.connectorsParseUserGlobalJson(JSON.stringify({
      mcpServers: { goldfish: { command: '/Applications/Goldfish.app/Contents/MacOS/goldfish-mcp', args: [] } },
    }));
    const codexUserGlobal = settings.connectorsParseToml(null);
    const sources = { claudeWorkspace, codexWorkspace, claudeUserGlobal, codexUserGlobal };

    test('four names across four sources produce four rows, each naming every runtime that reaches it', () => {
      const rows = settings.connectorsBuildRows(sources);
      assert.strictEqual(rows.length, 4, 'notion, getlogos, mailerlite, goldfish: one row per name, not one per file');
      const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
      assert.deepStrictEqual(byName.notion.runtimes.slice().sort(), ['claude', 'codex'],
        'notion is defined by both runtimes and reached by both');
      assert.deepStrictEqual(byName.getlogos.runtimes, ['claude'], 'defined only in the workspace Claude Code source');
      assert.deepStrictEqual(byName.mailerlite.runtimes, ['codex']);
      assert.deepStrictEqual(byName.goldfish.scopes, ['user-global'],
        'the user-global connector is scoped to this machine, not the workspace');
    });

    test('a row carries a badge for every runtime that reaches it, and no badge for one that does not', () => {
      const rows = settings.connectorsBuildRows(sources);
      const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
      const notionHtml = settings.connectorsRowHtml(byName.notion);
      assert.match(notionHtml, /Claude Code/, 'notion is reached by Claude Code');
      assert.match(notionHtml, /Codex/, 'and by Codex');
      const goldfishHtml = settings.connectorsRowHtml(byName.goldfish);
      assert.match(goldfishHtml, /Claude Code/);
      assert.doesNotMatch(goldfishHtml, /Codex/, 'no Codex source names goldfish, so it carries no Codex badge');
    });

    test('the tab still shows what it read even when one of the four sources could not be', () => {
      const withOneBroken = settings.connectorsBuildState({
        claudeWorkspace, codexWorkspace, claudeUserGlobal,
        codexUserGlobal: { servers: [], missing: false, error: 'Could not read ~/.codex/config.toml, so your user-global Codex connectors are not shown here.' },
      });
      const html = settings.connectorsSectionHtml(withOneBroken);
      assert.match(html, /Could not read ~\/\.codex\/config\.toml/, 'the broken source is named');
      assert.match(html, /notion/, 'and the sources that DID read still render their rows');
      assert.doesNotMatch(html, /No connectors configured/, 'never dressed as an empty workspace over data three sources actually returned');
    });
  });

  describe('drift: the same name, defined differently by the two runtimes', () => {
    test('a connector whose shape differs between runtimes is flagged, with both definitions shown', () => {
      const claudeWorkspace = settings.connectorsParse(JSON.stringify({
        mcpServers: { notion: { command: '/abs/run-with-vault-env.sh', args: ['OPENAPI_MCP_HEADERS', 'node', 'cli.mjs'] } },
      }));
      const codexWorkspace = settings.connectorsParseToml('[mcp_servers.notion]\ncommand = "npx"\nargs = ["-y", "@notionhq/notion-mcp-server"]\n');
      const empty = { servers: [], missing: true, error: null };
      const rows = settings.connectorsBuildRows({ claudeWorkspace, codexWorkspace, claudeUserGlobal: empty, codexUserGlobal: empty });
      assert.strictEqual(rows.length, 1);
      const [row] = rows;
      assert.ok(row.drift, 'nothing else in the product would ever have said these two disagree');
      assert.strictEqual(row.drift.claude.target, byTarget(claudeWorkspace, 'notion'));
      assert.strictEqual(row.drift.codex.target, byTarget(codexWorkspace, 'notion'));
      const html = settings.connectorsRowHtml(row);
      assert.match(html, /do not agree/i);
      assert.match(html, /run-with-vault-env\.sh/, 'the Claude Code definition is shown');
      assert.match(html, /npx -y @notionhq\/notion-mcp-server/, 'and the Codex definition is shown beside it');
    });

    test('two runtimes that agree on shape draw no drift note', () => {
      const claudeWorkspace = settings.connectorsParse(JSON.stringify({
        mcpServers: { getlogos: { command: 'npx', args: ['-y', 'getlogos@0.1.2', '--mcp'] } },
      }));
      const codexWorkspace = settings.connectorsParseToml('[mcp_servers.getlogos]\ncommand = "npx"\nargs = ["-y", "getlogos@0.1.2", "--mcp"]\n');
      const empty = { servers: [], missing: true, error: null };
      const rows = settings.connectorsBuildRows({ claudeWorkspace, codexWorkspace, claudeUserGlobal: empty, codexUserGlobal: empty });
      assert.strictEqual(rows[0].drift, null);
      assert.doesNotMatch(settings.connectorsRowHtml(rows[0]), /do not agree/i);
    });

    function byTarget(parsed, name) {
      return parsed.servers.find((s) => s.name === name).target;
    }
  });

  // THE NEVER-RENDER-A-VALUE RULE, extended to the source that actually
  // carries live tokens. .mcp.json's credentials are already covered above;
  // ~/.claude.json is the one named explicitly because it can hold OAuth
  // material, not just key names.
  test('a value in ~/.claude.json never reaches the page, only its credential key name', () => {
    const claudeUserGlobal = settings.connectorsParseUserGlobalJson(JSON.stringify({
      mcpServers: { goldfish: { command: 'goldfish-mcp', args: [], env: { GOLDFISH_TOKEN: 'sk-live-do-not-print-this-9f2a' } } },
    }));
    assert.deepStrictEqual(claudeUserGlobal.servers[0].envKeys, ['GOLDFISH_TOKEN']);
    const empty = { servers: [], missing: true, error: null };
    const state = settings.connectorsBuildState({ claudeWorkspace: empty, codexWorkspace: empty, claudeUserGlobal, codexUserGlobal: empty });
    const html = settings.connectorsSectionHtml(state);
    assert.match(html, /GOLDFISH_TOKEN/, 'the key is named');
    assert.doesNotMatch(html, /sk-live-do-not-print-this-9f2a/, 'and its value never reaches the page');
  });

  test('the account tier is named with a real link, and no status is claimed for it', () => {
    const empty = { servers: [], missing: true, error: null };
    const state = settings.connectorsBuildState({ claudeWorkspace: empty, codexWorkspace: empty, claudeUserGlobal: empty, codexUserGlobal: empty });
    const html = settings.connectorsSectionHtml(state);
    assert.match(html,
      /Account connectors are added at claude\.ai and reach every workspace on this machine\. Rundock does not list them here because it cannot read their state honestly\. Manage them at claude\.ai settings \(<a href="https:\/\/claude\.ai\/settings\/connectors"[^>]*>https:\/\/claude\.ai\/settings\/connectors<\/a>\)\./,
      'the exact approved sentence, with the URL as a real link');
  });
});
