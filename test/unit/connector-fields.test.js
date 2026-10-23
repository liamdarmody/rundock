'use strict';
// What a connector's email request says, read from its fields for the card.
//
// The mapping is by generic field names, never by a named service, so every
// server here is made up and every field shape comes in at least two styles:
// flat strings, arrays of addresses, address objects, an object nested under
// `message`, a body held as an object. Anything that is not an email draft or
// send is left alone (null) and its card is drawn as it always was.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const F = require('../../public/connector-fields.js');

// A recipient list as the card writes it: "Name <address>", or the address.
const texts = (list) => list.map(F.addressText);

describe('an email request is read by generic field names', () => {
  test('flat fields, recipients as a comma-separated string', () => {
    const f = F.connectorFields('mcp__example_post__send_message', {
      to: 'sam@example.org, priya@example.com; jo@example.net', cc: 'lee@example.org',
      subject: 'Venue for the 14th', body: 'Hi Sam,\nSee you then.',
    });
    const { to, cc, bcc, ...rest } = f;
    assert.deepStrictEqual(rest, {
      kind: 'email', action: 'send', subject: 'Venue for the 14th', body: 'Hi Sam,\nSee you then.',
      aliases: {}, others: [], othersMore: 0,
    });
    assert.deepStrictEqual(texts(to), ['sam@example.org', 'priya@example.com', 'jo@example.net']);
    assert.deepStrictEqual(texts(cc), ['lee@example.org']);
    assert.deepStrictEqual(bcc, []);
  });

  test('arrays of address objects, named and unnamed, and the body under `text`', () => {
    const f = F.connectorFields('mcp__example_mail__createDraft', {
      recipients: [{ email: 'sam@example.org', name: 'Sam Rivera' }, { address: 'jo@example.net' }, 'lee@example.org'],
      bcc_recipients: [{ email: 'records@example.org' }],
      Subject: 'Notes', text: 'Short note.',
    });
    assert.strictEqual(f.action, 'draft');
    assert.deepStrictEqual(texts(f.to), ['Sam Rivera <sam@example.org>', 'jo@example.net', 'lee@example.org']);
    assert.deepStrictEqual(f.to[0], { name: 'Sam Rivera', address: 'sam@example.org' }, 'the name is kept apart from its address');
    assert.deepStrictEqual(texts(f.bcc), ['records@example.org']);
    assert.strictEqual(f.subject, 'Notes');
    assert.strictEqual(f.body, 'Short note.');
  });

  test('everything nested under `message`, with addresses wrapped and the body an object', () => {
    const f = F.connectorFields('mcp__example_office__reply_to_thread', {
      message: {
        subject: 'Re: plan',
        body: { contentType: 'Text', content: 'Agreed.' },
        toRecipients: [{ emailAddress: { address: 'sam@example.org', name: 'Sam' } }],
        ccRecipients: [{ emailAddress: { address: 'priya@example.com' } }],
      },
      saveToSentItems: true,
    });
    assert.strictEqual(f.action, 'reply');
    assert.deepStrictEqual(texts(f.to), ['Sam <sam@example.org>']);
    assert.deepStrictEqual(texts(f.cc), ['priya@example.com']);
    assert.strictEqual(f.body, 'Agreed.');
    assert.deepStrictEqual(f.others, [{ key: 'saveToSentItems', text: 'true' }], 'the field the card does not read is listed, not dropped');
  });

  test('a send, reply or forward with only a body is read: what it says is shown, and the rest listed', () => {
    const reply = F.connectorFields('mcp__example_post__reply_to_thread', { threadId: 't1', body: 'Sounds good, see you then.' });
    assert.strictEqual(reply.kind, 'email');
    assert.strictEqual(reply.action, 'reply');
    assert.strictEqual(reply.body, 'Sounds good, see you then.');
    assert.deepStrictEqual(reply.others, [{ key: 'threadId', text: 't1' }]);
    assert.strictEqual(F.hasUnreadFields(reply), false, 'a thread id is not who it reaches');
    const chat = F.connectorFields('mcp__example_chat__send_message', { channel: 'general', text: 'hello' });
    assert.strictEqual(chat.body, 'hello');
    assert.deepStrictEqual(chat.others, [{ key: 'channel', text: 'general' }]);
    assert.strictEqual(F.hasUnreadFields(chat), true, 'a channel could be who it reaches');
    const forward = F.connectorFields('mcp__example_post__forward', { messageId: 'm1', body: 'FYI' });
    assert.strictEqual(forward.action, 'forward');
    assert.strictEqual(forward.body, 'FYI');
  });

  test('forward and fwd are forwards, resend is a send', () => {
    assert.strictEqual(F.connectorFields('mcp__example_post__forwardEmail', { to: 'a@example.org' }).action, 'forward');
    assert.strictEqual(F.connectorFields('mcp__example_post__fwd_message', { to: 'a@example.org' }).action, 'forward');
    assert.strictEqual(F.connectorFields('mcp__example_post__resend', { to: 'a@example.org' }).action, 'send');
    assert.strictEqual(F.connectorFields('mcp__example_post__send_draft', { to: 'a@example.org' }).action, 'send',
      'sending a draft sends');
  });

  test('missing fields come back empty, not invented', () => {
    const f = F.connectorFields('mcp__example_post__create_draft', { subject: '' });
    assert.deepStrictEqual(f, {
      kind: 'email', action: 'draft', to: [], cc: [], bcc: [], subject: '', body: '', aliases: {}, others: [], othersMore: 0,
    });
  });
});

