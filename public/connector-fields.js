'use strict';
// What a connector's email or calendar request says, read from its fields so
// its card can show who it reaches and what it says. Pure: no DOM, the same UMD
// pattern as permissions.js, which it reads the action words from.
//
// Recognised by generic names, never by a named service. An email: the action
// says draft, send, reply or forward, and the fields look like an email's (to,
// cc, bcc, recipients, subject). An event: the action names an event or a
// meeting, and the fields carry a title, a time or attendees. Anything else
// returns null and its card is drawn as before. Every value is an agent's,
// returned as plain text for the card to set as text, never as markup.
//
// NOTHING A REQUEST CARRIES IS LEFT OFF ITS CARD. A field card takes the place
// of the raw request, so a field it did not read is one a person approves
// without seeing, and a service may act on exactly that one: a second
// recipient list, an HTML body beside a plain one, a top-level field beside a
// nested message, a title beside a summary. So every alias of a field is kept
// (the first is the field's value, and all of them are in `aliases` when there
// is more than one), an entry in a shape the card cannot read is kept as
// written, and every key read as none of the fields is in `others`.
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
  const MAX_KEY = 64;          // a key, shown as a label
  const MAX_OTHERS = 25;       // unread fields shown; the rest are one click away
  const MAX_LISTED = 200;      // unread fields listed at all; only past this are they counted
  const MAX_OTHER_TEXT = 300;  // an unread value, or one shown as written
  const MAX_LIST = 500;        // entries drawn from a list that is never folded (Bcc)
  const MAX_ALIAS_ROWS = 10;   // rows for one field under many names; the rest are listed
  // How deep any value is read or written out. Past it a value is kept as
  // written, so one nested thousands deep cannot overflow the stack and stop
  // the card being drawn.
  const MAX_DEPTH = 8;

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
  const EMPTY = { to: [], cc: [], bcc: [], attendees: [], subject: '', body: '', title: '', start: null, end: null };
  const TEXT_KEYS = ['content', 'text', 'value', 'plain', 'html'];
  const ADDRESS_KEYS = ['email', 'address', 'mail', 'emailAddress'];
  const NAME_KEYS = ['name', 'displayName'];
  const TIME_KEYS = ['dateTime', 'datetime', 'date_time', 'date', 'time', 'value'];
  // Keys a connector carries on almost every request: which item, which
  // calendar, which zone, and words about an event. They are listed under
  // Other fields like any key the card does not read, but they cannot hide who
  // a request reaches, so they never turn the card's words into a warning. A
  // warning on every card is one nobody reads.
  const WELL_KNOWN = new Set(['id', 'threadid', 'messageid', 'draftid', 'calendarid', 'eventid', 'timezone', 'description', 'location']);
  const SEND_KIND = { send: 'send', resend: 'send', reply: 'reply', forward: 'forward', fwd: 'forward' };
  const EVENT_WORDS = ['event', 'events', 'meeting', 'appointment', 'invite', 'invitation'];
  const CHANGE_WORDS = ['update', 'patch', 'edit', 'change', 'modify', 'move', 'reschedule'];

  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const norm = (k) => String(k).toLowerCase().replace(/[_\-\s]/g, '');
  const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);

  // Every key of `src` that is one of `names` and holds a value, in the order
  // of `names`. Two spellings of one name (`to` and `TO`) are two keys.
  function keysFor(src, names) {
    const keys = Object.keys(src);
    const found = [];
    for (const n of names) for (const k of keys) if (norm(k) === n && src[k] !== undefined && src[k] !== null) found.push(k);
    return found;
  }

  // Any value as text, for one the card cannot otherwise read: a string as it
  // is, anything else written out the way JSON writes it, cut short either way.
  // Bounded in depth and in length whatever it is given.
  function rawText(v) {
    let out = '';
    const walk = (x, depth) => {
      if (out.length > MAX_OTHER_TEXT) return;
      if (typeof x === 'string') { const s = clip(x, MAX_OTHER_TEXT + 1); out += depth ? JSON.stringify(s) : s; return; }
      if (x === null || typeof x !== 'object') { out += String(x); return; }
      if (depth >= MAX_DEPTH) { out += '…'; return; }
      const list = Array.isArray(x);
      const keys = list ? null : Object.keys(x);
      const n = list ? x.length : keys.length;
      out += list ? '[' : '{';
      for (let i = 0; i < n && out.length <= MAX_OTHER_TEXT; i++) {
        if (i) out += ', ';
        if (!list) out += `${JSON.stringify(clip(keys[i], MAX_KEY))}: `;
        walk(list ? x[i] : x[keys[i]], depth + 1);
      }
      out += list ? ']' : '}';
    };
    walk(v, 0);
    return out.length > MAX_OTHER_TEXT ? `${out.slice(0, MAX_OTHER_TEXT)}…` : out;
  }

  // Text from a string, a number, a list, or a body object ({ content }, { text }).
  // Null when the value holds none the card can read as one text, or is nested
  // past MAX_DEPTH, so the card shows it as written rather than as empty.
  function textOf(v, depth = 0) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v === null || v === undefined) return '';
    if (depth >= MAX_DEPTH) return null;
    if (Array.isArray(v)) {
      const parts = v.map((x) => textOf(x, depth + 1));
      return parts.includes(null) ? null : parts.filter(Boolean).join('\n');
    }
    if (isObj(v)) return TEXT_KEYS.some((k) => v[k] != null) ? oneOf(v, TEXT_KEYS, depth + 1) : (Object.keys(v).length ? null : '');
    return null;
  }
  // The one text the `keys` of `obj` hold between them: '' when none does, and
  // null when two hold different texts or one cannot be read, so the card
  // shows what was sent instead of choosing between them.
  function oneOf(obj, keys, depth = 0) {
    const texts = keys.filter((k) => obj[k] != null).map((k) => textOf(obj[k], depth));
    if (texts.includes(null)) return null;
    const said = texts.filter((t) => t.trim());
    return new Set(said.map((t) => t.trim())).size > 1 ? null : (said[0] || '');
  }

  // One recipient as { name, address }, from a string, { email | address |
  // mail, name | displayName }, or the same wrapped as { emailAddress: {...} };
  // or { raw } for an entry the card cannot read as one address, shown as
  // written. A name is kept beside its address, never instead of it.
  function entryOf(v, depth = 0) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v).trim();
      return s ? { name: '', address: clip(s, MAX_ADDRESS) } : null;
    }
    if (isObj(v) && depth < MAX_DEPTH) {
      const beside = ADDRESS_KEYS.concat(NAME_KEYS).some((k) => k !== 'emailAddress' && v[k] != null);
      if (isObj(v.emailAddress) && !beside) return entryOf(v.emailAddress, depth + 1);
      const address = oneOf(v, ADDRESS_KEYS, depth + 1);
      const name = oneOf(v, NAME_KEYS, depth + 1);
      if (address !== null && name !== null && (address.trim() || name.trim())) {
        const a = address.trim(), n = name.trim();
        return { name: a && n && n !== a ? clip(n, MAX_ADDRESS) : '', address: clip(a || n, MAX_ADDRESS) };
      }
    }
    return { raw: rawText(v) };
  }
  function recipientsOf(v) {
    const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[,;\n]/) : (v == null ? [] : [v]));
    return list.map((x) => entryOf(x)).filter(Boolean);
  }
  // A recipient as one line of text: "Name <address>", the address, or the
  // entry as written.
  function addressText(e) {
    if (e.raw !== undefined) return e.raw;
    return e.name ? `${e.name} <${e.address}>` : e.address;
  }

  // A subject or a title, and a message body: read as text, or as written.
  const lineOf = (v) => { const t = textOf(v); return clip((t === null ? rawText(v) : t).trim(), MAX_TEXT); };
  const bodyOf = (v) => { const t = textOf(v); return t === null ? rawText(v) : t; };

  // Each field read from every source that carries it. `read` maps a field to
  // how its value is read. The first value is the field's; a field found more
  // than once has up to MAX_ALIAS_ROWS of them in `aliases`, each under the key
  // it came from, and any past that (counted in `aliasOverflow`) are listed in
  // `others` with every key of a source that is none of the fields, so no
  // request can fill a card with rows. Everything is listed, never reduced to
  // a count, up to MAX_LISTED; only past that is anything counted.
  function gather(sources, read) {
    const values = {}, aliases = {}, others = [];
    let found = false, othersMore = 0, aliasOverflow = 0;
    const list = (key, raw) => {
      if (others.length < MAX_LISTED) others.push({ key, text: rawText(raw) });
      else othersMore++;
    };
    const fields = Object.keys(read);
    for (const field of fields) {
      const all = [];
      for (const s of sources) {
        for (const k of keysFor(s.obj, KEYS[field])) if (!s.skip.has(k)) all.push({ key: clip(s.prefix + k, MAX_KEY), raw: s.obj[k] });
      }
      values[field] = all.length ? read[field](all[0].raw) : EMPTY[field];
      if (all.length > 1) aliases[field] = all.slice(0, MAX_ALIAS_ROWS).map((o) => ({ key: o.key, value: read[field](o.raw) }));
      for (const o of all.slice(MAX_ALIAS_ROWS)) { aliasOverflow++; list(o.key, o.raw); }
      if (all.length) found = true;
    }
    const names = new Set(fields.flatMap((field) => KEYS[field]));
    for (const s of sources) {
      for (const k of Object.keys(s.obj)) {
        if (s.skip.has(k) || names.has(norm(k)) || s.obj[k] === undefined) continue;
        list(clip(s.prefix + k, MAX_KEY), s.obj[k]);
      }
    }
    return { values, aliases, others, othersMore, aliasOverflow, found };
  }

  function emailOf(input, words) {
    const send = words.map((w) => SEND_KIND[w]).find(Boolean);
    const action = send || (words.includes('draft') ? 'draft' : null);
    if (!action) return null;
    // A send, reply or forward needs nothing but a body to be read: a reply
    // can name only its thread, and what it says is still what a person is
    // approving. A draft that names no one and no subject is left as it was.
    const looksLikeMail = (o) => ['to', 'cc', 'bcc', 'subject'].some((k) => keysFor(o, KEYS[k]).length)
      || (action !== 'draft' && keysFor(o, KEYS.body).length > 0);
    // An email nested under `message` is read as well as the input around it,
    // each field under its path, so a top-level `to` beside `message.to` is a
    // second recipient list rather than one the card never mentions.
    const nested = Object.keys(input).filter((k) => norm(k) === 'message' && isObj(input[k]) && looksLikeMail(input[k]));
    const sources = [{ obj: input, prefix: '', skip: new Set(nested) }, ...nested.map((k) => ({ obj: input[k], prefix: `${k}.`, skip: new Set() }))];
    if (!sources.some((s) => looksLikeMail(s.obj))) return null;
    const g = gather(sources, { to: recipientsOf, cc: recipientsOf, bcc: recipientsOf, subject: lineOf, body: bodyOf });
    return { kind: 'email', action, ...g.values, aliases: g.aliases, others: g.others, othersMore: g.othersMore, aliasOverflow: g.aliasOverflow };
  }

  // A time: an ISO string with or without an offset, a date alone (all day),
  // seconds or milliseconds since the epoch, or any of those under
  // { dateTime | date, timeZone }. A time written without an offset is shown as
  // written, with the zone it names; one that cannot be read, or an object
  // holding two different times or none the card knows, is kept as written.
  // So is an epoch no date can hold and a date or time that does not exist:
  // the card says what was sent rather than a day that never comes.
  const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
  const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
  const realDay = (y, mo, d) => mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const realTime = (h, mi) => h <= 23 && mi <= 59;
  function whenOf(v, depth = 0) {
    if (v === undefined || v === null || v === '') return null;
    if (depth >= MAX_DEPTH) return { raw: rawText(v) };
    if (isObj(v)) {
      const zone = typeof v.timeZone === 'string' ? v.timeZone : (typeof v.timezone === 'string' ? v.timezone : null);
      const held = TIME_KEYS.filter((k) => v[k] != null);
      if (!held.length || new Set(held.map((k) => rawText(v[k]))).size > 1) return { raw: rawText(v) };
      const w = whenOf(v[held[0]], depth + 1);
      return w && w.parts && !w.allDay && zone ? { ...w, zone: clip(zone, 64) } : w;
    }
    if (typeof v === 'number') {
      const at = new Date(v < 1e11 ? v * 1000 : v);
      return isNaN(at.getTime()) ? { raw: String(v) } : { at };
    }
    const t = textOf(v, depth);
    if (t === null) return { raw: rawText(v) };
    const s = t.trim();
    let m = DATE_ONLY.exec(s);
    if (m) return realDay(+m[1], +m[2], +m[3]) ? { allDay: true, parts: [+m[1], +m[2], +m[3], 0, 0] } : { raw: clip(s, 120) };
    m = DATE_TIME.exec(s);
    if (m && !(realDay(+m[1], +m[2], +m[3]) && realTime(+m[4], +m[5]))) return { raw: clip(s, 120) };
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
    const g = gather([{ obj: input, prefix: '', skip: new Set() }], { title: lineOf, start: whenOf, end: whenOf, attendees: recipientsOf });
    if (!g.found) return null;
    return {
      kind: 'event', action: words.some((w) => CHANGE_WORDS.includes(w)) ? 'update' : 'create',
      ...g.values, aliases: g.aliases, others: g.others, othersMore: g.othersMore, aliasOverflow: g.aliasOverflow,
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

  // Whether a field went unread that could be holding who a request reaches:
  // any key under Other fields that is not a well-known one (the last part of
  // a nested key's path is what is compared), or any past the listed number.
  function hasUnreadFields(f) {
    return f.othersMore > 0 || f.others.some((o) => !WELL_KNOWN.has(norm(String(o.key).split('.').pop())));
  }

  // Whether a request has more fields than the card shows at once: a field
  // under more names than it has rows for (the rest are listed apart), unread
  // fields past the number shown (the rest are one click away), or any past
  // the number listed (those are only counted). Then the card says so, because
  // what is folded away is still what the request acts on.
  function isCrowded(f) {
    return (f.aliasOverflow || 0) > 0 || f.others.length > MAX_OTHERS || f.othersMore > 0;
  }
  const CROWDED = ' This request has more fields than the card shows at once: open Other fields and check every one before allowing.';

  // The sentence under the card's title.
  function contextFor(f, server) {
    return baseContext(f, server) + (isCrowded(f) ? CROWDED : '');
  }

  // What the request does. Every alias of a field counts toward who is
  // reached. While fields went unread, nobody being found is not the same as
  // nobody being there, so the card points at Other fields instead.
  function baseContext(f, server) {
    const unread = hasUnreadFields(f);
    const every = (field) => (f.aliases[field] ? f.aliases[field].map((o) => o.value) : [f[field]]).flat();
    if (f.kind === 'event') {
      const n = new Set(every('attendees').map(addressText)).size;
      const who = n === 1 ? '1 person' : `${n} people`;
      const nobody = unread ? 'Check Other fields for anyone it invites.' : 'No one else is invited.';
      return f.action === 'update'
        ? `Changes an event on your calendar. ${n ? `${who} will be emailed about the change.` : nobody}`
        : `Adds an event to your calendar. ${n ? `${who} will be emailed an invitation.` : nobody}`;
    }
    if (f.action === 'draft') return `Saves a draft in ${server}. Nothing is sent.`;
    const nobody = f.action === 'send' && !['to', 'cc', 'bcc'].some((k) => every(k).length);
    return 'Sends straight away from your account. It cannot be undone, so this always asks.'
      + (nobody ? (unread ? ' No recipients were recognised: check Other fields before allowing.' : ' No recipients are set, so this will probably fail.') : '');
  }

  return {
    connectorFields, cutList, cutText, contextFor, hasUnreadFields, isCrowded, recipientsOf, addressText, formatWhen, durationText,
    SHOWN, MORE_SHOWN, SUBJECT_SOFT, MAX_TEXT, MAX_ADDRESS, MAX_OTHERS, MAX_LISTED, MAX_OTHER_TEXT, MAX_LIST, MAX_ALIAS_ROWS,
  };
}));
