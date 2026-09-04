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

  // AC-3's lost-record clause, in the ordinary single-routine file. Once the
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

  test('an added connector round-trips through the same file the runtime reads', () => {
    const merged = settings.connectorsMerge(MCP, 'calendar', { url: 'https://mcp.example.com/cal' });
    assert.strictEqual(merged.reason, null);

    // Written to a real workspace .mcp.json and read back through the
    // runtime's own config resolver, which is the honest meaning of "the
    // same file the runtime reads": not a parse of what the tab sent, but
    // what a spawn would actually be handed.
    const dir = makeWorkspace({ agents: {} });
    fs.writeFileSync(path.join(dir, '.mcp.json'), merged.next);
    const { resolveMcpConfigPath } = require('../../lib/workspace/mcp-secrets.js');
    const resolved = resolveMcpConfigPath(dir);
    const runtimeSees = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    assert.ok(runtimeSees.mcpServers.calendar, 'the runtime sees the added connector');
    assert.ok(runtimeSees.mcpServers.notion, 'beside everything that was already there');

    // And the same bytes read back through the tab's own parse: one file,
    // both readers, no drift.
    const reread = settings.connectorsParse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf-8'));
    assert.deepStrictEqual(reread.servers.map(srv => srv.name).sort(), ['calendar', 'granola', 'notion']);
  });

  test('after a read that failed, connectorsAdd writes nothing', () => {
    // The refuse guard lives in connectorsAdd, which reads the page and the
    // socket, so it is driven in a real DOM. A failed read (non-ok response)
    // must leave the module unable to build a save: any save_file here would
    // be built from bytes we never saw and would drop the real file's servers.
    const SETTINGS_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'views', 'settings.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>'
      + '<div class="settings-nav"><div class="settings-nav-item active" data-settings="connectors"></div></div>'
      + '<div id="settings-content"></div>'
      + '<input id="connector-name" value="calendar"><input id="connector-target" value="https://mcp.example.com">'
      + '<div id="connector-add-note"></div>'
      + '</body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    const sent = [];
    w.ws = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
    w.WebSocket = { OPEN: 1 };
    // The read that does not succeed: a non-ok response, which connectorsLoad
    // must record as read-failed rather than as an empty workspace.
    w.fetch = () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') });
    w.eval(SETTINGS_SRC);

    return w.connectorsLoad().then(() => {
      // The state connectorsLoad ACTUALLY produced is what rendered, not an
      // object the test built: the error sentence is on the page, the
      // reassuring empty state is not, and no Add form is drawn.
      const page = w.document.getElementById('settings-content').innerHTML;
      assert.match(page, /Could not read \.mcp\.json/i, 'the failed read renders its error');
      assert.doesNotMatch(page, /No connectors configured/, 'never the empty state over a file it could not read');
      assert.doesNotMatch(page, /connector-name|Add to \.mcp\.json/, 'and no Add form built from bytes it never saw');

      w.connectorsAdd();
      assert.deepStrictEqual(sent, [], 'nothing was saved from a file that was never read');
      assert.match(w.document.getElementById('connector-add-note').textContent, /could not be read/i,
        'and the reader is told why, rather than silently overwriting');
      dom.window.close();
    });
  });

  test('the merge refuses to replace a connector somebody configured', () => {
    const merged = settings.connectorsMerge(MCP, 'notion', { url: 'https://elsewhere' });
    assert.strictEqual(merged.next, null);
    assert.match(merged.reason, /already exists/);
    const bad = settings.connectorsMerge(MCP, 'has spaces', { url: 'https://x' });
    assert.strictEqual(bad.next, null, 'and a name the file format would mangle is refused, not written');
  });
});
