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
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// The approvals dock exactly as index.html declares it.
const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf-8');
const dockMarkup = () => new JSDOM(INDEX_SRC).window.document.getElementById('approvals-dock').outerHTML;

let chat, dom;
before(() => {
  dom = new JSDOM(`<div id="messages"></div>${dockMarkup()}`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.activeConversation = { id: 'convo-1' };
  global.unread = { markPermission: () => {}, resolvePermission: () => {} };
  global.updateUnreadBadge = () => {};
  global.renderConvoList = () => {};
  global.agents = [];
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

  test('Cc is cut the same way as To, and Bcc is shown whole', () => {
    const card = render('mcp__example_post__send_message', { to: 'a@example.org', cc: people(5), bcc: people(4, 10), subject: 's' });
    assert.strictEqual(text(row(card, 'Cc').querySelector('summary')), '+2 more');
    assert.strictEqual(row(card, 'Bcc').querySelector('details'), null, 'nobody a message is copied to in secret is folded away');
    assert.deepStrictEqual(visibleLines(row(card, 'Bcc')), people(4, 10));
  });

  test('a long Bcc list is shown whole, not behind +N more', () => {
    const card = render('mcp__example_post__send_message', { to: 'a@example.org', bcc: people(23), subject: 's' });
    assert.strictEqual(row(card, 'Bcc').querySelector('details'), null);
    assert.deepStrictEqual(visibleLines(row(card, 'Bcc')), people(23));
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
    assert.strictEqual(text(row(card, 'Subject').querySelector('.permission-clamp')).length, F.MAX_TEXT);
  });
});

describe('a connector card with no email or calendar fields', () => {
  test('is drawn as it was, with the raw name in the detail block', () => {
    const card = render('mcp__example_chat__add_reaction', { channel: 'general', emoji: 'thumbsup' });
    assert.strictEqual(card.querySelector('dl.permission-fields'), null);
    assert.strictEqual(text(card.querySelector('code.permission-detail')), 'mcp__example_chat__add_reaction');
  });
});

describe('a send, reply or forward with only a body', () => {
  test('a reply with a thread id and a body shows what it says', () => {
    const card = render('mcp__example_post__reply_to_thread', { threadId: 't1', body: 'Sounds good, see you then.' });
    assert.ok(card.querySelector('dl.permission-fields'), 'the field card, not the plain one');
    assert.strictEqual(text(row(card, 'Message').querySelector('.permission-body')), 'Sounds good, see you then.');
    assert.strictEqual(text(row(card, 'To')), '(none)', 'a thread id is not who it reaches, so no warning');
    assert.strictEqual(text(row(card, 'Other fields')), 'threadId: t1');
  });

  test('a chat message shows its text, and its channel is listed as a field the card does not read', () => {
    const card = render('mcp__example_chat__send_message', { channel: 'general', text: 'hello' });
    assert.strictEqual(text(row(card, 'Message').querySelector('.permission-body')), 'hello');
    assert.strictEqual(text(row(card, 'Other fields')), 'channel: general');
    assert.match(text(row(card, 'To')), /Not recognised: see Other fields/, 'who it reaches is under a name the card does not know');
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

// A field card takes the place of the raw request, so anything it leaves out
// is something a person approves without seeing. Each case below is a request
// a service could act on differently from what a card reading one field would
// show: a second recipient list, a second body, a top-level field beside the
// nested message, a second title, and fields under names or in shapes the
// card does not know.
describe('a card shows every field it is given, so nothing it acts on is hidden', () => {
  const labels = (card) => rows(card).map(([l]) => l);
  const contextText = (card) => text(card.querySelector('.permission-context'));
  const otherLines = (card) => [...row(card, 'Other fields').querySelectorAll(':scope > .permission-line')];

  test('two recipient fields: each is its own row, under its real key', () => {
    const card = render('mcp__example_post__send_message', { to: 'boss@example.org', recipients: ['evil@example.net'], subject: 's', body: 'b' });
    assert.deepStrictEqual(labels(card), ['to', 'recipients', 'Subject', 'Message']);
    assert.deepStrictEqual(visibleLines(row(card, 'to')), ['boss@example.org']);
    assert.deepStrictEqual(visibleLines(row(card, 'recipients')), ['evil@example.net']);
  });

  test('a field under more than ten names: ten rows, and the rest under Other fields', () => {
    const names = ['to', 'To', 'TO', 'tO', 'recipients', 'Recipients', 'RECIPIENTS', 'recipient', 'Recipient', 'toRecipients', 'to_recipients', 'toAddresses'];
    const input = { subject: 's', body: 'b' };
    names.forEach((k, i) => { input[k] = `p${i}@example.org`; });
    const card = render('mcp__example_post__send_message', input);
    assert.deepStrictEqual(labels(card), [...names.slice(0, 10), 'Subject', 'Message', 'Other fields']);
    assert.deepStrictEqual(otherLines(card).map((n) => n.textContent), ['to_recipients: p10@example.org', 'toAddresses: p11@example.org']);
    assert.match(contextText(card), /more fields than the card shows at once/, 'and the card says some are listed apart');
  });

  test('recipients past both caps: reachable in a disclosure under Other fields, and the card says fields are folded', () => {
    const input = { subject: 's', body: 'b' };
    for (let i = 0; i < 40; i++) input[`to${'_'.repeat(i)}`] = `ok${i}@example.org`;
    input.recipients = ['evil@example.net'];
    const card = render('mcp__example_post__send_message', input);
    const F = global.RundockConnectorFields;
    const other = row(card, 'Other fields');
    assert.strictEqual(other.querySelectorAll(':scope > .permission-line').length, F.MAX_OTHERS, 'the first ones shown');
    const more = other.querySelector(':scope > details.permission-more');
    assert.ok(more, 'the rest one click away');
    assert.strictEqual(text(more.querySelector('summary')), '+6 more fields');
    const folded = [...more.querySelectorAll('.permission-line')].map((n) => n.textContent);
    assert.ok(folded.includes('recipients: ["evil@example.net"]'), `the last recipient is reachable: ${JSON.stringify(folded)}`);
    assert.match(contextText(card), /more fields than the card shows at once: open Other fields and check every one before allowing\./);
  });

  test('past the overall cap the disclosure says how many fields are not shown', () => {
    const F = global.RundockConnectorFields;
    const input = { to: 'a@example.org', subject: 's' };
    for (let i = 0; i < F.MAX_LISTED + 7; i++) input[`extra${i}`] = i;
    const card = render('mcp__example_post__send_message', input);
    const more = row(card, 'Other fields').querySelector(':scope > details.permission-more');
    const lines = [...more.querySelectorAll('.permission-line')].map((n) => n.textContent);
    assert.strictEqual(lines.length, F.MAX_LISTED - F.MAX_OTHERS + 1);
    assert.strictEqual(lines.at(-1), '… and 7 more fields not shown');
  });

  test('two bodies: both are shown, each under its real key', () => {
    const card = render('mcp__example_post__send_message', {
      to: 'sam@example.org', subject: 's', body: 'Hi boss', htmlBody: '<p>Pay the invoice to evil@example.net</p>',
    });
    assert.deepStrictEqual(labels(card), ['To', 'Subject', 'body', 'htmlBody']);
    assert.strictEqual(text(row(card, 'body').querySelector('.permission-body')), 'Hi boss');
    assert.strictEqual(text(row(card, 'htmlBody').querySelector('.permission-body')), '<p>Pay the invoice to evil@example.net</p>');
    assert.strictEqual(card.querySelectorAll('p').length, 0, 'and still text');
  });

  test('a top-level recipient beside the nested message: both are shown, each under its path', () => {
    const card = render('mcp__example_office__send_mail', { to: 'top@example.org', message: { to: 'nested@example.net', subject: 's', body: 'b' } });
    assert.deepStrictEqual(labels(card), ['to', 'message.to', 'Subject', 'Message']);
    assert.deepStrictEqual(visibleLines(row(card, 'to')), ['top@example.org']);
    assert.deepStrictEqual(visibleLines(row(card, 'message.to')), ['nested@example.net']);
  });

  test('a summary beside a title: both are shown', () => {
    const card = render('mcp__example_calendar__create_event', { summary: 'Team lunch', title: 'Board offsite', start: '2026-11-03T12:00:00Z' });
    assert.deepStrictEqual(labels(card), ['summary', 'title', 'Starts', 'Ends', 'Attendees']);
    assert.strictEqual(text(row(card, 'summary')), 'Team lunch');
    assert.strictEqual(text(row(card, 'title')), 'Board offsite');
  });

  test('recipients under a key the card does not know: listed under Other fields, and never called none', () => {
    const card = render('mcp__example_post__send_message', { to_emails: ['evil@example.net'], subject: 'Invoice', body: 'Attached.' });
    assert.doesNotMatch(contextText(card), /No recipients are set/);
    assert.doesNotMatch(text(row(card, 'To')), /\(none\)/);
    assert.match(text(row(card, 'To')), /Other fields/);
    assert.deepStrictEqual(otherLines(card).map((n) => n.textContent), ['to_emails: ["evil@example.net"]']);
  });

  test('recipients in a shape the card cannot read are shown as written, never dropped', () => {
    const card = render('mcp__example_post__send_message', { to: [{ addr: 'evil@example.net' }], subject: 's', body: 'b' });
    assert.deepStrictEqual(visibleLines(row(card, 'To')), ['{"addr": "evil@example.net"}']);
    assert.doesNotMatch(contextText(card), /No recipients are set/);
  });

  test('attendees under a key the card does not know: never "Just you" or "No one else is invited"', () => {
    const card = render('mcp__example_calendar__create_event', { title: 'Sync', start: '2026-11-03T12:00:00Z', invitee_list: ['evil@example.net'] });
    assert.doesNotMatch(contextText(card), /No one else is invited/);
    assert.notStrictEqual(text(row(card, 'Attendees')), 'Just you');
    assert.match(text(row(card, 'Attendees')), /Other fields/);
    assert.deepStrictEqual(otherLines(card).map((n) => n.textContent), ['invitee_list: ["evil@example.net"]']);
  });

  test('each other field is a block of its own, its key and value as text, a long value capped', () => {
    const card = render('mcp__example_post__send_message', {
      to: 'a@example.org', subject: 's', body: 'b', threadId: '<b>t1</b>', notes: 'z'.repeat(5000), flags: { urgent: true },
    });
    const lines = otherLines(card);
    assert.deepStrictEqual(lines.map((n) => n.querySelector('.permission-other-key').textContent), ['threadId', 'notes', 'flags']);
    assert.strictEqual(lines[0].textContent, 'threadId: <b>t1</b>');
    assert.strictEqual(card.querySelectorAll('b').length, 1, 'no element was made from a value (the one <b> is the card\'s own "Tool name:" label)');
    assert.ok(lines[1].textContent.length < 400, 'a long value is capped');
    assert.ok(lines[1].textContent.endsWith('…'), 'and says so');
    assert.strictEqual(lines[2].textContent, 'flags: {"urgent": true}');
  });

  test('a card whose every field is recognised has no Other fields row, and keeps its usual words', () => {
    const card = render('mcp__example_post__send_message', { to: [], subject: '', body: '' });
    assert.strictEqual(row(card, 'Other fields'), null);
    assert.strictEqual(text(row(card, 'To')), '(none)');
    assert.match(contextText(card), /No recipients are set/);
  });

  test('a name and its address are isolated from each other, so an override in the name cannot reorder the address', () => {
    const name = 'Sam ‮ten.live';
    const card = render('mcp__example_post__send_message', { to: [{ name, email: 'sam@example.org' }], subject: 's', body: 'b' });
    const line = row(card, 'To').querySelector(':scope > .permission-line');
    const n = line.querySelector('bdi.permission-name');
    const a = line.querySelector('bdi.permission-address');
    assert.ok(n && a, 'the name and the address each sit in an isolate of their own');
    assert.strictEqual(n.textContent, name);
    assert.strictEqual(a.textContent, 'sam@example.org');
    assert.ok(!n.contains(a) && !a.contains(n), 'neither isolate holds the other');
    assert.strictEqual(line.textContent, `${name} <sam@example.org>`);
  });
});

// A card that is not drawn is a decision the person never gets to make, and a
// throw while drawing one also stops every card queued after it and leaves the
// approvals dock uncounted.
describe('a value the card cannot read never stops it drawing', () => {
  const F = () => global.RundockConnectorFields;
  // Replace one function of the field model for the length of `run`.
  function swapped(name, fn, run) {
    const was = F()[name];
    F()[name] = fn;
    try { return run(); } finally { F()[name] = was; }
  }
  const plain = (card, tool) => {
    assert.ok(card, 'a card is drawn');
    assert.strictEqual(card.querySelector('dl.permission-fields'), null, 'without the field box');
    assert.strictEqual(text(card.querySelector('code.permission-detail')), tool, 'the plain card, the raw name in its detail block');
    assert.ok(card.querySelector('[data-perm-action="deny"]'), 'and it can be answered');
  };

  test('an epoch too large for a date: the card draws, the time as written', () => {
    const card = render('mcp__example_calendar__create_event', { title: 'Sync', start: 1e20 });
    assert.ok(card, 'a card is drawn');
    assert.strictEqual(text(row(card, 'Starts')), '100000000000000000000');
  });

  test('a subject nested twenty thousand deep: the card draws', () => {
    let subject = 'hello';
    for (let i = 0; i < 20000; i++) subject = { content: subject };
    const card = render('mcp__example_post__send_message', { to: 'a@example.org', subject, body: 'b' });
    assert.ok(card, 'a card is drawn');
    assert.ok(row(card, 'Subject'), 'with its fields');
  });

  test('an impossible date: the card says what was sent, never "undefined"', () => {
    const card = render('mcp__example_calendar__create_event', { title: 'Sync', start: '2026-13-45' });
    assert.strictEqual(text(row(card, 'Starts')), '2026-13-45');
  });

  test('the field reader throws: the plain card is drawn', () => {
    const tool = 'mcp__example_post__send_message';
    const card = swapped('connectorFields', () => { throw new RangeError('boom'); }, () => render(tool, { to: 'a@example.org', subject: 's' }));
    plain(card, tool);
    assert.deepStrictEqual(buttons(card), ['Allow once', 'Deny'], 'and a send still asks every time');
  });

  test('drawing the fields throws: the plain card is drawn', () => {
    const tool = 'mcp__example_post__send_message';
    const card = swapped('cutText', () => { throw new RangeError('boom'); }, () => render(tool, { to: 'a@example.org', subject: 's', body: 'b' }));
    plain(card, tool);
    assert.doesNotMatch(text(card.querySelector('.permission-context')) || '', /Sends straight away/, 'no sentence from a field box that was not drawn');
  });

  test('a card that fails does not stop the cards queued after it', () => {
    const real = F().connectorFields;
    const req = (id, input) => ({ request_id: id, request: { tool_name: 'mcp__example_post__send_message', input } });
    document.getElementById('messages').innerHTML = '';
    global.activeConversation = { id: 'convo-1' };
    chat.handlePermissionRequest(req('queued-bad', { to: 'a@example.org', subject: 'bad' }), 'convo-bg');
    chat.handlePermissionRequest(req('queued-good', { to: 'b@example.org', subject: 'good' }), 'convo-bg');
    assert.strictEqual(document.getElementById('perm-queued-bad'), null, 'queued while its conversation is in the background');
    global.activeConversation = { id: 'convo-bg' };
    try {
      swapped('connectorFields', (t, input) => { if (input.subject === 'bad') throw new RangeError('boom'); return real(t, input); },
        () => chat.renderPendingPermissionCards('convo-bg'));
    } finally { global.activeConversation = { id: 'convo-1' }; }
    plain(document.getElementById('perm-queued-bad'), 'mcp__example_post__send_message');
    assert.ok(document.getElementById('perm-queued-good').querySelector('dl.permission-fields'), 'the next card is drawn, with its fields');
  });

  test('a dock card that fails is still drawn, and the dock counts it', () => {
    const tool = 'mcp__example_post__send_message';
    document.querySelector('.approvals-dock-list').innerHTML = '';
    swapped('connectorFields', () => { throw new RangeError('boom'); },
      () => chat.handleOwnerlessPermissionRequest({ request_id: 'dock-bad', request: { tool_name: tool, input: { to: 'a@example.org', subject: 's' } } }));
    plain(document.querySelector('#approvals-dock #perm-dock-bad'), tool);
    assert.strictEqual(document.getElementById('approvals-dock').hidden, false, 'the dock shows itself');
    assert.match(document.querySelector('.approvals-dock-count').textContent, /1 waiting/);
  });
});

// The thresholds for "Show full …" hold in a card the width of the thread. In
// the 440px approvals dock a shorter body or subject is clamped too, and text
// cut short with nothing to open it is text a person approves unread. jsdom
// lays nothing out, so a browser's measurements are stubbed: a preview that
// holds more than its lines show reports a taller scroll height.
describe('a value the browser cuts short can always be opened', () => {
  const tool = 'mcp__example_post__send_message';
  const isPreview = (el) => el.classList.contains('permission-body') || el.classList.contains('permission-clamp');
  function measured(cut, run) {
    const proto = dom.window.HTMLElement.prototype;
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return cut(this) ? 120 : 40; } });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return 40; } });
    try { return run(); } finally { delete proto.scrollHeight; delete proto.clientHeight; }
  }
  const boxIn = (dd) => dd.querySelector(':scope > details.permission-full');

  test('a body under the thresholds that the browser cuts gets Show full message', () => {
    const body = 'word '.repeat(40).trim();
    assert.ok(body.length < 300 && !body.includes('\n'), 'under both thresholds');
    const card = measured(isPreview, () => render(tool, { to: 'a@example.org', subject: 's', body }));
    const box = boxIn(row(card, 'Message'));
    assert.ok(box, 'the whole message can be opened');
    assert.strictEqual(text(box.querySelector('summary')), 'Show full message');
    assert.strictEqual(text(box.querySelector('.permission-full-text')), body);
  });

  test('a subject under the threshold that the browser cuts gets Show full subject', () => {
    const subject = 'Quarterly numbers for the board, with the hiring plan and the open budget questions';
    assert.ok(subject.length < 120);
    const card = measured(isPreview, () => render(tool, { to: 'a@example.org', subject, body: 'b' }));
    const box = boxIn(row(card, 'Subject'));
    assert.ok(box);
    assert.strictEqual(text(box.querySelector('summary')), 'Show full subject');
    assert.strictEqual(text(box.querySelector('.permission-full-subject')), subject);
  });

  test('a title the browser cuts gets Show full title', () => {
    const card = measured(isPreview, () => render('mcp__example_calendar__create_event', { title: 'Planning across every team for next year' }));
    const box = boxIn(row(card, 'Title'));
    assert.ok(box);
    assert.strictEqual(text(box.querySelector('summary')), 'Show full title');
    assert.strictEqual(text(box.querySelector('.permission-full-text')), 'Planning across every team for next year');
  });

  test('nothing cut, nothing to open', () => {
    const card = measured(() => false, () => render(tool, { to: 'a@example.org', subject: 'Short', body: 'Short.' }));
    assert.strictEqual(card.querySelector('details.permission-full'), null);
  });

  test('a card drawn while the dock was hidden is measured again once the dock shows', () => {
    const dock = document.getElementById('approvals-dock');
    document.querySelector('.approvals-dock-list').innerHTML = '';
    dock.hidden = true;
    const body = 'word '.repeat(40).trim();
    // A hidden element measures nothing, so a preview reads as cut only once
    // the dock is shown.
    measured((el) => isPreview(el) && !dock.hidden,
      () => chat.handleOwnerlessPermissionRequest({ request_id: 'dock-cut', request: { tool_name: tool, input: { to: 'a@example.org', subject: 's', body } } }));
    assert.strictEqual(dock.hidden, false);
    const card = document.getElementById('perm-dock-cut');
    assert.ok(boxIn(row(card, 'Message')), 'the box is there once the dock can measure it');
  });
});