describe('every field a request carries is read, so a card can show what the service acts on', () => {
  test('every alias of a field is kept, each under its real key, the first as the field', () => {
    const f = F.connectorFields('mcp__example_post__send_message', { to: 'boss@example.org', recipients: ['evil@example.net'], subject: 's' });
    assert.deepStrictEqual(texts(f.to), ['boss@example.org']);
    assert.deepStrictEqual(f.aliases.to.map((o) => [o.key, texts(o.value)]), [['to', ['boss@example.org']], ['recipients', ['evil@example.net']]]);
    assert.deepStrictEqual(Object.keys(f.aliases), ['to'], 'a field with one alias has no entry');
  });

  test('a field under more than ten names: ten alias rows, and the rest listed with the other fields', () => {
    const names = ['to', 'To', 'TO', 'tO', 'recipients', 'Recipients', 'RECIPIENTS', 'recipient', 'Recipient', 'toRecipients', 'to_recipients', 'toAddresses'];
    const input = { subject: 's' };
    names.forEach((k, i) => { input[k] = `p${i}@example.org`; });
    const f = F.connectorFields('mcp__example_post__send_message', input);
    assert.strictEqual(F.MAX_ALIAS_ROWS, 10);
    assert.deepStrictEqual(f.aliases.to.map((o) => o.key), names.slice(0, 10));
    assert.deepStrictEqual(f.others, [{ key: 'to_recipients', text: 'p10@example.org' }, { key: 'toAddresses', text: 'p11@example.org' }]);
  });

  test('two spellings of one name are two fields', () => {
    const f = F.connectorFields('mcp__example_post__send_message', { to: 'a@example.org', TO: 'b@example.org', subject: 's' });
    assert.deepStrictEqual(f.aliases.to.map((o) => o.key), ['to', 'TO']);
  });

  test('a body and an HTML body are both kept', () => {
    const f = F.connectorFields('mcp__example_post__send_message', { to: 'a@example.org', body: 'Hi boss', htmlBody: '<p>evil</p>' });
    assert.deepStrictEqual(f.aliases.body.map((o) => [o.key, o.value]), [['body', 'Hi boss'], ['htmlBody', '<p>evil</p>']]);
  });

  test('a top-level field beside the nested message is read too, under its path', () => {
    const f = F.connectorFields('mcp__example_office__send_mail', { to: 'top@example.org', message: { to: 'nested@example.net', subject: 's' } });
    assert.deepStrictEqual(f.aliases.to.map((o) => [o.key, texts(o.value)]), [['to', ['top@example.org']], ['message.to', ['nested@example.net']]]);
    assert.strictEqual(f.subject, 's');
    assert.deepStrictEqual(f.others, [], 'the nested message is read, not listed');
  });

  test('a summary and a title are both kept', () => {
    const f = F.connectorFields('mcp__example_calendar__create_event', { summary: 'Decoy', title: 'Real' });
    assert.deepStrictEqual(f.aliases.title.map((o) => [o.key, o.value]), [['summary', 'Decoy'], ['title', 'Real']]);
  });

  test('every key the card does not read is listed with its value as text, in order', () => {
    const f = F.connectorFields('mcp__example_post__send_message', { to: 'a@example.org', to_emails: ['evil@example.net'], subject: 's', flags: { urgent: true }, threadId: null });
    assert.deepStrictEqual(f.others, [
      { key: 'to_emails', text: '["evil@example.net"]' }, { key: 'flags', text: '{"urgent": true}' }, { key: 'threadId', text: 'null' },
    ]);
  });

  test('a recognised key holding nothing is not listed, and an entry in a shape the card cannot read is shown as written', () => {
    const f = F.connectorFields('mcp__example_post__send_message', { to: [{ addr: 'evil@example.net' }, 'ok@example.org'], cc: null, subject: 's' });
    assert.deepStrictEqual(f.to, [{ raw: '{"addr": "evil@example.net"}' }, { name: '', address: 'ok@example.org' }]);
    assert.deepStrictEqual(f.others, []);
  });

  test('two different addresses in one entry are shown as written rather than one picked', () => {
    const f = F.connectorFields('mcp__example_post__send_message', { to: [{ email: 'boss@example.org', address: 'evil@example.net' }], subject: 's' });
    assert.deepStrictEqual(f.to, [{ raw: '{"email": "boss@example.org", "address": "evil@example.net"}' }]);
  });

  test('two different texts in one body object are shown as written rather than one picked', () => {
    const f = F.connectorFields('mcp__example_post__send_message', { to: 'a@example.org', body: { content: 'Hi boss', html: '<p>evil</p>' } });
    assert.strictEqual(f.body, '{"content": "Hi boss", "html": "<p>evil</p>"}');
  });

  test('a time object holding two different times, or none the card knows, is shown as written', () => {
    const f = F.connectorFields('mcp__example_calendar__create_event', {
      title: 't', start: { dateTime: '2026-11-03T14:00:00Z', date: '2026-12-25' }, end: { when: 'after lunch' },
    });
    assert.deepStrictEqual(f.start, { raw: '{"dateTime": "2026-11-03T14:00:00Z", "date": "2026-12-25"}' });
    assert.deepStrictEqual(f.end, { raw: '{"when": "after lunch"}' });
  });

  test('a long value is capped, and past a number of fields the rest are counted', () => {
    const input = { to: 'a@example.org', subject: 's', notes: 'z'.repeat(5000) };
    for (let i = 0; i < F.MAX_OTHERS + 5; i++) input[`extra${i}`] = i;
    const f = F.connectorFields('mcp__example_post__send_message', input);
    assert.strictEqual(f.others.length, F.MAX_OTHERS);
    assert.strictEqual(f.othersMore, 6, 'the fields past the cap are counted, not dropped silently');
    assert.ok(f.others[0].text.length <= F.MAX_OTHER_TEXT + 1);
    assert.ok(f.others[0].text.endsWith('…'));
  });

  test('a card with unread fields never says there is nobody', () => {
    const send = F.connectorFields('mcp__example_post__send_message', { to_emails: ['evil@example.net'], subject: 's' });
    assert.doesNotMatch(F.contextFor(send, 'example post'), /No recipients are set/);
    assert.match(F.contextFor(send, 'example post'), /Other fields/);
    const ev = F.connectorFields('mcp__example_calendar__create_event', { title: 't', invitee_list: ['evil@example.net'] });
    assert.doesNotMatch(F.contextFor(ev, 'x'), /No one else is invited/);
    assert.match(F.contextFor(ev, 'x'), /Other fields/);
  });

  test('keys a connector carries on almost every request are listed but never make the card warn', () => {
    const ev = F.connectorFields('mcp__example_calendar__create_event', { calendarId: 'primary', title: 't', timeZone: 'Europe/London' });
    assert.deepStrictEqual(ev.others.map((o) => o.key), ['calendarId', 'timeZone']);
    assert.strictEqual(F.hasUnreadFields(ev), false);
    assert.strictEqual(F.contextFor(ev, 'x'), 'Adds an event to your calendar. No one else is invited.');
    const nested = F.connectorFields('mcp__example_office__reply', { message: { subject: 's', conversationId: 'c' }, messageId: 'm' });
    assert.strictEqual(F.hasUnreadFields(nested), true, 'a key that is not one of them, nested or not, still counts');
    const quiet = F.connectorFields('mcp__example_office__reply', { message: { subject: 's', id: 'c' }, messageId: 'm' });
    assert.strictEqual(F.hasUnreadFields(quiet), false, 'a well-known key under the nested message is quiet too');
  });

  test('every alias counts toward who is reached', () => {
    const ev = F.connectorFields('mcp__example_calendar__create_event', { title: 't', attendees: ['a@example.org'], guests: ['b@example.org', 'a@example.org'] });
    assert.strictEqual(F.contextFor(ev, 'x'), 'Adds an event to your calendar. 2 people will be emailed an invitation.');
    const send = F.connectorFields('mcp__example_post__send_message', { to: [], recipients: ['b@example.org'], subject: 's' });
    assert.doesNotMatch(F.contextFor(send, 'x'), /No recipients/);
  });
});

