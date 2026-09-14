'use strict';
// A HANDOFF LINE THAT NAMES SOMEBODY IS A HANDOFF TO THEM.
//
// Measured in a real conversation before this was written. Ren was asked to
// research and then have Sage fact-check. She made an Agent call with no
// subagent_type, a description reading "Handing to Sage to fact-check the
// Rundock.ai research before I finalise it for Roo.", and 3,526 characters of
// prompt that never said "sage" or "fact-checker" once.
//
// The matcher takes subagent_type when set, and with none falls through to a
// word-scan of the prompt alone. Nothing matched, nothing was intercepted, no
// delegation happened. Ren handed back, the orchestrator picked up and tried
// Sage directly, and was correctly blocked because Sage reports to Ren. The
// block was right; the miss was upstream.
//
// This release caused it. Making `description` the sentence the person reads
// taught agents to name who is taking the work there, which is the one field
// the scan did not read.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const { makeWorkspace, agentFile, cleanup } = require(path.join(ROOT, 'test', 'helpers', 'workspace.js'));
const { after } = require('node:test');
after(cleanup);

// The reported shape: an orchestrator, a lead, and the lead's own report.
function team() {
  return {
    roo: agentFile({ name: 'roo', displayName: 'Roo', role: 'Orchestrator', description: 'routes', type: 'orchestrator', order: 0, body: 'You route.' }),
    'research-lead': agentFile({ name: 'research-lead', displayName: 'Ren', role: 'Research Lead', description: 'researches', type: 'specialist', order: 1, reportsTo: 'roo', body: 'You research.' }),
    'fact-checker': agentFile({ name: 'fact-checker', displayName: 'Sage', role: 'Fact Checker', description: 'verifies', type: 'specialist', order: 2, reportsTo: 'research-lead', body: 'You verify.' }),
  };
}

function matcher() {
  const dir = makeWorkspace({ agents: team(), claudeMd: '# Test\n' });
  const config = require(path.join(ROOT, 'lib', 'config.js'));
  const before = config.getWorkspace();
  config.setWorkspace(dir);
  delete require.cache[require.resolve(path.join(ROOT, 'lib', 'agents', 'discovery.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'lib', 'agents', 'prompt.js'))];
  const { findDirectReportMatch } = require(path.join(ROOT, 'lib', 'agents', 'prompt.js'));
  return { findDirectReportMatch, restore: () => config.setWorkspace(before) };
}

describe('a lead naming its own report in the handoff line delegates to them', () => {
  test('the reported call, exactly as it arrived', () => {
    const { findDirectReportMatch, restore } = matcher();
    try {
      const m = findDirectReportMatch('research-lead', {
        description: 'Handing to Sage to fact-check the Rundock.ai research before I finalise it for Roo.',
        prompt: "I've done a quick research pass on Rundock.ai, drawing on rundock.ai and docs.rundock.ai. "
          + 'This needs verifying before it goes back, because it will inform decisions. '
          + 'Check each claim against the source pages and say which hold up.',
      });
      assert.ok(m, 'the call names her in the sentence the person reads, so it is a handoff to her');
      assert.strictEqual(m.name, 'fact-checker');
    } finally { restore(); }
  });

  test('the slug works there too, not only the display name', () => {
    const { findDirectReportMatch, restore } = matcher();
    try {
      const m = findDirectReportMatch('research-lead', { description: 'Over to fact-checker for verification.', prompt: 'verify this' });
      assert.strictEqual(m && m.name, 'fact-checker');
    } finally { restore(); }
  });

  test('a target named in the prompt still works, as it always did', () => {
    // The field was added to the scan; nothing was taken away.
    const { findDirectReportMatch, restore } = matcher();
    try {
      const m = findDirectReportMatch('research-lead', { prompt: 'Sage should check these claims.' });
      assert.strictEqual(m && m.name, 'fact-checker');
    } finally { restore(); }
  });

  test('an explicit subagent_type still decides on its own', () => {
    // A built-in target is a deliberate choice. Naming a teammate in the
    // sentence must not hijack it, exactly as naming one in the prompt does not.
    const { findDirectReportMatch, restore } = matcher();
    try {
      const m = findDirectReportMatch('research-lead', {
        subagent_type: 'general-purpose',
        description: 'Handing to Sage to fact-check this.',
        prompt: 'Sage should check these claims.',
      });
      assert.strictEqual(m, null,
        'the caller asked for a general-purpose subagent and gets one');
    } finally { restore(); }
  });

  test('a description naming nobody on the roster matches nobody', () => {
    const { findDirectReportMatch, restore } = matcher();
    try {
      assert.strictEqual(findDirectReportMatch('research-lead', { description: 'Look into the pricing page.', prompt: 'have a look' }), null,
        'the scan finds a teammate or it finds nothing: it does not guess');
    } finally { restore(); }
  });

  test('a name inside a longer word is not a match', () => {
    // The word-boundary rule the prompt scan already had, now covering both.
    const { findDirectReportMatch, restore } = matcher();
    try {
      assert.strictEqual(findDirectReportMatch('research-lead', { description: 'Check the sagebrush supplier list.', prompt: 'go on' }), null);
    } finally { restore(); }
  });

  test('an agent handing to somebody who is not its report still matches nobody', () => {
    // Roo naming Sage: Sage reports to Ren, so this is not Roo's to make. The
    // off-roster guard handles it, and it must not become a match here.
    const { findDirectReportMatch, restore } = matcher();
    try {
      assert.strictEqual(findDirectReportMatch('roo', { description: 'Handing to Sage to fact-check.', prompt: 'check it' }), null,
        'the org chart still decides who may hand to whom');
    } finally { restore(); }
  });
});
