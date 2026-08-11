'use strict';
// The probe turns shared by the capture runner (scripts/stream-truth/run.mjs)
// and the drift-alarm tests (test/unit/stream-truth.test.js). One definition,
// so the stub is always checked against exactly what was captured.
//
// Each scenario has:
//   prompt   - sent verbatim to the real CLI (capture) and the stub (check)
//   cliArgs  - extra real-CLI flags (tool allowances)
//   stubRule - the stub-scenario rule that must reproduce the REAL stream's
//              grammar. realStream: true everywhere: the production
//              end-of-message shape is the whole point.
//
// The tool-turn scripts the full multi-message loop the real CLI produces
// (tool_use message -> tool_result -> follow-up text message) via raw
// envelopes, because that two-message frame is the shape that killed the
// first 0.11.6 draft.

const path = require('path');
const fx = require(path.join(__dirname, '..', '..', 'test', 'fixtures', 'stream-json.js'));

const SCENARIOS = [
  {
    name: 'text-turn',
    prompt: 'Reply with exactly: OK',
    cliArgs: [],
    stubRule: {
      match: { promptIncludes: 'Reply with exactly: OK' },
      realStream: true,
      turn: [{ text: 'OK' }],
    },
  },
  {
    name: 'tool-turn',
    prompt: 'Use the Bash tool to run exactly this command: echo rundock-stream-truth . Then reply with exactly: DONE',
    cliArgs: ['--allowedTools', 'Bash'],
    stubRule: {
      match: { promptIncludes: 'echo rundock-stream-truth' },
      realStream: true,
      turn: [
        // Message 1: the tool_use block, closed like a real message.
        { tool: { name: 'Bash', input: { command: 'echo rundock-stream-truth' } } },
        { raw: fx.messageDelta('tool_use') },
        { raw: fx.messageStop() },
        // The tool result comes back as a user envelope, then message 2.
        { raw: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'rundock-stream-truth' }] } } },
        { text: 'DONE' },
      ],
    },
  },
];

module.exports = { SCENARIOS };