describe('anything else is left to the card it has today', () => {
  test('a send with neither a body nor email fields', () => {
    assert.strictEqual(F.connectorFields('mcp__example_chat__send_message', { channel: 'general' }), null);
  });
  test('a draft with only a body', () => {
    assert.strictEqual(F.connectorFields('mcp__example_post__create_draft', { body: 'Notes' }), null,
      'a draft that names no one and no subject is left as it was');
  });
  test('an email-shaped write that neither drafts nor sends', () => {
    assert.strictEqual(F.connectorFields('mcp__example_post__compose', { to: 'a@example.org', subject: 's' }), null,
      'a card must not say "Nothing is sent" about an action it cannot name');
  });
  test('a delete, a tool that is not a connector, and input that is not an object', () => {
    assert.strictEqual(F.connectorFields('mcp__example_post__delete_draft', { to: 'a@example.org' }), null);
    assert.strictEqual(F.connectorFields('Write', { to: 'a@example.org', subject: 's' }), null);
    assert.strictEqual(F.connectorFields('mcp__example_post__send_message', null), null);
    assert.strictEqual(F.connectorFields('mcp__example_post__send_message', ['a@example.org']), null);
  });
});

describe('the cut-off rules', () => {
  test('three recipients shown, the rest one click away, a long list stops at five more', () => {
    const list = Array.from({ length: 23 }, (_, i) => `person${String(i + 1).padStart(2, '0')}@example.org`);
    assert.deepStrictEqual(F.cutList(list.slice(0, 3)), { shown: list.slice(0, 3), more: [], rest: 0 });
    assert.deepStrictEqual(F.cutList(list.slice(0, 7)), { shown: list.slice(0, 3), more: list.slice(3, 7), rest: 0 });
    assert.deepStrictEqual(F.cutList(list), { shown: list.slice(0, 3), more: list.slice(3, 8), rest: 15 });
  });

  test('a message shows three lines and says how many more there are', () => {
    const body = ['one', 'two', 'three', 'four', 'five'].join('\n');
    assert.deepStrictEqual(F.cutText(body), { preview: 'one\ntwo\nthree', moreLines: 2, cut: true, full: body, overflow: 0 });
    assert.deepStrictEqual(F.cutText('one\r\ntwo\n\n'), { preview: 'one\ntwo', moreLines: 0, cut: false, full: 'one\ntwo', overflow: 0 },
      'line endings are counted once and trailing blank lines are not lines');
  });

  test('one long line is cut too, because three lines on screen can hold less than it', () => {
    const long = 'word '.repeat(200).trim();
    const c = F.cutText(long);
    assert.strictEqual(c.moreLines, 0);
    assert.strictEqual(c.cut, true, 'Show full message is offered');
  });

  test('a very long value is capped, and the cap is reported rather than hidden', () => {
    const huge = 'x'.repeat(F.MAX_TEXT + 50);
    const c = F.cutText(huge);
    assert.strictEqual(c.full.length, F.MAX_TEXT);
    assert.strictEqual(c.overflow, 50);
    const address = `${'a'.repeat(400)}@example.org`;
    assert.strictEqual(F.connectorFields('mcp__example_post__send', { to: [address] }).to[0].address.length, F.MAX_ADDRESS);
  });
});