// A warning on every card is a warning nobody reads. Keys a connector carries
// on almost every request (an id, a calendar, a time zone, a description) are
// still listed under Other fields, but they cannot hide who a request reaches,
// so they never turn the card's words into a warning; and the warning is only
// ever on the rows of who is reached.
describe('the unread-field warning is kept for who a request reaches', () => {
  const contextText = (card) => text(card.querySelector('.permission-context'));
  const otherKeys = (card) => [...row(card, 'Other fields').querySelectorAll(':scope > .permission-line .permission-other-key')].map((n) => n.textContent);

  test('a plain event with its calendar and time zone reads normally, and still lists them', () => {
    const card = render('mcp__example_calendar__create_event', { calendarId: 'primary', title: 'Sync', start: '2026-11-03T12:00:00Z', timeZone: 'Europe/London' });
    assert.strictEqual(contextText(card), 'Adds an event to your calendar. No one else is invited.');
    assert.strictEqual(text(row(card, 'Attendees')), 'Just you');
    assert.strictEqual(text(row(card, 'Ends')), '(not set)');
    assert.deepStrictEqual(otherKeys(card), ['calendarId', 'timeZone']);
  });

  test('a draft with its id reads normally', () => {
    const card = render('mcp__example_mail__update_draft', { draftId: 'd1', to: 'sam@example.org', body: 'Hi' });
    assert.strictEqual(contextText(card), 'Saves a draft in example mail. Nothing is sent.');
    assert.strictEqual(text(row(card, 'Subject')), '(no subject)');
    assert.deepStrictEqual(otherKeys(card), ['draftId']);
  });

  test('every well-known key is quiet: a send with only those and nobody to send to says so plainly', () => {
    const card = render('mcp__example_post__send_message', {
      id: '1', threadId: 't', messageId: 'm', draftId: 'd', calendarId: 'c', eventId: 'e', time_zone: 'UTC', description: 'x', location: 'y', subject: 's',
    });
    assert.strictEqual(text(row(card, 'To')), '(none)');
    assert.match(contextText(card), /No recipients are set, so this will probably fail\.$/);
    assert.strictEqual(otherKeys(card).length, 9, 'and all of them are listed');
  });

  test('an unknown recipient key still warns, on the recipient row and in the sentence only', () => {
    const card = render('mcp__example_post__send_message', { to_emails: ['evil@example.net'], subject: '', body: '' });
    assert.match(text(row(card, 'To')), /Not recognised: see Other fields/);
    assert.match(contextText(card), /No recipients were recognised/);
    assert.strictEqual(text(row(card, 'Subject')), '(no subject)');
    assert.strictEqual(text(row(card, 'Message')), '(empty)');
  });

  test('an unknown attendee key still warns, on the attendee row and in the sentence only', () => {
    const card = render('mcp__example_calendar__create_event', { invitee_list: ['evil@example.net'], start: '2026-11-03T12:00:00Z' });
    assert.match(text(row(card, 'Attendees')), /Not recognised: see Other fields/);
    assert.match(contextText(card), /Check Other fields for anyone it invites/);
    assert.strictEqual(text(row(card, 'Title')), '(untitled)');
    assert.strictEqual(text(row(card, 'Ends')), '(not set)');
  });
});

