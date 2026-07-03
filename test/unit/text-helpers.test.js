'use strict';
// Characterization tests for server.js pure text helpers.
// These pin CURRENT behavior. Where a behavior was a previously-fixed defect,
// the test says so in a comment; the corresponding regression guard lives in
// test/unit/regression.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { _internal: srv } = require('../../server.js');

describe('stripRundockMarkers', () => {
  test('strips RETURN and COMPLETE markers', () => {
    const input = 'Done here. <!-- RUNDOCK:RETURN --> and <!-- RUNDOCK:COMPLETE --> end';
    assert.strictEqual(srv.stripRundockMarkers(input), 'Done here.  and  end');
  });

  test('DELEGATE marker strips everything after it (including trailing text)', () => {
    const input = 'Handing off.\n<!-- RUNDOCK:DELEGATE agent=content-lead -->\nbrief text here\nmore';
    assert.strictEqual(srv.stripRundockMarkers(input), 'Handing off.\n');
  });

  test('strips SAVE_AGENT block including payload', () => {
    const input = 'Before <!-- RUNDOCK:SAVE_AGENT name=sales-coach -->---\nname: sales-coach\n---\nbody<!-- /RUNDOCK:SAVE_AGENT --> After';
    assert.strictEqual(srv.stripRundockMarkers(input), 'Before  After');
  });

  test('strips CREATE_AGENT (legacy alias), SAVE_SKILL, DELETE_SKILL, DELETE_AGENT', () => {
    const input = [
      '<!-- RUNDOCK:CREATE_AGENT name=x -->payload<!-- /RUNDOCK:CREATE_AGENT -->',
      '<!-- RUNDOCK:SAVE_SKILL name=my-skill -->skill payload<!-- /RUNDOCK:SAVE_SKILL -->',
      '<!-- RUNDOCK:DELETE_SKILL name=old-skill -->',
      '<!-- RUNDOCK:DELETE_AGENT name=old-agent -->',
      'kept',
    ].join('\n');
    assert.strictEqual(srv.stripRundockMarkers(input).trim(), 'kept');
  });

  test('mixed SAVE_AGENT open with CREATE_AGENT close still strips (regex allows either keyword on both ends)', () => {
    const input = '<!-- RUNDOCK:SAVE_AGENT name=x -->p<!-- /RUNDOCK:CREATE_AGENT -->rest';
    assert.strictEqual(srv.stripRundockMarkers(input), 'rest');
  });

  test('unterminated SAVE_AGENT block is NOT stripped (pinned as-is)', () => {
    const input = 'text <!-- RUNDOCK:SAVE_AGENT name=x -->payload without close';
    assert.strictEqual(srv.stripRundockMarkers(input), input);
  });
});

describe('isSilentParkResponse', () => {
  test('null/empty/whitespace are silent', () => {
    assert.strictEqual(srv.isSilentParkResponse(null), true);
    assert.strictEqual(srv.isSilentParkResponse(''), true);
    assert.strictEqual(srv.isSilentParkResponse('   \n '), true);
  });

  test('<silent> sentinel is silent, case-insensitive, even wrapped in markers', () => {
    assert.strictEqual(srv.isSilentParkResponse('<silent>'), true);
    assert.strictEqual(srv.isSilentParkResponse('<SILENT>'), true);
    assert.strictEqual(srv.isSilentParkResponse('<silent> <!-- RUNDOCK:COMPLETE -->'), true);
  });

  test('under 10 non-whitespace chars is silent', () => {
    assert.strictEqual(srv.isSilentParkResponse('OK done.'), true); // 7 non-ws chars
    assert.strictEqual(srv.isSilentParkResponse('a b c d e'), true);
  });

  test('known no-op phrases are silent', () => {
    assert.strictEqual(srv.isSilentParkResponse('No response requested.'), true);
    assert.strictEqual(srv.isSilentParkResponse('Understood.'), true);
    assert.strictEqual(srv.isSilentParkResponse('Acknowledged.'), true);
  });

  test('real content is not silent', () => {
    assert.strictEqual(srv.isSilentParkResponse('Here are the three hooks you asked for.'), false);
  });

  test('pinned as-is: 10+ chars of trivial acknowledgement that is not in the no-op list is NOT silent', () => {
    assert.strictEqual(srv.isSilentParkResponse('Got it, thanks!'), false);
  });
});

