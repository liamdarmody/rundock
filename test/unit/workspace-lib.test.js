'use strict';
// Seams introduced by the workspace extraction: lib/workspace/boundary.js,
// lib/workspace/analysis.js, and lib/workspace/scaffold.js own the boundary
// grants, the Seven Signals analysis, and mode detection + scaffolding.
// Contracts, matching the agents extraction:
// 1. IDENTITY: _internal re-exports the modules' own function objects.
// 2. LIVE WORKSPACE: the boundary grants file is resolved from
//    getWorkspace() at use time, so grants always land in and read from the
//    CURRENT workspace.
// 3. NAMED INJECTION: parseSkillFile (root: skill discovery has not moved)
//    into analysis; invalidateAgentCache and rebaselineAgentsWatcher (root:
//    cache cascade + watcher stay there) into scaffold.
// 4. PATHS: the module lives two levels below the repo root, so the
//    scaffold/ sources and the permission-hook script must resolve through
//    the module's root hop, not its own directory.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const boundary = require('../../lib/workspace/boundary.js');
const analysis = require('../../lib/workspace/analysis.js');
const scaffold = require('../../lib/workspace/scaffold.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

describe('lib/workspace module seams', () => {
  test('_internal re-exports the module functions BY IDENTITY', () => {
    for (const name of ['readBoundaryGrants', 'addBoundaryGrant', 'boundaryGrantCovers']) {
      assert.strictEqual(srv[name], boundary[name], `${name} must be the boundary module's own function`);
    }
    for (const name of ['analyzeWorkspace', 'readMcpServerNames']) {
      assert.strictEqual(srv[name], analysis[name], `${name} must be the analysis module's own function`);
    }
    for (const name of ['muteHooks', 'isEmptyWorkspace', 'detectWorkspaceMode', 'scaffoldDefaults', 'scaffoldWorkspace']) {
      assert.strictEqual(srv[name], scaffold[name], `${name} must be the scaffold module's own function`);
    }
  });

  test('boundary grants live in the CURRENT workspace, resolved at use time', () => {
    const dirA = makeWorkspace({});
    const dirB = makeWorkspace({});
    const outside = makeWorkspace({}); // any dir outside both workspaces
    srv.setWorkspace(dirA);
    boundary.addBoundaryGrant(outside);
    assert.ok(fs.existsSync(path.join(dirA, '.rundock', 'permissions.json')),
      'the grant persists inside workspace A');
    assert.strictEqual(boundary.boundaryGrantCovers(path.join(outside, 'sub', 'file.md')), true,
      'a grant covers its subtree');
    srv.setWorkspace(dirB);
    assert.strictEqual(boundary.boundaryGrantCovers(path.join(outside, 'sub', 'file.md')), false,
      'workspace B has no grants: the read followed the switch');
    assert.deepStrictEqual(boundary.readBoundaryGrants(), [], 'grants never leak across workspaces');
  });

  test('a grant that cannot persist warns and leaves state unchanged', () => {
    // .rundock exists as a FILE, so creating the permissions path fails; the
    // grant writer must swallow the error (a broken workspace never crashes
    // the permission flow) and grant nothing.
    const dir = makeWorkspace({});
    fs.writeFileSync(path.join(dir, '.rundock'), 'not a directory');
    srv.setWorkspace(dir);
    boundary.addBoundaryGrant(path.join(dir, 'somewhere'));
    assert.deepStrictEqual(boundary.readBoundaryGrants(), [], 'no grant was recorded');
    assert.strictEqual(boundary.boundaryGrantCovers(path.join(dir, 'somewhere')), false);
  });

  test('analysis reads skill files through the injected parseSkillFile', () => {
    const dir = makeWorkspace({ skills: { 'my-skill': '---\nname: My Skill\n---\nreal body' } });
    const prev = analysis.wireAnalysisDeps({
      parseSkillFile: (content, slug) => ({ displayName: `FAKE-${slug}`, description: 'injected' }),
    });
    try {
      const result = analysis.analyzeWorkspace(dir, []);
      const skill = result.skills.list.find(s => s.id === 'my-skill');
      assert.ok(skill, 'the skill directory was scanned');
      assert.strictEqual(skill.name, 'FAKE-my-skill', 'the injected parser produced the display name');
      assert.strictEqual(skill.description, 'injected');
    } finally {
      analysis.wireAnalysisDeps(prev);
    }
  });

  test('scaffold sync calls the injected cache invalidation; watcher rebaseline only for the current workspace', () => {
    const calls = { invalidate: 0, rebaseline: 0 };
    const prev = scaffold.wireScaffoldDeps({
      invalidateAgentCache: () => { calls.invalidate++; },
      rebaselineAgentsWatcher: () => { calls.rebaseline++; },
    });
    try {
      const current = makeWorkspace({});
      const other = makeWorkspace({});
      srv.setWorkspace(current);

      scaffold.scaffoldWorkspace(other);
      assert.ok(calls.invalidate >= 1, 'writing managed files invalidates the agent cache');
      assert.strictEqual(calls.rebaseline, 0, 'a non-current workspace never rebaselines the live watcher');

      const invalidateBefore = calls.invalidate;
      scaffold.scaffoldWorkspace(current);
      assert.ok(calls.invalidate > invalidateBefore, 'the current workspace sync also invalidates');
      assert.strictEqual(calls.rebaseline, 1, 'the current workspace sync rebaselines the watcher (boot writes are not external edits)');
    } finally {
      scaffold.wireScaffoldDeps(prev);
    }
  });

  test('scaffold sources resolve through the repo root: managed files carry the real scaffold content', () => {
    const dir = makeWorkspace({});
    scaffold.scaffoldWorkspace(dir);
    const guidePath = path.join(dir, '.claude', 'agents', 'rundock-guide.md');
    assert.ok(fs.existsSync(guidePath), 'rundock-guide.md deployed');
    const deployed = fs.readFileSync(guidePath, 'utf-8');
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scaffold', 'rundock-guide.md'), 'utf-8');
    assert.strictEqual(deployed, source, 'deployed content is byte-identical to the scaffold source');
    // The permission-hook launcher points at the repo's scripts/ directory.
    const launcher = fs.readFileSync(path.join(dir, '.rundock', 'permission-hook.sh'), 'utf-8');
    assert.ok(launcher.includes(path.join('scripts', 'permission-hook.js')),
      'the hook launcher references scripts/permission-hook.js resolved from the repo root');
  });
});
