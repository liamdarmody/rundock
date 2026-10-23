'use strict';
// What a connector's email or calendar request says, read from its fields so
// its card can show who it reaches and what it says. Pure: no DOM, the same UMD
// pattern as permissions.js, which it reads the action words from.
//
// Recognised by generic names, never by a named service. An email: the action
// says draft, send, reply or forward, and the fields look like an email's (to,
// cc, bcc, recipients, subject). An event: the action names an event or a
// meeting, and the fields carry a title, a time or attendees. Anything else
// returns null and its card is drawn as before. Every value is an agent's, returned as plain text for the
// card to set as text, never as markup.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./permissions.js'));
  else root.RundockConnectorFields = factory(root.RundockPermissions);
}(typeof self !== 'undefined' ? self : this, function (P) {
  const SHOWN = 3;          // recipients before "+N more"
  const MORE_SHOWN = 5;     // shown when opened, then "and N more addresses"
  const BODY_LINES = 3;
  const BODY_SOFT = 300;    // past this many characters three lines may already be full
  const SUBJECT_SOFT = 120; // and two lines of subject
  const MAX_TEXT = 20000;   // any one value, so a huge payload cannot swamp the card
  const MAX_ADDRESS = 320;

  // Compared lower-case with `_`, `-` and spaces removed, so `bcc_recipients`,
  // `bccRecipients` and `BCC` are one name.
  const KEYS = {
    to: ['to', 'recipients', 'recipient', 'torecipients', 'toaddresses'],
    cc: ['cc', 'ccrecipients', 'ccaddresses'],
    bcc: ['bcc', 'bccrecipients', 'bccaddresses'],
    subject: ['subject'],
    body: ['body', 'text', 'message', 'content', 'bodytext', 'plaintext', 'textbody', 'htmlbody', 'html'],
    title: ['summary', 'title', 'subject', 'name'],
    start: ['start', 'starttime', 'startdatetime', 'startdate', 'startat', 'begin'],
    end: ['end', 'endtime', 'enddatetime', 'enddate', 'endat'],
    attendees: ['attendees', 'guests', 'invitees', 'participants', 'attendeeemails', 'guestemails'],
  };
  const SEND_KIND = { send: 'send', resend: 'send', reply: 'reply', forward: 'forward', fwd: 'forward' };
  const EVENT_WORDS = ['event', 'events', 'meeting', 'appointment', 'invite', 'invitation'];
  const CHANGE_WORDS = ['update', 'patch', 'edit', 'change', 'modify', 'move', 'reschedule'];

  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const norm = (k) => String(k).toLowerCase().replace(/[_\-\s]/g, '');
  const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);

  // The first of `names` the object carries with a value, and whether any did.
  function pick(src, names) {
    const keys = Object.keys(src);
    for (const n of names) {
      const k = keys.find((x) => norm(x) === n);
      if (k !== undefined && src[k] !== undefined && src[k] !== null) return { found: true, value: src[k] };
    }
    return { found: false, value: undefined };
  }

  // Text from a string, a number, a list, or a body object ({ content }, { text }).
  function textOf(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('\n');
    if (isObj(v)) for (const k of ['content', 'text', 'value', 'plain', 'html']) if (v[k] != null) return textOf(v[k]);
    return '';
  }

  // One address: a string, { email | address | mail, name | displayName }, or
  // the same wrapped as { emailAddress: {...} }. A name is kept beside its
  // address, never instead of it.
  function addressOf(v) {
    if (typeof v === 'string') return v.trim();
    if (!isObj(v)) return '';
    if (isObj(v.emailAddress)) return addressOf(v.emailAddress);
    const addr = textOf(v.email != null ? v.email : (v.address != null ? v.address : (v.mail != null ? v.mail : v.emailAddress))).trim();
    const name = textOf(v.name != null ? v.name : v.displayName).trim();
    return name && addr && name !== addr ? `${name} <${addr}>` : (addr || name);
  }
  function recipientsOf(v) {
    const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[,;\n]/) : (v == null ? [] : [v]));
    return list.map(addressOf).filter(Boolean).map((a) => clip(a, MAX_ADDRESS));
  }

  function emailOf(input, words) {
    const nested = isObj(input.message) ? input.message : null;
    const looksLikeMail = (o) => ['to', 'cc', 'bcc', 'subject'].some((k) => pick(o, KEYS[k]).found);
    const src = nested && looksLikeMail(nested) ? nested : input;
    if (!looksLikeMail(src)) return null;
    const send = words.map((w) => SEND_KIND[w]).find(Boolean);
    const action = send || (words.includes('draft') ? 'draft' : null);
    if (!action) return null;
    return {
      kind: 'email', action,
      to: recipientsOf(pick(src, KEYS.to).value), cc: recipientsOf(pick(src, KEYS.cc).value), bcc: recipientsOf(pick(src, KEYS.bcc).value),
      subject: clip(textOf(pick(src, KEYS.subject).value).trim(), MAX_TEXT),
      body: textOf(pick(src, KEYS.body).value),
    };
  }

  // A time: an ISO string with or without an offset, a date alone (all day),
  // seconds or milliseconds since the epoch, or any of those under
  // { dateTime | date, timeZone }. A time written without an offset is shown as
  // written, with the zone it names; one that cannot be read is kept as text.
  const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
  const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
  function whenOf(v) {
    if (v === undefined || v === null || v === '') return null;
    if (isObj(v)) {
      const zone = typeof v.timeZone === 'string' ? v.timeZone : (typeof v.timezone === 'string' ? v.timezone : null);
      const w = whenOf([v.dateTime, v.datetime, v.date_time, v.date, v.time, v.value].find((x) => x != null));
      return w && w.parts && !w.allDay && zone ? { ...w, zone: clip(zone, 64) } : w;
    }
    if (typeof v === 'number' && isFinite(v)) return { at: new Date(v < 1e11 ? v * 1000 : v) };
    const s = textOf(v).trim();
    let m = DATE_ONLY.exec(s);
    if (m) return { allDay: true, parts: [+m[1], +m[2], +m[3], 0, 0] };
    m = DATE_TIME.exec(s);
    if (m && !m[6]) return { parts: [+m[1], +m[2], +m[3], +m[4], +m[5]] };
    const at = m ? new Date(s.replace(' ', 'T')) : null;
    return at && !isNaN(at.getTime()) ? { at } : { raw: clip(s, 120) };
  }
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  // An instant's date and time where the viewer is (or in opts.timeZone).
  function zoned(at, timeZone) {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
    return [+p.year, +p.month, +p.day, +p.hour, +p.minute];
  }
  function formatWhen(w, opts) {
    if (!w) return null;
    if (w.raw !== undefined) return w.raw;
    const [y, mo, d, h, mi] = w.at ? zoned(w.at, opts && opts.timeZone) : w.parts;
    const day = `${DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]} ${d} ${MONTHS[mo - 1]} ${y}`;
    return w.allDay ? `${day}, all day` : `${day}, ${pad(h)}:${pad(mi)}` + (w.zone ? ` (${w.zone})` : '');
  }
  // How long a timed event runs, under a day, or null.
  function durationText(start, end) {
    const mins = (w) => (!w || w.allDay ? null : (w.at ? w.at.getTime() : (w.parts ? Date.UTC(w.parts[0], w.parts[1] - 1, w.parts[2], w.parts[3], w.parts[4]) : NaN)) / 60000);
    const a = mins(start), b = mins(end);
    if (a == null || b == null || !!(start && start.at) !== !!(end && end.at) || !(b > a) || b - a >= 24 * 60) return null;
    const m = Math.round(b - a), h = Math.floor(m / 60), r = m % 60;
    return h ? (r ? `${h} hr ${r} min` : `${h} hr`) : `${m} min`;
  }

  function eventOf(input, words) {
    if (!words.some((w) => EVENT_WORDS.includes(w))) return null;
    const [title, start, end, attendees] = ['title', 'start', 'end', 'attendees'].map((k) => pick(input, KEYS[k]));
    if (![title, start, end, attendees].some((p) => p.found)) return null;
    return {
      kind: 'event', action: words.some((w) => CHANGE_WORDS.includes(w)) ? 'update' : 'create',
      title: clip(textOf(title.value).trim(), MAX_TEXT), start: whenOf(start.value), end: whenOf(end.value),
      attendees: recipientsOf(attendees.value),
    };
  }

  // The fields of a connector request a card can show, or null.
  function connectorFields(toolName, input) {
    if (typeof toolName !== 'string' || !toolName.startsWith('mcp__') || !isObj(input)) return null;
    const words = P.mcpActionWords(toolName);
    if (words.some((w) => P.MCP_DESTRUCTIVE_VERBS.indexOf(w) !== -1)) return null;
    return emailOf(input, words) || eventOf(input, words);
  }

  // A list cut to three, then up to five more behind "+N more", then a count.
  function cutList(list) {
    return { shown: list.slice(0, SHOWN), more: list.slice(SHOWN, SHOWN + MORE_SHOWN), rest: Math.max(0, list.length - SHOWN - MORE_SHOWN) };
  }

  // A message cut to three lines, with the whole of it (capped) for the box.
  function cutText(text) {
    const whole = String(text || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    const full = clip(whole, MAX_TEXT);
    const lines = full.split('\n');
    const moreLines = Math.max(0, lines.length - BODY_LINES);
    return { preview: lines.slice(0, BODY_LINES).join('\n'), moreLines, cut: moreLines > 0 || full.length > BODY_SOFT, full, overflow: whole.length - full.length };
  }

  // The sentence under the card's title.
  function contextFor(f, server) {
    if (f.kind === 'event') {
      const n = f.attendees.length;
      const who = n === 1 ? '1 person' : `${n} people`;
      return f.action === 'update'
        ? `Changes an event on your calendar. ${n ? `${who} will be emailed about the change.` : 'No one else is invited.'}`
        : `Adds an event to your calendar. ${n ? `${who} will be emailed an invitation.` : 'No one else is invited.'}`;
    }
    if (f.action === 'draft') return `Saves a draft in ${server}. Nothing is sent.`;
    const nobody = f.action === 'send' && !f.to.length && !f.cc.length && !f.bcc.length;
    return 'Sends straight away from your account. It cannot be undone, so this always asks.'
      + (nobody ? ' No recipients are set, so this will probably fail.' : '');
  }

  return { connectorFields, cutList, cutText, contextFor, recipientsOf, formatWhen, durationText, SHOWN, MORE_SHOWN, SUBJECT_SOFT, MAX_TEXT, MAX_ADDRESS };
}));