describe('what the card says the action does', () => {
  test('a draft names the connector and says nothing is sent', () => {
    const f = F.connectorFields('mcp__example_mail__create_draft', { to: 'a@example.org' });
    assert.strictEqual(F.contextFor(f, 'example mail'), 'Saves a draft in example mail. Nothing is sent.');
  });
  test('a send says it cannot be undone', () => {
    const f = F.connectorFields('mcp__example_post__send_message', { to: 'a@example.org' });
    assert.strictEqual(F.contextFor(f, 'example post'), 'Sends straight away from your account. It cannot be undone, so this always asks.');
  });
  test('a send with nobody to send to says it will probably fail; a reply with no To does not', () => {
    const send = F.connectorFields('mcp__example_post__send_message', { to: [], subject: 'x' });
    assert.match(F.contextFor(send, 'example post'), /No recipients are set, so this will probably fail\.$/);
    const reply = F.connectorFields('mcp__example_post__reply', { subject: 'x' });
    assert.doesNotMatch(F.contextFor(reply, 'example post'), /No recipients/, 'a reply goes back to the thread');
  });
});

describe('a calendar event is read by generic field names', () => {
  test('summary, start and end as objects, attendees as address objects', () => {
    const f = F.connectorFields('mcp__example_calendar__create_event', {
      summary: 'Launch review',
      start: { dateTime: '2026-11-03T14:00:00Z' }, end: { dateTime: '2026-11-03T14:45:00Z' },
      attendees: [{ email: 'sam@example.org' }, { email: 'priya@example.com', displayName: 'Priya' }],
    });
    assert.strictEqual(f.kind, 'event');
    assert.strictEqual(f.action, 'create');
    assert.strictEqual(f.title, 'Launch review');
    assert.deepStrictEqual(texts(f.attendees), ['sam@example.org', 'Priya <priya@example.com>']);
    assert.strictEqual(F.formatWhen(f.start, { timeZone: 'UTC' }), 'Tue 3 Nov 2026, 14:00');
    assert.strictEqual(F.formatWhen(f.start, { timeZone: 'America/New_York' }), 'Tue 3 Nov 2026, 09:00',
      'an instant is shown in the viewer\'s own time');
    assert.strictEqual(F.durationText(f.start, f.end), '45 min');
  });

  test('a subject, wall-clock times with a named zone, and wrapped attendees', () => {
    const f = F.connectorFields('mcp__example_office__createCalendarEvent', {
      subject: 'Budget check-in',
      start: { dateTime: '2026-11-03T09:30:00', timeZone: 'Europe/Paris' },
      end: { dateTime: '2026-11-03T11:00:00', timeZone: 'Europe/Paris' },
      attendees: [{ emailAddress: { address: 'jo@example.net' } }],
    });
    assert.strictEqual(f.title, 'Budget check-in');
    assert.strictEqual(F.formatWhen(f.start), 'Tue 3 Nov 2026, 09:30 (Europe/Paris)',
      'a time written without an offset is shown as written, with the zone it names');
    assert.strictEqual(F.durationText(f.start, f.end), '1 hr 30 min');
    assert.deepStrictEqual(texts(f.attendees), ['jo@example.net']);
  });

  test('flat names: a title, start_time and end_time with offsets, guests as a string', () => {
    const f = F.connectorFields('mcp__example_planner__schedule_meeting', {
      title: 'Planning', start_time: '2026-11-03T14:00:00+01:00', end_time: '2026-11-03T16:00:00+01:00',
      guests: 'sam@example.org, jo@example.net',
    });
    assert.strictEqual(F.formatWhen(f.start, { timeZone: 'UTC' }), 'Tue 3 Nov 2026, 13:00');
    assert.strictEqual(F.durationText(f.start, f.end), '2 hr');
    assert.deepStrictEqual(texts(f.attendees), ['sam@example.org', 'jo@example.net']);
  });

  test('an all-day event, as a date object or a date string', () => {
    const a = F.connectorFields('mcp__example_calendar__insertEvent', { start: { date: '2026-11-04' }, end: '2026-11-04' });
    assert.strictEqual(F.formatWhen(a.start), 'Wed 4 Nov 2026, all day');
    assert.strictEqual(F.formatWhen(a.end), 'Wed 4 Nov 2026, all day');
    assert.strictEqual(F.durationText(a.start, a.end), null, 'no duration is claimed for a day');
  });

  test('epoch times, and a time no one could parse kept as text', () => {
    const f = F.connectorFields('mcp__example_planner__create_event', {
      title: 'x', start: Date.UTC(2026, 10, 3, 14, 0) / 1000, end: 'after lunch on Tuesday',
    });
    assert.strictEqual(F.formatWhen(f.start, { timeZone: 'UTC' }), 'Tue 3 Nov 2026, 14:00', 'seconds since the epoch');
    assert.strictEqual(F.formatWhen(f.end), 'after lunch on Tuesday');
    assert.strictEqual(F.durationText(f.start, f.end), null);
    assert.strictEqual(F.formatWhen(null), null);
  });

  test('an update is a change, and a duration that runs backwards is not shown', () => {
    const f = F.connectorFields('mcp__example_calendar__update_event', {
      summary: 'x', start: '2026-11-03T15:00:00Z', end: '2026-11-03T14:00:00Z',
    });
    assert.strictEqual(f.action, 'update');
    assert.strictEqual(F.durationText(f.start, f.end), null);
  });

  test('not an event: a delete, an answer to an invitation, an event action with no event fields', () => {
    assert.strictEqual(F.connectorFields('mcp__example_calendar__delete_event', { summary: 'x' }), null);
    assert.strictEqual(F.connectorFields('mcp__example_calendar__respond_to_event', { eventId: 'e1', response: 'accepted' }), null);
    assert.strictEqual(F.connectorFields('mcp__example_calendar__create_event', { calendarId: 'primary' }), null);
  });
});

