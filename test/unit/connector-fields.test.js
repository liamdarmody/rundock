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

describe('an email request is read by generic field names', () => {
  test('flat fields, recipients as a comma-separated string', () => {
    const f = F.connectorFields('mcp__example_post__send_message', {
      to: 'sam@example.org, priya@example.com; jo@example.net', cc: 'lee@example.org',
      subject: 'Venue for the 14th', body: 'Hi Sam,\nSee you then.',
    });
    assert.deepStrictEqual(f, {
      kind: 'email', action: 'send',
      to: ['sam@example.org', 'priya@example.com', 'jo@example.net'], cc: ['lee@example.org'], bcc: [],
      subject: 'Venue for the 14th', body: 'Hi Sam,\nSee you then.',
    });
  });

  test('arrays of address objects, named and unnamed, and the body under `text`', () => {
    const f = F.connectorFields('mcp__example_mail__createDraft', {
      recipients: [{ email: 'sam@example.org', name: 'Sam Rivera' }, { address: 'jo@example.net' }, 'lee@example.org'],
      bcc_recipients: [{ email: 'records@example.org' }],
      Subject: 'Notes', text: 'Short note.',
    });
    assert.strictEqual(f.action, 'draft');
    assert.deepStrictEqual(f.to, ['Sam Rivera <sam@example.org>', 'jo@example.net', 'lee@example.org']);
    assert.deepStrictEqual(f.bcc, ['records@example.org']);
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
    assert.deepStrictEqual(f.to, ['Sam <sam@example.org>']);
    assert.deepStrictEqual(f.cc, ['priya@example.com']);
    assert.strictEqual(f.body, 'Agreed.');
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
    assert.deepStrictEqual(f, { kind: 'email', action: 'draft', to: [], cc: [], bcc: [], subject: '', body: '' });
  });
});

describe('anything else is left to the card it has today', () => {
  test('a chat send has no email fields', () => {
    assert.strictEqual(F.connectorFields('mcp__example_chat__send_message', { channel: 'general', text: 'hello' }), null);
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
    assert.strictEqual(F.connectorFields('mcp__example_post__send', { to: [address] }).to[0].length, F.MAX_ADDRESS);
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
    assert.deepStrictEqual(f.attendees, ['sam@example.org', 'Priya <priya@example.com>']);
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
    assert.deepStrictEqual(f.attendees, ['jo@example.net']);
  });

  test('flat names: a title, start_time and end_time with offsets, guests as a string', () => {
    const f = F.connectorFields('mcp__example_planner__schedule_meeting', {
      title: 'Planning', start_time: '2026-11-03T14:00:00+01:00', end_time: '2026-11-03T16:00:00+01:00',
      guests: 'sam@example.org, jo@example.net',
    });
    assert.strictEqual(F.formatWhen(f.start, { timeZone: 'UTC' }), 'Tue 3 Nov 2026, 13:00');
    assert.strictEqual(F.durationText(f.start, f.end), '2 hr');
    assert.deepStrictEqual(f.attendees, ['sam@example.org', 'jo@example.net']);
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
