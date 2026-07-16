'use strict';
// Unit tests for public/markers.js: the RUNDOCK response-marker scanner.
// This logic triggers real orchestration from the client (agent/skill saves,
// deletes, delegation, returns) and previously lived untested inside
// handleResult. Every behaviour here is the extraction contract: a failure
// means the refactor changed behaviour, which is a defect by definition.
const { test } = require('node:test');
const assert = require('node:assert');

const { scanMarkers, extractFrontmatterAgents, stripMarkers, stripDelegateTail } =
  require('../../public/markers.js');

// ── scanMarkers: saves ──────────────────────────────────────────────────────

test('SAVE_AGENT marker produces a save_agent action with trimmed content', () => {
  const text = 'Done!\n<!-- RUNDOCK:SAVE_AGENT name=my-agent -->\n---\nname: my-agent\n---\nBody here.\n<!-- /RUNDOCK:SAVE_AGENT -->';
  const { actions } = scanMarkers(text);
  assert.deepStrictEqual(actions, [
    { kind: 'save_agent', name: 'my-agent', content: '---\nname: my-agent\n---\nBody here.' },
  ]);
});

test('legacy CREATE_AGENT marker also saves (backward compatibility)', () => {
  const text = '<!-- RUNDOCK:CREATE_AGENT name=old-style -->\ncontent\n<!-- /RUNDOCK:CREATE_AGENT -->';
  const { actions } = scanMarkers(text);
  assert.strictEqual(actions.length, 1);
  assert.strictEqual(actions[0].kind, 'save_agent');
  assert.strictEqual(actions[0].name, 'old-style');
});

test('cosmetic outer code fence is stripped from save content', () => {
  const text = '<!-- RUNDOCK:SAVE_AGENT name=fenced -->\n```markdown\n---\nname: fenced\n---\n```\n<!-- /RUNDOCK:SAVE_AGENT -->';
  const { actions } = scanMarkers(text);
  assert.strictEqual(actions[0].content, '---\nname: fenced\n---');
});

test('inner code fences in the body are preserved (fences are not delimiters)', () => {
  const body = '---\nname: nested\n---\nUse this template:\n```yaml\nname: example\n```\nEnd.';
  const text = `<!-- RUNDOCK:SAVE_AGENT name=nested -->\n${body}\n<!-- /RUNDOCK:SAVE_AGENT -->`;
  const { actions } = scanMarkers(text);
  assert.ok(actions[0].content.includes('```yaml\nname: example\n```'));
  assert.ok(actions[0].content.endsWith('End.'));
});

test('SAVE_SKILL marker produces a save_skill action', () => {
  const text = '<!-- RUNDOCK:SAVE_SKILL name=my-skill -->\nSkill body.\n<!-- /RUNDOCK:SAVE_SKILL -->';
  const { actions } = scanMarkers(text);
  assert.deepStrictEqual(actions, [{ kind: 'save_skill', name: 'my-skill', content: 'Skill body.' }]);
});

test('multiple markers scan in kind order then text order (send-order contract)', () => {
  const text = [
    '<!-- RUNDOCK:DELETE_AGENT name=gone-agent -->',
    '<!-- RUNDOCK:SAVE_SKILL name=skill-b -->\nB\n<!-- /RUNDOCK:SAVE_SKILL -->',
    '<!-- RUNDOCK:SAVE_AGENT name=agent-a -->\nA\n<!-- /RUNDOCK:SAVE_AGENT -->',
    '<!-- RUNDOCK:DELETE_SKILL name=gone-skill -->',
    '<!-- RUNDOCK:SAVE_AGENT name=agent-b -->\nA2\n<!-- /RUNDOCK:SAVE_AGENT -->',
  ].join('\n');
  const { actions } = scanMarkers(text);
  assert.deepStrictEqual(actions.map(a => `${a.kind}:${a.name}`), [
    'save_agent:agent-a', 'save_agent:agent-b',
    'save_skill:skill-b',
    'delete_skill:gone-skill',
    'delete_agent:gone-agent',
  ]);
});

// ── scanMarkers: delegation and return ──────────────────────────────────────