describe('sanitizeSpecialistOutput', () => {
  test('strips markers and trims', () => {
    const out = srv.sanitizeSpecialistOutput('  Result text. <!-- RUNDOCK:COMPLETE -->  ');
    assert.strictEqual(out, 'Result text.');
  });

  test('empty input returns empty string', () => {
    assert.strictEqual(srv.sanitizeSpecialistOutput(''), '');
    assert.strictEqual(srv.sanitizeSpecialistOutput(null), '');
  });

  test('caps output at SPECIALIST_OUTPUT_MAX_CHARS with truncation notice', () => {
    const long = 'x'.repeat(srv.SPECIALIST_OUTPUT_MAX_CHARS + 500);
    const out = srv.sanitizeSpecialistOutput(long);
    assert.ok(out.startsWith('x'.repeat(100)));
    assert.ok(out.endsWith('[... output truncated for brevity ...]'));
    assert.strictEqual(out.length, srv.SPECIALIST_OUTPUT_MAX_CHARS + '\n\n[... output truncated for brevity ...]'.length);
  });
});

describe('extractSnippet', () => {
  test('returns context around the match with ellipses', () => {
    const text = 'a'.repeat(100) + 'NEEDLE' + 'b'.repeat(100);
    const snippet = srv.extractSnippet(text, 'needle');
    assert.ok(snippet.startsWith('...'));
    assert.ok(snippet.endsWith('...'));
    assert.ok(snippet.includes('NEEDLE'));
  });

  test('match at start: no leading ellipsis', () => {
    const snippet = srv.extractSnippet('NEEDLE then some trailing text', 'needle');
    assert.ok(snippet.startsWith('NEEDLE'));
  });

  test('no match returns the first 120 chars', () => {
    const text = 'z'.repeat(300);
    const snippet = srv.extractSnippet(text, 'missing');
    assert.strictEqual(snippet, 'z'.repeat(120));
  });

  test('newlines in snippet are flattened to spaces', () => {
    const snippet = srv.extractSnippet('line one\nNEEDLE\nline two', 'needle');
    assert.ok(!snippet.includes('\n'));
  });

  test('pinned as-is: query must already be lowercased by the caller (search handler lowercases); uppercase query never matches', () => {
    const snippet = srv.extractSnippet('find NEEDLE here', 'NEEDLE');
    // indexOf runs against lowercased text with the raw query, so an uppercase
    // query misses and the fallback prefix is returned.
    assert.strictEqual(snippet, 'find NEEDLE here'.substring(0, 120));
  });
});

describe('buildToolSummary', () => {
  test('empty or missing tool calls produce empty string', () => {
    assert.strictEqual(srv.buildToolSummary([]), '');
    assert.strictEqual(srv.buildToolSummary(null), '');
  });

  test('formats tools with and without args', () => {
    const out = srv.buildToolSummary([
      { tool: 'Read', arg: '/tmp/a.md' },
      { tool: 'WebSearch', arg: null },
    ]);
    assert.strictEqual(out, '[Read /tmp/a.md] [WebSearch]');
  });

  test('dedupes identical tool+arg pairs, keeps distinct args', () => {
    const out = srv.buildToolSummary([
      { tool: 'Read', arg: 'a.md' },
      { tool: 'Read', arg: 'a.md' },
      { tool: 'Read', arg: 'b.md' },
    ]);
    assert.strictEqual(out, '[Read a.md] [Read b.md]');
  });

  test('caps at 10 distinct entries', () => {
    const calls = Array.from({ length: 15 }, (_, i) => ({ tool: 'Read', arg: `f${i}.md` }));
    const out = srv.buildToolSummary(calls);
    assert.strictEqual(out.split('] [').length, 10);
  });
});