// A card drawn while the chat is not on screen (the person is in Files or
// Settings when a send arrives) measures nothing, and a window made narrower
// can clamp a value that fitted. Both change the size of the host the card is
// in, so a host is watched for that. The browser's ResizeObserver and its
// measurements are stubbed: jsdom has neither.
describe('a card is measured again when its host is shown or resized', () => {
  const tool = 'mcp__example_post__send_message';
  const body = 'word '.repeat(40).trim();
  const isPreview = (el) => el.classList.contains('permission-body') || el.classList.contains('permission-clamp');
  function measured(cut, run) {
    const proto = dom.window.HTMLElement.prototype;
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return cut(this) ? 120 : 40; } });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return 40; } });
    try { return run(); } finally { delete proto.scrollHeight; delete proto.clientHeight; }
  }
  const boxIn = (dd) => dd.querySelector(':scope > details.permission-full');
  let watchers;
  before(() => {
    watchers = [];
    global.ResizeObserver = class {
      constructor(cb) { this.cb = cb; this.targets = []; watchers.push(this); }
      observe(t) { this.targets.push(t); }
      unobserve() {}
      disconnect() {}
    };
  });
  after(() => { delete global.ResizeObserver; });
  // The browser saying a watched element changed size.
  const resized = (target) => { for (const w of watchers) if (w.targets.includes(target)) w.cb([{ target }]); };

  test('a card drawn while the chat was hidden gets its box when the chat is shown', () => {
    const card = measured(() => false, () => render(tool, { to: 'a@example.org', subject: 's', body }));
    assert.strictEqual(boxIn(row(card, 'Message')), null, 'hidden, it measured nothing');
    measured(isPreview, () => resized(document.getElementById('messages')));
    assert.ok(boxIn(row(card, 'Message')), 'shown, it is measured again and can be opened');
  });

  test('a card that fitted gets its box when the window is made narrower', () => {
    const card = measured(() => false, () => render(tool, { to: 'a@example.org', subject: 'A subject that fits on two lines at this width', body: 'b' }));
    assert.strictEqual(boxIn(row(card, 'Subject')), null);
    measured(isPreview, () => resized(document.getElementById('messages')));
    assert.ok(boxIn(row(card, 'Subject')));
  });

  test('a dock card gets its box when the dock is resized', () => {
    const dock = document.getElementById('approvals-dock');
    const list = document.querySelector('.approvals-dock-list');
    list.innerHTML = '';
    measured(() => false, () => chat.handleOwnerlessPermissionRequest({ request_id: 'dock-resized', request: { tool_name: tool, input: { to: 'a@example.org', subject: 's', body } } }));
    assert.strictEqual(dock.hidden, false);
    const card = document.getElementById('perm-dock-resized');
    assert.strictEqual(boxIn(row(card, 'Message')), null);
    measured(isPreview, () => resized(list));
    assert.ok(boxIn(row(card, 'Message')));
  });
});