describe('what an event card says', () => {
  const ev = (tool, attendees) => F.connectorFields(tool, { title: 't', attendees });
  test('how many people an invitation is emailed to', () => {
    assert.strictEqual(F.contextFor(ev('mcp__example_calendar__create_event', people4()), 'x'),
      'Adds an event to your calendar. 4 people will be emailed an invitation.');
    assert.strictEqual(F.contextFor(ev('mcp__example_calendar__create_event', ['a@example.org']), 'x'),
      'Adds an event to your calendar. 1 person will be emailed an invitation.');
    assert.strictEqual(F.contextFor(ev('mcp__example_calendar__create_event', []), 'x'),
      'Adds an event to your calendar. No one else is invited.');
    assert.strictEqual(F.contextFor(ev('mcp__example_calendar__update_event', ['a@example.org', 'b@example.org']), 'x'),
      'Changes an event on your calendar. 2 people will be emailed about the change.');
  });
  function people4() { return ['a@example.org', 'b@example.org', 'c@example.org', 'd@example.org']; }
});

// Every value is an agent's, and a value the reader cannot handle must cost
// the card nothing: it is kept as written, never thrown on.
describe('a value the reader cannot handle is kept as written, never thrown on', () => {
  const nest = (depth, wrap, inner) => { let v = inner; for (let i = 0; i < depth; i++) v = wrap(v); return v; };

  test('an epoch too large for a date is kept as written', () => {
    const f = F.connectorFields('mcp__example_calendar__create_event', { title: 't', start: 1e20, end: -1e20 });
    assert.deepStrictEqual(f.start, { raw: '100000000000000000000' });
    assert.strictEqual(F.formatWhen(f.start), '100000000000000000000');
    assert.strictEqual(F.formatWhen(f.end), '-100000000000000000000');
    assert.strictEqual(F.durationText(f.start, f.end), null);
  });

  test('a subject, a body, a recipient and a time nested twenty thousand deep are read without overflowing the stack', () => {
    const f = F.connectorFields('mcp__example_post__send_message', {
      to: [nest(20000, (v) => ({ emailAddress: v }), { address: 'a@example.org' })],
      subject: nest(20000, (v) => ({ content: v }), 'hello'),
      body: nest(20000, (v) => [v], 'text'),
    });
    assert.ok(f.subject.length <= F.MAX_OTHER_TEXT + 1, 'the subject is written out, cut short');
    assert.strictEqual(typeof f.body, 'string');
    assert.notStrictEqual(f.to[0].raw, undefined, 'the recipient is kept as written');
    const e = F.connectorFields('mcp__example_calendar__create_event', { title: 't', start: nest(20000, (v) => ({ dateTime: v }), '2026-11-03T14:00:00Z') });
    assert.notStrictEqual(e.start.raw, undefined);
  });

  test('an impossible date or time is kept as written, never printed as a day that does not exist', () => {
    for (const s of ['2026-13-45', '2026-02-30', '2026-00-10', '2026-11-03T25:00', '2026-11-03T10:61', '2026-02-30T10:00:00Z', '2026-13-01T10:00:00+01:00']) {
      const f = F.connectorFields('mcp__example_calendar__create_event', { title: 't', start: s });
      assert.deepStrictEqual(f.start, { raw: s }, s);
      assert.doesNotMatch(F.formatWhen(f.start), /undefined/, s);
    }
  });

  test('a leap day is a real day', () => {
    const f = F.connectorFields('mcp__example_calendar__create_event', { title: 't', start: '2028-02-29' });
    assert.strictEqual(F.formatWhen(f.start), 'Tue 29 Feb 2028, all day');
  });
});
