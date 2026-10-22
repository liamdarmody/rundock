'use strict';
// How a connector (MCP) action is graded, by the two graders that see it: the
// permission hook, which runs a read with no card and sends everything else to
// one, and the client, which decides what that card offers. Both are driven on
// action names here. The same calls through the real hook, server and card are
// in test/integration/connector-approvals.test.js.
//
// A connector action that sends, replies or forwards is graded the way a delete
// is: never a read, high risk, so it asks every time with Allow and Deny only
// and no saved "Always allow" answers it. Once a message has gone it cannot be
// called back, and one tired click on "Always allow" used to let every agent in
// the workspace send without asking again.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const hook = require('../../scripts/permission-hook.js');
const P = require('../../public/permissions.js');

const tool = (action) => `mcp__example_mail__${action}`;

// Every way the action part of a name can say send, reply or forward: split on
// `_`, `-` and camelCase, a whole word anywhere in the name.
const SENDS = [
  'send_message', 'reply_to_thread', 'forward_email', 'sendEmail', 'SendMessage', 'send',
  'bulk_send', 'resend_verification', 'reply-all', 'replyToComment', 'forwardInvite',
  // Each also carries a read word, which is what let it run with no card at all.
  'send_status_update', 'reply_to_review', 'forward_recent_messages', 'send_daily_digest',
];

// Names that look like a send and are not one, each with the grade it had
// before sends were singled out: whether the hook runs it as a read, and how
// the client grades the card when it does not.
const LOOKALIKES = {
  get_sent_items: { read: true },
  list_sent: { read: true },
  search_forwarded: { read: true },
  sender_info: { read: true },
  list_sends: { read: true },
  get_replies: { read: true },
  sender_lookup: { read: false, risk: 'medium' },
  update_sender_name: { read: false, risk: 'medium' },
};

describe('a connector action that sends is graded like a delete', () => {
  for (const action of SENDS) {
    test(`${action}: never a read, and high risk`, () => {
      assert.strictEqual(hook.isMcpReadTool(tool(action)), false, 'the hook never runs it without a card');
      assert.strictEqual(P.classifyRisk(tool(action), {}), 'high', 'the card asks every time');
      assert.strictEqual(P.offersAlwaysAllow(P.classifyRisk(tool(action), {})), false, 'Allow and Deny only');
    });
  }

  test('a saved allow under its own key does not answer it', () => {
    const key = P.toolAllowKey(tool('send_message'), {});
    assert.strictEqual(key, tool('send_message'), 'a connector action is remembered under its full name');
    assert.deepStrictEqual(P.decidePermission(P.classifyRisk(key, {}), key, new Set([key])), { action: 'card' });
  });

  test('the server prefix is not part of the action', () => {
    // A connector named for sending still has reads.
    assert.strictEqual(hook.isMcpReadTool('mcp__example_send__list_templates'), true);
    assert.strictEqual(P.classifyRisk('mcp__example_forward__create_rule', {}), 'medium');
    assert.strictEqual(hook.isMcpSendTool('mcp__example_forward__create_rule'), false);
  });
});

describe('which saved answers name a connector send', () => {
  // The store of saved answers drops these (lib/workspace/boundary.js), so
  // this decides which "Always allow" answers a workspace keeps.
  test('every send, reply and forward', () => {
    for (const action of SENDS) assert.strictEqual(hook.isMcpSendTool(tool(action)), true, action);
  });

  test('never a lookalike, another write, or a tool that is not a connector', () => {
    for (const action of [...Object.keys(LOOKALIKES), 'create_draft', 'update_event']) {
      assert.strictEqual(hook.isMcpSendTool(tool(action)), false, action);
    }
    for (const key of ['Bash:send', 'Bash', 'WebFetch', 'plugin__mail__send', 'Bash:git-push:default-branch']) {
      assert.strictEqual(hook.isMcpSendTool(key), false, key);
    }
  });
});

