'use strict';
// A connector's email or calendar card, rendered by the real card code under
// jsdom.
//
// The card is the consent. A person approving a send has to be able to see who
// it goes to and what it says, and every one of those values was chosen by an
// agent: a subject or an address can carry markup, a right-to-left override or
// a zero-width character. So what is asserted here is what a person sees, read
// back from the DOM, and that no value ever became an element. Every server,
// address and message below is made up.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

let chat, dom;
before(() => {
  dom = new JSDOM('<div id="messages"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.ws = null;
  global.userScrolledUp = false;
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.RundockPermissions = require('../../public/permissions.js');
  global.RundockConnectorFields = require('../../public/connector-fields.js');
  global.RundockChatMarkup = require('../../public/chat-markup.js');
  global.workspaceMode = 'notes';
  chat = require('../../public/views/chat.js');
});
after(() => { if (dom) dom.window.close(); });

let seq = 0;
function render(tool_name, input) {
  document.getElementById('messages').innerHTML = '';
  global.pendingPermissions.clear();
  const id = `req-${++seq}`;
  chat.renderPermissionCard({ request_id: id, request: { tool_name, input } }, 'convo-1');
  return document.getElementById(`perm-${id}`);
}
const text = (el) => (el ? el.textContent : null);
// The rows of the field box as [label, value element] pairs, in order.
function rows(card) {
  const dl = card.querySelector('dl.permission-fields');
  assert.ok(dl, 'the card has a field box');
  return [...dl.querySelectorAll(':scope > dt')].map((dt) => [dt.textContent, dt.nextElementSibling]);
}
const row = (card, label) => (rows(card).find(([l]) => l === label) || [])[1] || null;
// The visible lines of a recipient row: those outside the "+N more" disclosure.
const visibleLines = (dd) => [...dd.querySelectorAll(':scope > .permission-line')].map((n) => n.textContent);
const buttons = (card) => [...card.querySelectorAll('.permission-actions button')].map((b) => b.textContent.trim());

const people = (n, from = 1) => Array.from({ length: n }, (_, i) => `person${String(i + from).padStart(2, '0')}@example.org`);

describe('an email draft card', () => {
  test('shows To, Subject and Message, says nothing is sent, and keeps the tool name at the foot', () => {
    const card = render('mcp__example_mail__create_draft', {
      to: ['sam@example.org'], subject: 'Notes from Thursday', body: 'Hi Sam,\nThanks for Thursday.',
    });
    assert.strictEqual(text(card.querySelector('.permission-context')), 'Saves a draft in example mail. Nothing is sent.');
    assert.deepStrictEqual(rows(card).map(([l]) => l), ['To', 'Subject', 'Message'], 'no Cc or Bcc row when there are none');
    assert.deepStrictEqual(visibleLines(row(card, 'To')), ['sam@example.org']);
    assert.strictEqual(text(row(card, 'Subject')), 'Notes from Thursday');
    assert.strictEqual(text(row(card, 'Message').querySelector('.permission-body')), 'Hi Sam,\nThanks for Thursday.');
    assert.strictEqual(text(card.querySelector('.permission-raw')), 'Tool name: mcp__example_mail__create_draft');
    assert.strictEqual(card.querySelector('code.permission-detail'), null, 'the raw name is a foot line, not the detail block');
    assert.deepStrictEqual(buttons(card), ['Allow', 'Always allow', 'Deny'], 'a draft keeps all three buttons');
  });

  test('a long message shows three lines, how many more, and the whole of it in a box on request', () => {
    const body = ['Hi Sam,', 'line two', 'line three', 'line four', 'line five', 'Best,', 'Alex'].join('\n');
    const card = render('mcp__example_mail__create_draft', { to: 'sam@example.org', subject: 'Notes', body });
    const dd = row(card, 'Message');
    assert.strictEqual(text(dd.querySelector('.permission-body')), 'Hi Sam,\nline two\nline three');
    assert.strictEqual(text(dd.querySelector('.permission-cut')), '… 4 more lines');
    const box = dd.querySelector('details.permission-full');
    assert.ok(box, 'Show full message is there');
    assert.strictEqual(text(box.querySelector('summary')), 'Show full message');
    assert.strictEqual(text(box.querySelector('.permission-full-text')), body);
  });

  test('a short message has nothing to open', () => {
    const card = render('mcp__example_mail__create_draft', { to: 'sam@example.org', subject: 'Notes', body: 'Short note.' });
    assert.strictEqual(card.querySelector('details.permission-full'), null);
    assert.strictEqual(card.querySelector('.permission-cut'), null);
  });

  test('a long subject is clamped, and its whole text is in the full message', () => {
    const subject = 'Follow-up on all three planning sessions, with the open questions on budget, hiring order, office moves and who signs off each item before the year ends';
    const card = render('mcp__example_mail__create_draft', { to: 'sam@example.org', subject, body: 'Short note.' });
    const s = row(card, 'Subject').querySelector('.permission-clamp');
    assert.strictEqual(text(s), subject, 'the whole subject is in the clamped element; the clamp is visual');
    const box = card.querySelector('details.permission-full');
    assert.ok(box, 'Show full message is offered for a subject longer than two lines can hold');
    assert.strictEqual(text(box.querySelector('.permission-full-subject')), subject);
  });

  test('empty fields read as empty, the way they are written on every card', () => {
    const card = render('mcp__example_mail__create_draft', { to: [], subject: '', body: '' });
    assert.strictEqual(text(row(card, 'To')), '(none)');
    assert.strictEqual(text(row(card, 'Subject')), '(no subject)');
    assert.strictEqual(text(row(card, 'Message')), '(empty)');
    assert.ok(row(card, 'To').querySelector('.permission-empty'), 'drawn as an empty value, not as an address');
  });
});

describe('an email send card', () => {
  test('three recipients are shown and the rest are one click away, with Bcc always shown', () => {
    const card = render('mcp__example_post__send_message', {
      to: people(7), bcc: 'records@example.org', subject: 'Revised plan', body: 'See attached.',
    });
    assert.strictEqual(text(card.querySelector('.permission-context')), 'Sends straight away from your account. It cannot be undone, so this always asks.');
    const to = row(card, 'To');
    assert.deepStrictEqual(visibleLines(to), people(3));
    const more = to.querySelector('details.permission-more');
    assert.strictEqual(text(more.querySelector('summary')), '+4 more');
    assert.deepStrictEqual([...more.querySelectorAll('.permission-line')].map((n) => n.textContent), people(4, 4));
    const bcc = row(card, 'Bcc');
    assert.ok(bcc, 'Bcc has its own row');
    assert.deepStrictEqual(visibleLines(bcc), ['records@example.org'], 'and is never folded away');
    assert.deepStrictEqual(rows(card).map(([l]) => l), ['To', 'Bcc', 'Subject', 'Message']);
  });

  test('a very long list opens to five more, then says how many are left', () => {
    const card = render('mcp__example_post__send_message', { to: people(23), subject: 'Quarterly update' });
    const more = row(card, 'To').querySelector('details.permission-more');
    assert.strictEqual(text(more.querySelector('summary')), '+20 more');
    const lines = [...more.querySelectorAll('.permission-line')].map((n) => n.textContent);
    assert.deepStrictEqual(lines, [...people(5, 4), '… and 15 more addresses']);
  });

  test('Cc and Bcc are cut the same way as To', () => {
    const card = render('mcp__example_post__send_message', { to: 'a@example.org', cc: people(5), bcc: people(4, 10), subject: 's' });
    assert.strictEqual(text(row(card, 'Cc').querySelector('summary')), '+2 more');
    assert.strictEqual(text(row(card, 'Bcc').querySelector('summary')), '+1 more');
  });

  test('a send to nobody says it will probably fail', () => {
    const card = render('mcp__example_post__send_message', { to: [], subject: '', body: '' });
    assert.match(text(card.querySelector('.permission-context')), /No recipients are set, so this will probably fail\.$/);
    assert.strictEqual(text(row(card, 'To')), '(none)');
  });
});

describe('every value is text, never markup', () => {
  const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><b>bold</b>';
  const RLO = 'sam@example.org‮gro.elpmaxe@evil';
  const ZW = 'sa​m@exa‍mple.org';

  test('markup in the address, subject and message is shown as the characters it is', () => {
    const card = render('mcp__example_post__send_message', { to: [HOSTILE], subject: HOSTILE, body: HOSTILE });
    for (const tag of ['img', 'script', 'b']) {
      assert.strictEqual(card.querySelectorAll(tag).length, tag === 'b' ? 1 : 0,
        `no ${tag} element was made from a value (the one <b> is the card's own "Tool name:" label)`);
    }
    for (const node of card.querySelectorAll('*')) {
      for (const attr of node.attributes) assert.ok(!/^on/i.test(attr.name), `no ${attr.name} attribute`);
    }
    assert.deepStrictEqual(visibleLines(row(card, 'To')), [HOSTILE]);
    assert.strictEqual(text(row(card, 'Subject')), HOSTILE);
    assert.strictEqual(text(row(card, 'Message').querySelector('.permission-body')), HOSTILE);
    assert.strictEqual(dom.window.__pwned, undefined);
  });

  test('right-to-left overrides and zero-width characters are kept exactly, each address in an element of its own', () => {
    const card = render('mcp__example_post__send_message', { to: [RLO, ZW, 'jo@example.net'], subject: RLO, body: ZW });
    const lines = row(card, 'To').querySelectorAll(':scope > .permission-line');
    assert.deepStrictEqual([...lines].map((n) => n.textContent), [RLO, ZW, 'jo@example.net'],
      'an override cannot run on into the next address, because each is its own block');
    assert.strictEqual(text(row(card, 'Subject')), RLO);
    assert.strictEqual(text(row(card, 'Message').querySelector('.permission-body')), ZW);
  });

  test('a very long subject and message are capped, and the cap is said', () => {
    const F = global.RundockConnectorFields;
    const huge = 'y'.repeat(F.MAX_TEXT + 1234);
    const card = render('mcp__example_post__send_message', { to: 'a@example.org', subject: huge, body: huge });
    const full = text(card.querySelector('.permission-full-text'));
    assert.ok(full.endsWith('… (1234 more characters)'), 'the full box says how much was left out');
    assert.ok(full.length < F.MAX_TEXT * 2 + 100, 'the box holds the capped values, not everything sent');
    assert.strictEqual(text(row(card, 'Subject')).length, F.MAX_TEXT);
  });
});

describe('a connector card with no email or calendar fields', () => {
  test('is drawn as it was, with the raw name in the detail block', () => {
    const card = render('mcp__example_chat__send_message', { channel: 'general', text: 'hello' });
    assert.strictEqual(card.querySelector('dl.permission-fields'), null);
    assert.strictEqual(text(card.querySelector('code.permission-detail')), 'mcp__example_chat__send_message');
  });
});

describe('a calendar event card', () => {
  test('shows title, start, end with its length, and attendees, and says invitations are emailed', () => {
    const card = render('mcp__example_calendar__create_event', {
      summary: 'Launch review',
      start: { dateTime: '2026-11-03T14:00:00', timeZone: 'Europe/Paris' },
      end: { dateTime: '2026-11-03T14:45:00', timeZone: 'Europe/Paris' },
      attendees: people(4).map((email) => ({ email })),
    });
    assert.strictEqual(text(card.querySelector('.permission-context')), 'Adds an event to your calendar. 4 people will be emailed an invitation.');
    assert.deepStrictEqual(rows(card).map(([l]) => l), ['Title', 'Starts', 'Ends', 'Attendees']);
    assert.strictEqual(text(row(card, 'Title')), 'Launch review');
    assert.strictEqual(text(row(card, 'Starts')), 'Tue 3 Nov 2026, 14:00 (Europe/Paris)');
    assert.strictEqual(text(row(card, 'Ends')), 'Tue 3 Nov 2026, 14:45 (Europe/Paris) (45 min)');
    assert.strictEqual(text(row(card, 'Ends').querySelector('.permission-cut')), '(45 min)');
    assert.deepStrictEqual(visibleLines(row(card, 'Attendees')), people(3));
    assert.strictEqual(text(row(card, 'Attendees').querySelector('summary')), '+1 more');
    assert.strictEqual(text(card.querySelector('.permission-raw')), 'Tool name: mcp__example_calendar__create_event');
    assert.deepStrictEqual(buttons(card), ['Allow', 'Always allow', 'Deny'], 'an invitation keeps today\'s grading');
  });

  test('no title, all day, nobody else invited', () => {
    const card = render('mcp__example_calendar__insertEvent', { start: { date: '2026-11-04' }, end: { date: '2026-11-04' } });
    assert.strictEqual(text(card.querySelector('.permission-context')), 'Adds an event to your calendar. No one else is invited.');
    assert.strictEqual(text(row(card, 'Title')), '(untitled)');
    assert.strictEqual(text(row(card, 'Starts')), 'Wed 4 Nov 2026, all day');
    assert.strictEqual(text(row(card, 'Attendees')), 'Just you');
  });

  test('a missing time says so rather than leaving a gap', () => {
    const card = render('mcp__example_calendar__create_event', { summary: 'Planning' });
    assert.strictEqual(text(row(card, 'Starts')), '(not set)');
    assert.strictEqual(text(row(card, 'Ends')), '(not set)');
  });

  test('a long title is clamped and can be read in full', () => {
    const title = 'Quarterly planning across every team, covering budgets, hiring plans, office moves, supplier reviews and the open questions from last time';
    const card = render('mcp__example_calendar__create_event', { title });
    assert.strictEqual(text(row(card, 'Title').querySelector('.permission-clamp')), title);
    const box = row(card, 'Title').querySelector('details.permission-full');
    assert.strictEqual(text(box.querySelector('summary')), 'Show full title');
    assert.strictEqual(text(box.querySelector('.permission-full-text')), title);
  });

  test('a title and an attendee carrying markup stay text', () => {
    const hostile = '<img src=x onerror="window.__pwned=3">';
    const card = render('mcp__example_calendar__create_event', { title: hostile, attendees: [hostile], start: hostile });
    assert.strictEqual(card.querySelectorAll('img').length, 0);
    assert.strictEqual(text(row(card, 'Title')), hostile);
    assert.deepStrictEqual(visibleLines(row(card, 'Attendees')), [hostile]);
    assert.strictEqual(text(row(card, 'Starts')), hostile, 'an unreadable time is shown as written, as text');
  });
});

describe('a connector send asks every time, and its card says so', () => {
  // The look of every card that always asks: "Allow once" as an outline beside
  // Deny, and no Always allow, because no saved answer ever covers it.
  for (const tool of ['mcp__example_post__send_message', 'mcp__example_post__replyToThread', 'mcp__example_post__forward_email']) {
    test(`${tool.split('__')[2]}: Allow once and Deny, nothing to remember`, () => {
      const card = render(tool, { to: 'sam@example.org', subject: 's', body: 'b' });
      assert.deepStrictEqual(buttons(card), ['Allow once', 'Deny']);
      const allow = card.querySelector('[data-perm-action="allow"]');
      assert.ok(allow.classList.contains('btn-allow-once'), 'the outline, not the solid everyday Allow');
      assert.ok(!allow.classList.contains('btn-allow'));
      assert.strictEqual(card.querySelector('[data-perm-action="always"]'), null);
      assert.ok(card.querySelector('.permission-card').classList.contains('risk-high'));
    });
  }

  test('a send with no email fields asks the same way', () => {
    const card = render('mcp__example_chat__send_message', { channel: 'general', text: 'hello' });
    assert.deepStrictEqual(buttons(card), ['Allow once', 'Deny']);
  });

  test('a draft and an invitation keep the everyday Allow and Always allow', () => {
    assert.deepStrictEqual(buttons(render('mcp__example_post__create_draft', { to: 'a@example.org' })), ['Allow', 'Always allow', 'Deny']);
    assert.deepStrictEqual(buttons(render('mcp__example_calendar__create_event', { title: 't', attendees: ['a@example.org'] })), ['Allow', 'Always allow', 'Deny']);
  });
});