describe('isAuthError / isModelError', () => {
  test('auth error signatures match', () => {
    assert.strictEqual(srv.isAuthError('authentication_error: bad token'), true);
    assert.strictEqual(srv.isAuthError('OAuth token has expired'), true);
    assert.strictEqual(srv.isAuthError('oauth token expired'), true);
    assert.strictEqual(srv.isAuthError('Please run /login'), true);
    assert.strictEqual(srv.isAuthError('please run `claude login`'), true);
    assert.strictEqual(srv.isAuthError('failed to authenticate'), true);
  });

  test('non-auth text and non-strings do not match', () => {
    assert.strictEqual(srv.isAuthError('TypeError: cannot read x'), false);
    assert.strictEqual(srv.isAuthError(undefined), false);
    assert.strictEqual(srv.isAuthError(42), false);
  });

  test('model error signatures match', () => {
    assert.strictEqual(srv.isModelError('There is an issue with the selected model'), true);
    assert.strictEqual(srv.isModelError('invalid model: pro'), true);
    assert.strictEqual(srv.isModelError('model not found'), true);
    assert.strictEqual(srv.isModelError('the model is not valid'), true);
  });

  test('pinned as-is: lowercase text between "model" and the failure phrase defeats the match', () => {
    // The regex only allows non-lowercase chars between "model" and e.g.
    // "not found", so a quoted model name breaks the signature.
    assert.strictEqual(srv.isModelError('model "foo" not found'), false);
  });

  test('generic errors are not model errors', () => {
    assert.strictEqual(srv.isModelError('command failed'), false);
    assert.strictEqual(srv.isModelError(null), false);
  });
});

describe('validateAgentSlug', () => {
  test('accepts lowercase slugs with digits and hyphens', () => {
    assert.strictEqual(srv.validateAgentSlug('sales-coach'), true);
    assert.strictEqual(srv.validateAgentSlug('a'), true);
    assert.strictEqual(srv.validateAgentSlug('agent2'), true);
    assert.strictEqual(srv.validateAgentSlug('2fast'), true);
  });

  test('rejects traversal, uppercase, separators, empties, non-strings, over-length', () => {
    assert.strictEqual(srv.validateAgentSlug('../evil'), false);
    assert.strictEqual(srv.validateAgentSlug('..'), false);
    assert.strictEqual(srv.validateAgentSlug('Upper'), false);
    assert.strictEqual(srv.validateAgentSlug('has space'), false);
    assert.strictEqual(srv.validateAgentSlug('slash/name'), false);
    assert.strictEqual(srv.validateAgentSlug('back\\slash'), false);
    assert.strictEqual(srv.validateAgentSlug(''), false);
    assert.strictEqual(srv.validateAgentSlug(null), false);
    assert.strictEqual(srv.validateAgentSlug(123), false);
    assert.strictEqual(srv.validateAgentSlug('-leading-hyphen'), false);
    assert.strictEqual(srv.validateAgentSlug('a'.repeat(61)), false);
    assert.strictEqual(srv.validateAgentSlug('a'.repeat(60)), true);
  });
});

describe('titleCase', () => {
  test('converts hyphenated slugs to Title Case', () => {
    assert.strictEqual(srv.titleCase('content-lead'), 'Content Lead');
    assert.strictEqual(srv.titleCase('doc'), 'Doc');
  });
});

describe('modelArgs / allowed tools', () => {
  test('modelArgs uses agent model or default sonnet', () => {
    assert.deepStrictEqual(srv.modelArgs({ model: 'opus' }), ['--model', 'opus']);
    assert.deepStrictEqual(srv.modelArgs({}), ['--model', 'sonnet']);
    assert.deepStrictEqual(srv.modelArgs(null), ['--model', 'sonnet']);
    assert.strictEqual(srv.DEFAULT_MODEL, 'sonnet');
  });

  test('interactive allow-list has no Bash and no MCP scopes; legacy has Bash', () => {
    const interactive = srv.getAllowedToolsInteractive();
    assert.ok(!interactive.split(',').includes('Bash'));
    assert.ok(!/mcp__/.test(interactive));
    assert.deepStrictEqual(interactive.split(','), ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch', 'Agent', 'Skill']);
    assert.ok(srv.getAllowedToolsLegacy().split(',').includes('Bash'));
  });

  test('permission mode is always acceptEdits', () => {
    assert.strictEqual(srv.getPermissionMode(), 'acceptEdits');
  });
});
