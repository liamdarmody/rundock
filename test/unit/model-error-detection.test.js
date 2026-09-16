'use strict';
// Which runtime rejections raise the model recovery card.
//
// The card is the whole recovery path for a rejected model: a user who never
// sees it gets a raw error blob and no statement of what to change. The pattern
// was written when a model was always one of three known words, so it allowed
// nothing between "model" and the complaint. A runtime serving the user's own
// identifiers puts the NAME in that gap, and the likeliest message a gateway
// user sees fell straight through.
//
// The negative cases below are the real specification. Widening the gap is
// exactly how a model card starts appearing for errors that have nothing to do
// with models, and "the model responded but the file was not found" is the
// shape that breaks a careless fix.
//
// These bodies are representative of common API conventions, NOT captures from
// a real gateway. They are the best evidence available without one, and issue
// #307 asks the reporter for his actual text.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { _internal: srv } = require('../../server.js');

describe('a rejected model raises the recovery card', () => {
  const RAISES = [
    ['a gateway identifier that does not exist', 'The model `my-gateway/claude-model-id` does not exist'],
    ['the machine-readable code alone', '{"error":{"message":"no","code":"model_not_found"}}'],
    ['an Anthropic-shaped not-found payload', '{"type":"error","error":{"type":"not_found_error","message":"model: claude-foo"}}'],
    ['a LiteLLM bad request', 'litellm.BadRequestError: Invalid model name passed in model=my-gateway/x'],
    ['a LiteLLM identifier with no provider prefix', 'litellm.BadRequestError: LLM Provider NOT provided.'],
    ['a bare 404 body', 'Error: 404 {"error":"model not found"}'],
    ['what Claude Code says today', 'API Error: 400 There was an issue with the selected model'],
    ['a single-quoted name', "model 'gpt-foo' is not valid"],
    ['the "is not supported" wording', 'The model claude-foo is not supported on this account'],
    // The exact phrasing Codex's own classifier matches, so the two agree.
    ['Codex account entitlement', "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account"],
  ];

  for (const [label, body] of RAISES) {
    test(`raises the card: ${label}`, () => {
      assert.ok(srv.isModelError(body), `this is a rejected model and must reach the card:\n  ${body}`);
    });
  }
});

describe('an error that is not about the model does not raise it', () => {
  const IGNORES = [
    ['a file missing, mentioned near the word model', 'The model responded but the file was not found'],
    ['a tool being unavailable', 'Model behaviour: the requested tool was not available'],
    ['a plain missing path', 'not found: /path/to/file.md'],
    ['an unrelated sentence carrying both words', 'The user model was updated and the record does not exist yet'],
    ['an auth failure', 'Invalid API key provided'],
    ['a permission failure', 'Permission denied: the file was not available to read'],
  ];

  for (const [label, body] of IGNORES) {
    test(`stays silent: ${label}`, () => {
      assert.ok(!srv.isModelError(body),
        `telling this user to change their model would send them down the wrong path:\n  ${body}`);
    });
  }

  // The tightened not_found_error branch: "model" must appear as a key naming
  // the thing that was not found, not as a passing mention inside an unrelated
  // not-found payload.
  test('a not-found payload that merely mentions the word stays silent', () => {
    assert.ok(!srv.isModelError('{"type":"not_found_error","message":"the requested page for this model guide was removed"}'));
  });

  test('non-strings are never errors', () => {
    for (const v of [null, undefined, 42, {}, []]) assert.ok(!srv.isModelError(v));
  });
});
