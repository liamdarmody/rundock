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
  const MAX_OTHERS = 25;       // unread fields shown; every other one is one click away
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
    // Where a send, reply or forward goes when it names a place rather than
    // a person: a channel, a chat, a conversation, a thread, a user. Read only
    // for those actions, never for a draft or an event, where an id or a
    // thread is just the item worked on.
    destination: ['channel', 'channelid', 'chatid', 'conversationid', 'threadid', 'userid', 'recipientid', 'id'],
  };
  const EMPTY = { to: [], cc: [], bcc: [], attendees: [], subject: '', body: '', title: '', start: null, end: null, destination: '' };
  const TEXT_KEYS = ['content', 'text', 'value', 'plain', 'html'];
  const ADDRESS_KEYS = ['email', 'address', 'mail', 'emailAddress'];
  const NAME_KEYS = ['name', 'displayName'];
  const TIME_KEYS = ['dateTime', 'datetime', 'date_time', 'date', 'time', 'value'];
  // Keys a connector carries on almost every event or draft: which item,
  // which calendar, which zone, and words about an event. They are listed
  // under Other fields like any key the card does not read, but on an event or
  // a draft they cannot hide who a request reaches, so there they never turn
  // the card's words into a warning. A warning on every card is one nobody
  // reads.
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
  function rawText(v, limit = MAX_OTHER_TEXT) {
    let out = '';
    const walk = (x, depth) => {
      if (out.length > limit) return;
      if (typeof x === 'string') { const s = clip(x, limit + 1); out += depth ? JSON.stringify(s) : s; return; }
      if (x === null || typeof x !== 'object') { out += String(x); return; }
      if (depth >= MAX_DEPTH) { out += '…'; return; }
      const list = Array.isArray(x);
      const keys = list ? null : Object.keys(x);
      const n = list ? x.length : keys.length;
      out += list ? '[' : '{';
      for (let i = 0; i < n && out.length <= limit; i++) {
        if (i) out += ', ';
        if (!list) out += `${JSON.stringify(clip(keys[i], MAX_KEY))}: `;
        walk(list ? x[i] : x[keys[i]], depth + 1);
      }
      out += list ? ']' : '}';
    };
    walk(v, 0);
    return out.length > limit ? `${out.slice(0, limit)}…` : out;
  }

  // Something that reads as an email address, anywhere in a value: a
  // character that can end a name, an "@", a host and a dot.
  //
  // ONE CHARACTER BEFORE THE "@", NOT A RUN. Every unread value is looked
  // through on the window's main thread as a card is drawn. An unbounded run
  // there restarts at every position of a value with no "@", so the work grew
  // with the square of the value's length (0.9s for one value of 20,000
  // characters, 10.6s for ten). A run bounded at 64 is linear but still tries
  // 64 characters at every position (about 94ms for ten such values). For a
  // yes or no, a run of any length before the "@" matches exactly when its
  // last character does, so one character gives the same answers in well
  // under a millisecond.
  const EMAIL_LIKE = /[^\s@<>"]@[^\s@<>".]+\.[^\s@<>"]/;

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
  // request can fill a card with rows. Every one is listed, however many
  // there are, each value cut short on its own: a count is somewhere a
  // recipient could be put that no one can open.
  //
  // `keys` is the names each field is read by (KEYS, unless an action reads a
  // field by fewer). `unreadAddress` says whether any listed value holds
  // something that reads as an email address, looked for through the whole
  // value up to MAX_TEXT, not just the part the card shows.
  function gather(sources, read, keys = KEYS) {
    const values = {}, aliases = {}, others = [], firstKey = {};
    let found = false, aliasOverflow = 0, unreadAddress = false;
    const list = (key, raw) => {
      others.push({ key, text: rawText(raw) });
      if (!unreadAddress && EMAIL_LIKE.test(rawText(raw, MAX_TEXT))) unreadAddress = true;
    };
    const fields = Object.keys(read);
    for (const field of fields) {
      const all = [];
      for (const s of sources) {
        for (const k of keysFor(s.obj, keys[field])) if (!s.skip.has(k)) all.push({ key: clip(s.prefix + k, MAX_KEY), raw: s.obj[k] });
      }
      values[field] = all.length ? read[field](all[0].raw) : EMPTY[field];
      if (all.length > 1) aliases[field] = all.slice(0, MAX_ALIAS_ROWS).map((o) => ({ key: o.key, value: read[field](o.raw) }));
      for (const o of all.slice(MAX_ALIAS_ROWS)) { aliasOverflow++; list(o.key, o.raw); }
      if (all.length) { found = true; firstKey[field] = all[0].key; }
    }
    const names = new Set(fields.flatMap((field) => keys[field]));
    for (const s of sources) {
      for (const k of Object.keys(s.obj)) {
        if (s.skip.has(k) || names.has(norm(k)) || s.obj[k] === undefined) continue;
        list(clip(s.prefix + k, MAX_KEY), s.obj[k]);
      }
    }
    return { values, aliases, others, aliasOverflow, unreadAddress, found, firstKey };
  }

  function emailOf(input, words) {
    const send = words.map((w) => SEND_KIND[w]).find(Boolean);
    const action = send || (words.includes('draft') ? 'draft' : null);
    if (!action) return null;
    // A send, reply or forward needs nothing but a body to be read: a reply
    // can name only its thread, and what it says is still what a person is
    // approving. A draft that names no one and no subject is left as it was.
    const addressed = (o) => ['to', 'cc', 'bcc', 'subject'].some((k) => keysFor(o, KEYS[k]).length);
    const looksLikeMail = (o) => addressed(o)
      || (action !== 'draft' && keysFor(o, KEYS.body).length > 0);
    // An email nested under `message` is read as well as the input around it,
    // each field under its path, so a top-level `to` beside `message.to` is a
    // second recipient list rather than one the card never mentions.
    const nested = Object.keys(input).filter((k) => norm(k) === 'message' && isObj(input[k]) && looksLikeMail(input[k]));
    const sources = [{ obj: input, prefix: '', skip: new Set(nested) }, ...nested.map((k) => ({ obj: input[k], prefix: `${k}.`, skip: new Set() }))];
    if (!sources.some((s) => looksLikeMail(s.obj))) return null;
    const read = { to: recipientsOf, cc: recipientsOf, bcc: recipientsOf, subject: lineOf, body: bodyOf };
    // Where a send goes when it names a place rather than a person: read, so it
    // is drawn under the key it came from and never counted as unread.
    if (action !== 'draft') read.destination = lineOf;
    // On a forward an id or a thread names the message being forwarded, not
    // where it goes, so it is never taken for a destination there; the keys
    // that name a place still are.
    const keys = action === 'forward' ? { ...KEYS, destination: KEYS.destination.filter((n) => n !== 'id' && n !== 'threadid') } : KEYS;
    const g = gather(sources, read, keys);
    const { destination: first, ...values } = g.values;
    const { destination: all, ...aliases } = g.aliases;
    const destinations = all || (g.firstKey.destination ? [{ key: g.firstKey.destination, value: first }] : []);
    return {
      kind: 'email', action, ...values, aliases, others: g.others, aliasOverflow: g.aliasOverflow, unreadAddress: g.unreadAddress,
      // A recipient or a subject makes it an email; a body and a destination
      // alone are a message, with no empty Subject row to explain.
      destinations, emailShaped: sources.some((s) => addressed(s.obj)),
    };
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
      ...g.values, aliases: g.aliases, others: g.others, aliasOverflow: g.aliasOverflow, unreadAddress: g.unreadAddress,
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
  // any key under Other fields, or any past the listed number. On an event or
  // a draft a well-known key is quiet (the last part of a nested key's path is
  // what is compared): there an id, a thread or a calendar names the item
  // worked on. On a send, reply or forward a key like that can be where the
  // message goes, so there every unread key counts.
  function hasUnreadFields(f) {
    const quiet = (o) => (f.kind === 'event' || f.action === 'draft') && WELL_KNOWN.has(norm(String(o.key).split('.').pop()));
    return f.others.some((o) => !quiet(o));
  }

  // Whether a request has more fields than the card shows at once: a field
  // under more names than it has rows for (the rest are listed apart), or
  // unread fields past the number shown (the rest are one click away). Then
  // the card says so, because what is folded away is still what the request
  // acts on.
  function isCrowded(f) {
    return (f.aliasOverflow || 0) > 0 || f.others.length > MAX_OTHERS;
  }
  const CROWDED = ' This request has more fields than the card shows at once: open Other fields and check every one before allowing.';

  const ADDRESS_NOTE = ' An email address is in a field the card does not read: check Other fields before allowing.';

  // The sentence under the card's title. An email address in a field the
  // card does not read can be who a request reaches, whatever a destination
  // row says, so the card says so unless it already points at Other fields. A
  // draft sends nothing.
  function contextFor(f, server) {
    const said = baseContext(f, server) + (isCrowded(f) ? CROWDED : '');
    return said + (f.unreadAddress && f.action !== 'draft' && !said.includes('Other fields') ? ADDRESS_NOTE : '');
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
    // A send names who it reaches, or where it goes. One that names neither is
    // said to probably fail only when it carries nothing else at all: any
    // other field could be who it reaches.
    const reached = ['to', 'cc', 'bcc'].some((k) => every(k).length) || f.destinations.length > 0;
    const nobody = f.action === 'send' && !reached;
    const anyOthers = f.others.length > 0;
    return 'Sends straight away from your account. It cannot be undone, so this always asks.'
      + (nobody ? (anyOthers ? ' No recipients were recognised: check Other fields before allowing.' : ' No recipients are set, so this will probably fail.') : '');
  }

  return {
    connectorFields, cutList, cutText, contextFor, hasUnreadFields, isCrowded, recipientsOf, addressText, formatWhen, durationText,
    SHOWN, MORE_SHOWN, SUBJECT_SOFT, MAX_TEXT, MAX_ADDRESS, MAX_OTHERS, MAX_OTHER_TEXT, MAX_LIST, MAX_ALIAS_ROWS,
  };
}));