test('DELEGATE marker yields target and trimmed context', () => {
  const text = 'Handing off.\n<!-- RUNDOCK:DELEGATE agent=content-lead -->\n  Write the hooks.  \n<!-- /RUNDOCK:DELEGATE -->\ntrailing';
  const { delegation } = scanMarkers(text);
  assert.deepStrictEqual(delegation, { targetAgent: 'content-lead', context: 'Write the hooks.' });
});

test('only the FIRST delegate marker is honoured', () => {
  const text = '<!-- RUNDOCK:DELEGATE agent=first -->\nctx1\n<!-- /RUNDOCK:DELEGATE -->\n<!-- RUNDOCK:DELEGATE agent=second -->\nctx2\n<!-- /RUNDOCK:DELEGATE -->';
  const { delegation } = scanMarkers(text);
  assert.strictEqual(delegation.targetAgent, 'first');
});

test('RETURN marker sets hasReturn', () => {
  assert.strictEqual(scanMarkers('All done. <!-- RUNDOCK:RETURN -->').hasReturn, true);
  assert.strictEqual(scanMarkers('No markers here.').hasReturn, false);
});

test('no markers yields empty actions, null delegation, no return', () => {
  const result = scanMarkers('Just a normal reply.');
  assert.deepStrictEqual(result, { actions: [], delegation: null, hasReturn: false });
});

test('non-string input is tolerated', () => {
  assert.deepStrictEqual(scanMarkers(undefined), { actions: [], delegation: null, hasReturn: false });
  assert.deepStrictEqual(scanMarkers(null).actions, []);
});

// ── extractFrontmatterAgents: the no-marker fallback ────────────────────────

test('fenced frontmatter block with name and type extracts', () => {
  const text = 'Here is your agent:\n```markdown\n---\nname: helper\ntype: specialist\n---\nDoes things.\n```';
  const found = extractFrontmatterAgents(text);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].name, 'helper');
  assert.ok(found[0].content.startsWith('---\nname: helper'));
});

test('fenced block without a type field does not extract', () => {
  const text = '```\n---\nname: not-an-agent\n---\nbody\n```';
  assert.deepStrictEqual(extractFrontmatterAgents(text), []);
});

test('type must be orchestrator or specialist', () => {
  const text = '```\n---\nname: odd\ntype: gadget\n---\nbody\n```';
  assert.deepStrictEqual(extractFrontmatterAgents(text), []);
});

test('raw frontmatter fallback applies only when fenced found nothing', () => {
  const raw = 'Intro.\n---\nname: raw-agent\ntype: orchestrator\n---\nBody.';
  const found = extractFrontmatterAgents(raw);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].name, 'raw-agent');

  // When a fenced block matches, raw blocks are not also extracted.
  const both = '```\n---\nname: fenced-agent\ntype: specialist\n---\nA\n```\n---\nname: raw-agent\ntype: specialist\n---\nB';
  const foundBoth = extractFrontmatterAgents(both);
  assert.deepStrictEqual(foundBoth.map(f => f.name), ['fenced-agent']);
});

test('multiple raw frontmatter blocks all extract', () => {
  const text = '---\nname: one\ntype: specialist\n---\nA\n---\nname: two\ntype: specialist\n---\nB';
  const found = extractFrontmatterAgents(text);
  assert.deepStrictEqual(found.map(f => f.name), ['one', 'two']);
});

// ── display strippers ───────────────────────────────────────────────────────

test('stripMarkers removes save blocks, delete lines, and return markers', () => {
  const text = 'Before. <!-- RUNDOCK:RETURN -->\n<!-- RUNDOCK:SAVE_AGENT name=x -->\nhidden\n<!-- /RUNDOCK:SAVE_AGENT -->\n<!-- RUNDOCK:DELETE_SKILL name=y -->\nAfter.';
  const stripped = stripMarkers(text);
  assert.ok(!stripped.includes('RUNDOCK'));
  assert.ok(!stripped.includes('hidden'));
  assert.ok(stripped.includes('Before.'));
  assert.ok(stripped.includes('After.'));
});

test('stripDelegateTail removes the marker and everything after it', () => {
  const text = 'I will hand this to Dev.\n<!-- RUNDOCK:DELEGATE agent=dev -->\nbrief\n<!-- /RUNDOCK:DELEGATE -->\nnever shown';
  const stripped = stripDelegateTail(text).trim();
  assert.strictEqual(stripped, 'I will hand this to Dev.');
});