describe('names that only look like a send are graded as before', () => {
  for (const [action, was] of Object.entries(LOOKALIKES)) {
    test(action, () => {
      assert.strictEqual(hook.isMcpReadTool(tool(action)), was.read);
      if (!was.read) assert.strictEqual(P.classifyRisk(tool(action), {}), was.risk);
    });
  }

  test('other writes stay medium, with Always allow on offer', () => {
    for (const action of ['create_draft', 'update_event', 'API-move-page']) {
      assert.strictEqual(hook.isMcpReadTool(tool(action)), false, action);
      assert.strictEqual(P.classifyRisk(tool(action), {}), 'medium', action);
      assert.strictEqual(P.offersAlwaysAllow('medium'), true);
    }
  });
});

describe('which connector actions delete', () => {
  // Refused rather than allowed when Rundock cannot be asked, like a send.
  test('a delete word anywhere in the action, split as a send is', () => {
    for (const action of ['delete_event', 'deleteEvent', 'remove-label', 'cancelEvent', 'archive_thread', 'bulk_trash']) {
      assert.strictEqual(hook.isMcpDeleteTool(tool(action)), true, action);
    }
  });

  test('never a send, another write, a read, or a tool that is not a connector', () => {
    for (const action of ['send_message', 'create_draft', 'get_deleted_items', 'list_removals']) {
      assert.strictEqual(hook.isMcpDeleteTool(tool(action)), false, action);
    }
    for (const key of ['Bash:delete', 'plugin__mail__delete']) assert.strictEqual(hook.isMcpDeleteTool(key), false, key);
  });
});

describe('the verb tables', () => {
  test('the words that make an action a send, a delete or a read, pinned', () => {
    assert.deepStrictEqual([...hook.MCP_SEND_VERBS].sort(), ['forward', 'reply', 'resend', 'send']);
    assert.deepStrictEqual([...hook.MCP_DESTRUCTIVE_VERBS].sort(),
      ['abort', 'archive', 'cancel', 'clear', 'delete', 'destroy', 'drop', 'purge', 'remove', 'trash', 'uninstall']);
    assert.deepStrictEqual([...hook.MCP_READ_VERBS].sort(), [
      'activity', 'available', 'collaborators', 'comments', 'count', 'daily', 'describe', 'export', 'fetch', 'find',
      'get', 'info', 'list', 'overview', 'query', 'read', 'recent', 'retrieve', 'review', 'search', 'show', 'status',
      'suggest', 'view',
    ]);
  });

  test('the client grades the same words as a send that the hook does', () => {
    // The browser cannot require the hook, so each keeps its own list; two
    // lists that drift apart would let one grader ask and the other not.
    assert.deepStrictEqual([...P.MCP_SEND_VERBS].sort(), [...hook.MCP_SEND_VERBS].sort());
  });

  test('a send word wins over a read word, whichever comes first', () => {
    assert.strictEqual(hook.isMcpReadTool(tool('search_and_reply')), false);
    assert.strictEqual(hook.isMcpReadTool(tool('reply_and_search')), false);
  });
});

describe('suggesting is a read', () => {
  // A calendar's suggest_time reads availability and changes nothing, like the
  // list, search and get actions beside it.
  const calendar = (action) => `mcp__example_calendar__${action}`;

  test('suggest_time runs as a read, like the calendar reads beside it', () => {
    for (const action of ['suggest_time', 'suggestTime', 'list_events', 'search_events', 'get_event']) {
      assert.strictEqual(hook.isMcpReadTool(calendar(action)), true, action);
    }
  });

  test('a calendar write beside it still asks', () => {
    for (const action of ['create_event', 'update_event', 'respond_to_event']) {
      assert.strictEqual(hook.isMcpReadTool(calendar(action)), false, action);
    }
    assert.strictEqual(hook.isMcpReadTool(calendar('delete_event')), false);
  });

  test('suggesting never outranks a send or a delete, and only the whole word counts', () => {
    assert.strictEqual(hook.isMcpReadTool(calendar('suggest_and_send_invite')), false);
    assert.strictEqual(P.classifyRisk(calendar('suggest_and_send_invite'), {}), 'high');
    assert.strictEqual(hook.isMcpReadTool(calendar('suggest_then_cancel_event')), false);
    assert.strictEqual(hook.isMcpReadTool(calendar('create_suggestion')), false, 'a suggestion made is a write');
  });
});
