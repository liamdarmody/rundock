'use strict';
// Starts server.js in this process, as `node server.js` would, and answers
// one question from the parent that forked it: the token the permission hook
// of a given conversation is started with. The smoke stands in for that hook,
// so it needs the token the hook would carry; the IPC channel only exists
// between this process and its parent, so nothing else can ask.
const auth = require('../../lib/auth/index.js');

process.on('message', (m) => {
  if (!m || m.type !== 'hook-token' || !process.send) return;
  process.send({ type: 'hook-token', id: m.id, token: auth.issueHookToken(m.conversationId == null ? null : m.conversationId) });
});

require('../../server.js').startServer();
