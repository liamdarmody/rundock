// The sandboxed extension host: one mount, one opaque-origin frame, one
// mediator, and a teardown that cannot be forgotten.
//
// THE CONTRACT IS THE DOCUMENT, NOT THIS FILE. docs/EXTENSION-HOST.md states
// what a mounted extension can reach and what it cannot; the message table
// below is checked against that document by a test, so the two cannot drift.
// Anything this file allows that the document does not name is a defect by
// definition, whatever it enables.
//
// WHY THE SANDBOX POSTURE IS THE OPPOSITE OF THE ARTIFACT VIEWER'S. The
// artifact preview is allow-same-origin with NO allow-scripts: an inert
// document the host can read into. An extension view is the inverse: it must
// run its own code and the host must be unable to be read by it, so it is
// allow-scripts with NO allow-same-origin, which makes its origin opaque.
// The two grants must never be combined anywhere in this codebase: together
// they hand the framed code the app's own origin. mount() refuses to build
// any other posture rather than trusting callers not to ask.
//
// EVERY MESSAGE PASSES THE MEDIATOR, and the mediator's table is closed. A
// message whose type is not in the table, or whose fields are not the shape
// the table declares, is refused with a reason posted back to the frame, so
// a misbehaving extension can see what it did wrong and an audited transcript
// shows every refusal. Silence would be kinder to the extension author and
// worse for everyone else.

import { rundockUiFrameParts } from './rundock-ui-frame.js';
import { installRundockUi } from './rundock-ui.js';

// The closed message table: everything an extension may say to the host.
// Field checks are functions so the table carries the whole shape, not just
// the name. Kept as data so the contract test can read it.
export const EXTENSION_MESSAGES = {
  // `handles` is optional: the host messages beyond the always-sent ones that
  // this view says it answers. Today the only one is `theme` (HOST_HANDLES).
  // A view that names it is restyled in place on a theme change; one that
  // does not is rebuilt, which is what every view got before `theme` existed.
  ready: { handles: (v) => v === undefined || (Array.isArray(v) && v.length <= 16 && v.every((h) => typeof h === 'string')) },
  resize: { height: (v) => typeof v === 'number' && Number.isFinite(v) },
  error: { message: (v) => typeof v === 'string' },
  open: { target: (v) => typeof v === 'string' && v.length > 0 },
  // The whole of writing, and note what is NOT in the shape: a path. An
  // extension cannot name what it writes to, because the host already knows
  // the one file it mounted this view for. So "writes only the file it was
  // mounted on" is a property of the message rather than a check somewhere
  // that could be forgotten, and there is no path here to validate, escape,
  // or get wrong.
  //
  // Honoured only for an extension whose manifest declared writes. One that
  // did not gets the same named refusal as any unknown type: the declaration
  // and the enforcement are the same fact read in two places.
  save: { content: (v) => typeof v === 'string' },
  change: { content: (v) => typeof v === 'string' },
  // A web address the person clicked inside the view, opened OUTSIDE it: in
  // the system browser on desktop, a new tab in browser mode. It exists
  // because the frame may no longer navigate itself (see LEFT_VIEW_REASON),
  // and without it an ordinary link in a view would end the view instead of
  // opening. Honoured only after a real click, and only for http and https.
  openExternal: { url: (v) => typeof v === 'string' && v.length > 0 },
  // NAMED SOURCES: write one of the files the note lists. `source` is a NAME
  // from the list this view was handed, compared as a string against that
  // list; it is never resolved as a path here, and the server resolves it
  // again at write time. Honoured only for an extension that declared both
  // sources and writes. `changeSource` is to `saveSource` what `change` is to
  // `save`: the caller's shared debounce decides when to write.
  saveSource: { source: (v) => typeof v === 'string' && v.length > 0, content: (v) => typeof v === 'string' },
  changeSource: { source: (v) => typeof v === 'string' && v.length > 0, content: (v) => typeof v === 'string' },
  // ASK AN AGENT: Rundock opens a NEW conversation with one agent the
  // manifest declared and puts the message in its composer, unsent. Honoured
  // only after a click inside the view, once per click. Nothing is posted
  // back on success: the view never learns the conversation, the reply, or
  // whether the person sent anything.
  ask: {
    agent: (v) => typeof v === 'string' && /^[a-z0-9_-]{1,64}$/.test(v),
    message: (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ASK_CHARS,
  },
  // VIEW STATE: the view's own preferences (a width, a tab), kept by Rundock
  // for this extension and this note, never in the note. The whole state,
  // and nothing else: no extension, no note, no key on disk. The host names
  // those from its mount, so a view can reach no other view's state. Plain
  // JSON and the caps are checked in dispatch, where the refusal can say
  // what and where (viewStateProblem).
  setState: { state: (v) => !!v && typeof v === 'object' && !Array.isArray(v) },
};

// VIEW STATE LIMITS AND REASONS. The server holds the same limits again
// (lib/packages/extension-state.js), for a write that did not come through
// here. The per-extension total is the server's alone, because only the
// server can count it; its reason reaches the view through refuseState.
export const VIEW_STATE_MAX_BYTES = 65536;
export const VIEW_STATE_MAX_DEPTH = 16;
export const VIEW_STATE_REASONS = {
  embedded: 'an embedded view cannot keep view state; open this file to change it',
  tooLarge: 'the view state is larger than 64 KB',
  overLimit: "this extension's view state is over its limit",
};

const withArticle = (word) => `${/^[AEIO]/.test(word) ? 'an' : 'a'} ${word}`;

// Why a value is not plain JSON within the depth limit, and where, or null.
// Structured clone carries much that JSON cannot (a Date, a Map, a typed
// array, a hole, a cycle); every one is named rather than silently changed.
function jsonProblem(value, depth, where, seen) {
  const at = where ? ` at ${where}` : '';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `a number that is not finite${at}`;
  if (typeof value !== 'object') return `${value === undefined ? 'undefined' : withArticle(typeof value)}${at}`;
  if (seen.has(value)) return `a cycle${at}`;
  const isArray = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (!isArray && proto !== Object.prototype && proto !== null) {
    const tag = Object.prototype.toString.call(value).slice(8, -1);
    return `${tag === 'Object' ? 'an object that is not plain' : withArticle(tag)}${at}`;
  }
  if (isArray && Object.keys(value).some((key) => !/^(0|[1-9][0-9]*)$/.test(key))) return `an array with named entries${at}`;
  if (depth >= VIEW_STATE_MAX_DEPTH) return `more than ${VIEW_STATE_MAX_DEPTH} levels deep${at}`;
  seen.add(value);
  const keys = isArray ? [...value.keys()].map(String) : Object.keys(value);
  for (const key of keys) {
    const problem = jsonProblem(value[key], depth + 1, where ? `${where}.${key}` : key, seen);
    if (problem) return problem;
  }
  seen.delete(value);
  return null;
}

/** Why a view state would be refused, in the words the view is told, or null. */
export function viewStateProblem(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 'the view state must be an object';
  const problem = jsonProblem(state, 0, '', new Set());
  if (problem) return `the view state is not plain JSON: ${problem}`;
  if (new TextEncoder().encode(JSON.stringify(state)).length > VIEW_STATE_MAX_BYTES) return VIEW_STATE_REASONS.tooLarge;
  return null;
}

// The longest message a view may draft.
export const MAX_ASK_CHARS = 4000;

// THE COMPOSER SHOWS WHAT WOULD BE SENT. A character that reorders or hides
// what follows it could make a draft read differently from the bytes it
// holds, so these are removed before the text reaches the composer: C0 and C1
// controls other than tab and newline, bidirectional marks, overrides and
// isolates, and zero-width characters.
export function cleanAskMessage(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '');
}

// WHAT A VIEW IS TOLD WHEN RUNDOCK STOPS A CLICK-GATED REQUEST. A view may
// show these words to the person, so they are written for the person, in
// the words of the line Rundock itself shows. The names are stable; a view
// that needs to tell one refusal from another compares `of` and the reason
// against these exact strings.
export const CLICK_REFUSED_REASON = 'Rundock stopped this because it did not come from your click';

export const ASK_REFUSED_REASONS = {
  click: CLICK_REFUSED_REASON,
  undeclared: 'this extension did not declare that agent in its manifest',
  embedded: 'an embedded view cannot ask an agent; open this file to use it',
};

// What the extension is told when the person is asked instead, and answers.
export const REQUEST_REASONS = {
  waiting: 'Rundock is already asking you about another request',
  dismissed: 'you dismissed this in Rundock',
};

export const SOURCE_REFUSED_REASONS = {
  none: 'this view has no sources',
  unlisted: 'the note does not list that file as a source',
  unchecked: 'Rundock could not check this write against the note\'s sources, so it was not made',
};

// WHY A FRAME THAT LOADS A SECOND DOCUMENT IS ENDED, and why this is the
// reason the person reads.
//
// `default-src 'none'` in the frame governs what its document LOADS. It does
// not govern the document replacing itself, and a sandboxed frame is always
// allowed to navigate itself: `location.href = 'https://anywhere/?' + file`
// was measured delivering the file to another origin, in Chromium and in the
// shipped Electron (docs/evidence/extension-confinement-evidence.md). The page
// that replaces the frame is still `frame.contentWindow`, so a source check
// alone would keep answering it. So a second `load`, or a second `ready`,
// means the view is no longer the extension that was mounted, and the mount
// ends. The primary guard is outside this file (the desktop app refuses the
// navigation, and the page's own policy confines frames in browser mode); this
// is what makes the host safe even if one of those is missing.
export const LEFT_VIEW_REASON = 'the extension tried to leave its view and was stopped';

// Whether the person has just interacted with the page, read from the HOST's
// own window. A click inside the frame reaches the host's activation state
// (User Activation v2 propagates it to ancestors) and script cannot forge it,
// so this asks the browser rather than believing the frame. Where the API is
// missing, the answer is no: an unverifiable click is not a click.
export function hasUserActivation(win) {
  const activation = win && win.navigator && win.navigator.userActivation;
  return !!(activation && activation.isActive);
}

// WHETHER THE PERSON CLICKED INSIDE THIS FRAME, which is a narrower question
// than whether they clicked, and the difference was measured.
//
// The host's activation is set by ANY interaction on Rundock's page and stays
// set for a few seconds, so the click in the file tree that opened a file is
// still "a click" when that file's view boots and asks to open something
// else. A gate reading activation alone is defeated by the very click that
// mounted the view. So the host also requires that focus is on this frame:
// clicking inside an embedded frame moves focus to it, and clicking anywhere
// else on the page moves it away.
//
// Focus alone turned out not to be enough either: measured, a sandboxed frame
// can move focus into itself with no click. So the third condition is the one
// a frame cannot fake: no click or key on Rundock's OWN page recently enough
// to be the click the browser is reporting (public/host-gestures.js records
// them from page load). A click inside the frame is never delivered to the
// page's listeners, so an activation with no recent page gesture behind it
// came from a frame.
//
// The window is the browser's own activation lifespan (five seconds in
// Chromium) plus a margin, used only for the page-gesture check below.
export const ACTIVATION_LIFESPAN_MS = 5500;

// ONE ACTIVATION, ONE REQUEST, ACROSS EVERY FRAME (decided 2026-09-23, after
// the per-view record let a view opened by another view's click reuse that
// click). The browser keeps one activation for the whole page: a click
// inside any frame sets it, and it lapses a few seconds after the last one.
// The host cannot see a click inside a frame, so it cannot tell two clicks
// apart while the activation stays live. What it can see is the activation
// lapsing. So:
//
//   - once any frame's request is honoured, the activation is SPENT for
//     every frame until the browser reports it has lapsed;
//   - a frame mounted while an activation was live INHERITS it, and cannot
//     treat it as a click of its own until that activation lapses.
//
// Both marks are released together when the host sees the activation lapse,
// so a person's first click in any view works whenever no earlier
// activation is still live. The lapse is read from the browser itself
// (`navigator.userActivation.isActive`), polled only while a mark is held,
// never assumed from a clock.
//
// A request that meets a live activation the host cannot attribute to a
// fresh click in that view is not guessed at either way: the host asks the
// person, in its own bar above the view (see showRequestBar).
export const LAPSE_POLL_MS = 100;
// How long one watch polls. An activation lapses about five seconds after
// the last click, so a watch that outlives this is a person clicking without
// pause; it stops polling and keeps its marks, which errs toward asking, and
// the next read that finds the activation lapsed releases them.
export const LAPSE_WATCH_MS = 15000;
const activations = new WeakMap();
function activationOf(win) {
  let state = activations.get(win);
  if (!state) {
    state = { generation: 0, spent: -1, watching: false };
    activations.set(win, state);
  }
  return state;
}
// Every mark taken during the lapsed activation belonged to it.
function lapsed(state) {
  state.generation += 1;
}
function watchForLapse(win, state) {
  if (state.watching) return;
  state.watching = true;
  const started = Date.now();
  const tick = () => {
    if (hasUserActivation(win)) {
      if (Date.now() - started < LAPSE_WATCH_MS) win.setTimeout(tick, LAPSE_POLL_MS);
      else state.watching = false;
      return;
    }
    state.watching = false;
    lapsed(state);
  };
  win.setTimeout(tick, LAPSE_POLL_MS);
}
export function spendActivation(win) {
  const state = activationOf(win);
  state.spent = state.generation;
  watchForLapse(win, state);
}
function activationSpent(win) {
  const state = activationOf(win);
  return state.spent === state.generation;
}
const inherited = new WeakMap();
export function noteMount(win, frame) {
  if (!frame || !hasUserActivation(win)) return;
  const state = activationOf(win);
  inherited.set(frame, state.generation);
  watchForLapse(win, state);
}
function inheritsActivation(win, frame) {
  return inherited.get(frame) === activationOf(win).generation;
}

// Where a click-gated request stands:
//   'click'   a fresh click inside this view: honour it, and spend it;
//   'confirm' a live activation the host cannot attribute to a fresh click
//             here (already spent, inherited at mount, or a click on
//             Rundock's own page recent enough to be the one reported): ask
//             the person;
//   'refuse'  no click in this view at all: no activation, focus elsewhere,
//             or no record of the page's own clicks to check against.
export function requestStanding(win, frame, now = Date.now()) {
  if (!hasUserActivation(win)) {
    lapsed(activationOf(win));
    return 'refuse';
  }
  if (!frame) return 'refuse';
  if (win.document.activeElement !== frame) return 'refuse';
  const last = win.rundockLastHostGesture;
  // No recorder means the page cannot tell where a click was, so it is not
  // a click this host will act on.
  if (typeof last !== 'number') return 'refuse';
  if (activationSpent(win) || inheritsActivation(win, frame) || now - last <= ACTIVATION_LIFESPAN_MS) return 'confirm';
  return 'click';
}

export function clickedInsideFrame(win, frame, now = Date.now()) {
  return requestStanding(win, frame, now) === 'click';
}

// An address `openExternal` may open, normalised, or null. Only the web: a
// `file:`, `javascript:` or custom-scheme address is how a view would reach
// the machine through the system's URL handlers.
export function externalUrl(value) {
  try {
    const url = new URL(String(value));
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
  } catch (e) {
    return null;
  }
}

// SAVING THE MOUNTED FILE IS IN THIS TABLE; READING AND WRITING ARBITRARY
// RESOURCES IS NOT, AND THE DIFFERENCE IS THE POINT. `save` hands back the
// bytes of the one file this view was mounted for and names no path, so it
// needs no transport that resolves anything: the host has the path already.
// What follows is about the other thing.
//
// RESOURCE READ AND WRITE ARE NOT IN THIS TABLE, AND THAT IS A DECISION. An
// extension reading and writing its own declared resources is a real future
// capability, but it needs a server transport that resolves a resource id
// inside the extension's directory and enforces a byte cap, and none of that
// is built in this change. Naming read and write here while the server drops
// them would be the absent-contract failure this whole surface exists to
// avoid: a capability promised and unenforced. So they are absent, which
// means a read or write is an unnamed type and the mediator refuses it with
// a reason like any other. When the transport ships, the two rows and their
// enforcement arrive together.


// Messages the host may say to a frame, and the fields each carries. Listed
// for the contract test; the host never accepts these directions in reverse.
export const HOST_MESSAGES = ['init', 'refused', 'sources', 'theme'];
export const HOST_MESSAGE_FIELDS = {
  init: ['path', 'content', 'theme', 'sources', 'state'],
  refused: ['of', 'reason'],
  sources: ['sources'],
  theme: ['theme', 'tokens'],
};

// The host messages a view may opt into with `ready`'s `handles`. One today.
export const HOST_HANDLES = ['theme'];

// THE FRAME'S HALF OF `theme`, host code inlined in every frame's bootstrap
// ahead of Rundock UI and the entry, so it runs before the entry's own
// listener sees the same message. It answers only the frame's parent, and
// only a `theme` message: it rewrites the token block the host inlined at
// build and sets the body's `light` class, so Rundock UI and every style
// written in var(--...) restyle in place. The view's state is untouched,
// because nothing is rebuilt.
const THEME_BOOTSTRAP = 'window.addEventListener("message",function(e){'
  + 'if(e.source!==parent||!e.data||e.data.type!=="theme")return;'
  + 'var t=e.data.tokens,s=document.querySelector("style[data-rundock-tokens]");'
  + 'if(!s&&document.head){s=document.createElement("style");s.setAttribute("data-rundock-tokens","");document.head.insertBefore(s,document.head.firstChild);}'
  + 'if(s&&Array.isArray(t)){s.textContent=":root { "+t.filter(function(p){return Array.isArray(p)&&typeof p[0]==="string"&&typeof p[1]==="string";})'
  + '.map(function(p){return p[0]+": "+p[1]+";";}).join(" ")+" }";}'
  + 'if(document.body)document.body.classList.toggle("light",e.data.theme==="light");});';

// THE FRAME'S VIEW STATE, host code inlined in a mounted view's bootstrap,
// ahead of Rundock UI and the entry, holding the state the host kept for this
// note. It is data in the document, so `get` answers from the entry's first
// line, before any message could have arrived. It is frozen, and neither it
// nor `window.Rundock` can be replaced; Rundock UI adds `ui` to the same
// namespace. `set` changes the frame's copy and posts the whole state to the
// parent and nowhere else; the host checks it, and names no path from it.
// The state is inlined as a JSON string, parsed into an object with no
// prototype, so no key (not even "__proto__") is anything but an entry, and
// `<` and the line separators are escaped so no text can end the script.
export const VIEW_STATE_KEY = /^[A-Za-z0-9._:-]{1,64}$/;
function viewStateBootstrap(state) {
  const literal = JSON.stringify(JSON.stringify(state || {}))
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return '(function(){var kept=Object.assign(Object.create(null),JSON.parse(' + literal + ')),K=' + VIEW_STATE_KEY + ';'
    + 'function key(k){if(typeof k!=="string"||!K.test(k))throw new TypeError("Rundock.viewState: a key is 1 to 64 letters, digits, \\".\\", \\"_\\", \\":\\" or \\"-\\"");}'
    + 'var api=Object.freeze({get:function(k){key(k);return kept[k];},'
    + 'set:function(k,v){key(k);if(v===undefined)delete kept[k];else kept[k]=v;parent.postMessage({type:"setState",state:kept},"*");}});'
    + 'var ns={};Object.defineProperty(ns,"viewState",{value:api,enumerable:true});'
    + 'Object.defineProperty(window,"Rundock",{value:ns,enumerable:true});})();';
}

// The one shape a source takes on the wire: the name as the note wrote it and
// its text, or the name and why it was refused. Rebuilt field by field so
// nothing a caller attached (a resolved path, a size) can ride into a frame.
function wireSources(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((s) => s && typeof s.path === 'string').map((s) => (typeof s.content === 'string'
    ? { path: s.path, content: s.content }
    : { path: s.path, refused: typeof s.refused === 'string' ? s.refused : 'refused' }));
}

// Whether a write keeps the `sources` list of the file it writes, by the
// page's one grammar (public/named-sources-model.js, a classic script the
// page loads). No grammar means no answer, and no answer refuses the write.
function listKept(win, before, after) {
  const grammar = win && win.RundockNamedSources;
  if (!grammar || typeof grammar.sameSources !== 'function') return SOURCE_REFUSED_REASONS.unchecked;
  return grammar.sameSources(before, after) ? null : grammar.CHANGED_LIST_REASON;
}

// THE FRAME RECEIVES THE OPENED FILE, READ-ONLY, IN `init`: its workspace
// path, its text, and the theme the page shows, and nothing else about the
// page. A renderer needs the bytes to render and the theme to match, and a
// frame with an opaque origin has no other way to learn either. The text is
// a copy; the host never reads anything back from the frame, so no message
// in the closed table can change the file.
//
// THE CAP IS THE HOST'S, NOT THE CALLER'S. A file longer than this is not
// handed to a frame at all: the mount degrades to the plain rendering before
// any frame is appended, with the cap named, whichever caller mounts. One
// number, exported so the contract document is compared against it rather
// than allowed to promise a different one.
export const MAX_INIT_CONTENT_CHARS = 2000000;

// The frame height is a request, not a command. Clamped so a hostile or
// broken view cannot stretch the page into uselessness.
export const MIN_FRAME_HEIGHT = 40;
export const MAX_FRAME_HEIGHT = 4000;

// How long a view gets to say `ready` before it is judged hung. Injectable
// so the test does not wait it out in real time.
export const READY_TIMEOUT_MS = 5000;

// The frame document's own policy: no network of any kind, inline code and
// styles only (the payload is inlined by the host), data: images so a view
// can draw without fetching.
const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; "
  + "style-src 'unsafe-inline'; img-src data:;";

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// THE HOST'S DESIGN TOKENS REACH THE FRAME AS LITERAL VALUES. An
// opaque-origin frame inherits nothing, so a third-party stylesheet written
// in var(--accent) would resolve to nothing without help. The help is a
// :root block of the page's custom properties, inlined ahead of the
// extension's own styles so the extension reads the palette from the host
// while staying free to override its own layout. Two decisions here, both
// deliberate:
//
// The names are derived from the loaded stylesheets rather than kept as a
// list, so a token added to tokens.css reaches extensions without anyone
// remembering to update a copy. The values are read out of the computed
// style at frame build, which is the same approach the map canvas takes and
// for the same reason: the computed style is the one place the palette and
// the theme are already resolved, so a palette or theme change needs no
// second copy to chase.
//
// What crosses the boundary is a block of literal values, never a live
// reference: the frame gets the palette, not a handle to the page, so the
// sandbox posture above is exactly as opaque as it was before tokens
// existed.
export function hostTokenValues(doc) {
  const names = new Set();
  const collect = (rules) => {
    for (const rule of rules) {
      if (rule.style) {
        for (let i = 0; i < rule.style.length; i += 1) {
          if (rule.style[i].indexOf('--') === 0) names.add(rule.style[i]);
        }
      }
      // Grouping rules (media queries and the like) declare through nested
      // rules; walked so a token declared inside one still travels.
      if (rule.cssRules) collect(rule.cssRules);
    }
  };
  for (const sheet of doc.styleSheets) {
    // A stylesheet whose rules cannot be read (a cross-origin link would
    // throw) has nothing to offer; the rest still do.
    try { collect(sheet.cssRules); } catch (e) { /* unreadable sheet: skip */ }
  }
  // The values come off body, not the root element: the theme is a class
  // the toggle sets on body, so body is where the light overrides resolve.
  const computed = doc.defaultView.getComputedStyle(doc.body);
  const values = [];
  for (const name of [...names].sort()) {
    const value = computed.getPropertyValue(name).trim();
    if (value) values.push([name, value]);
  }
  return values;
}

/**
 * The base stylesheet every extension frame gets, as text.
 *
 * Read out of the page's own stylesheets rather than fetched, so building a
 * frame stays synchronous. The sheet is linked with `media="not all"`, which
 * is why it can be read here and yet styles nothing in Rundock itself.
 *
 * Answers '' when it cannot be found, and an extension then gets tokens and
 * its own styles exactly as before. A missing floor is a worse-looking
 * extension, never a broken one.
 */
function extensionBaseCss(doc) {
  for (const sheet of doc.styleSheets || []) {
    const node = sheet.ownerNode;
    if (!node || !node.hasAttribute || !node.hasAttribute('data-extension-base')) continue;
    try {
      return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
    } catch (e) {
      return ''; // unreadable sheet: the floor is optional, the frame is not
    }
  }
  return '';
}

function hostTokenCss(doc) {
  const declarations = hostTokenValues(doc).map(([name, value]) => `${name}: ${value};`).join(' ');
  return declarations ? `:root { ${declarations} }` : '';
}

// The frame's document, composed by the host so nothing arrives from
// anywhere but the installed payload and the host's own tokens: the token
// block first, then the extension's styles so they can read it, a bootstrap
// that forwards uncaught failures as `error` messages (a cross-origin frame
// cannot be observed from outside, so the frame reports on itself), and the
// entry script.
// Neutralise a closing tag the inlined payload could use to escape its own
// element: an entry containing the literal </script> (ordinary in a minified
// bundle) would otherwise close the script early, so the view never runs its
// rest and never says ready. The frame executes byte-equivalent code because
// the browser reads `<\/script>` inside a script element as the same source;
// the same holds for a stylesheet and </style>.
function neutraliseClose(text, tag) {
  return String(text || '').split(`</${tag}`).join(`<\\/${tag}`);
}

function buildSrcdoc(payload, tokenCss, baseCss, ui = { css: '', script: '', bodyClass: '' }, view = null) {
  // Marked so the frame's half of `theme` can find and rewrite it.
  const tokens = tokenCss ? `<style data-rundock-tokens>${neutraliseClose(tokenCss, 'style')}</style>` : '';
  // Tokens, then the floor, then Rundock UI, then the extension's own
  // styles. That order is the contract: the floor and the components read
  // the tokens, and an extension can override any of them deliberately. A
  // floor that won would be a cage. Rundock UI (docs/RUNDOCK-UI.md) is
  // inlined like the floor and runs before the entry, as the frame, with no
  // message of its own: see public/rundock-ui-frame.js.
  const base = baseCss ? `<style>${neutraliseClose(baseCss, 'style')}</style>` : '';
  const uiCss = ui.css ? `<style>${neutraliseClose(ui.css, 'style')}</style>` : '';
  const styles = tokens + base + uiCss + (payload.styles || [])
    .map((css) => `<style>${neutraliseClose(css, 'style')}</style>`).join('');
  // A mounted view also gets its state; a region renderer, which belongs to
  // no one note, does not.
  const bootstrap = 'window.onerror=function(m){parent.postMessage({type:"error",message:String(m)},"*");};' + THEME_BOOTSTRAP
    + (view ? viewStateBootstrap(view.state) : '');
  return '<!doctype html><html><head>'
    + `<meta http-equiv="Content-Security-Policy" content="${esc(FRAME_CSP)}">`
    + styles
    + `</head><body${ui.bodyClass ? ` class="${esc(ui.bodyClass)}"` : ''}>`
    + `<script>${bootstrap}</scr` + 'ipt>'
    + (ui.script ? `<script>${neutraliseClose(ui.script, 'script')}</scr` + 'ipt>' : '')
    + `<script>${neutraliseClose(payload.entry, 'script')}</scr` + 'ipt>'
    + '</body></html>';
}

/**
 * The document a headless render service runs in.
 *
 * The same construction a mounted view gets, deliberately: one builder, so
 * the posture cannot drift between a frame a person looks at and one that
 * only computes. A region frame is never seen, but it runs third-party code
 * under exactly the same sandbox and the same policy, and a second builder
 * here is how those two would quietly stop matching.
 */
export function buildRegionSrcdoc(payload, doc) {
  return buildSrcdoc(payload, doc ? hostTokenCss(doc) : '', doc ? extensionBaseCss(doc) : '', rundockUiFrameParts(doc));
}

/**
 * Validate one arriving message against the closed table.
 *
 * @returns {{ ok: true, type: string } | { ok: false, of: string, reason: string }}
 */
export function validateMessage(data) {
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
    return { ok: false, of: 'unknown', reason: 'a message must be an object with a string type' };
  }
  const shape = EXTENSION_MESSAGES[data.type];
  if (!shape) {
    return { ok: false, of: data.type, reason: `the contract names no message of type "${data.type}"` };
  }
  for (const [field, check] of Object.entries(shape)) {
    if (!check(data[field])) {
      return { ok: false, of: data.type, reason: `the contract requires "${field}" of a different shape on "${data.type}"` };
    }
  }
  return { ok: true, type: data.type };
}

// The theme the page shows: the class the theme toggle sets on body, read
// at mount time so the frame is told what is on screen when it appears.
function currentTheme(doc) {
  return doc.body && doc.body.classList.contains('light') ? 'light' : 'dark';
}

// THE HOST'S OWN BAR, above the view. When a request meets a live activation
// the host cannot attribute to a fresh click in that view, the person is
// asked, in Rundock's page, directly above the frame, never in the app's
// chrome. The frame cannot reach it: it is in the page's document, which a
// sandboxed frame with an opaque origin can neither draw into, read, nor
// send events to. Open and Dismiss act only for a trusted event (a real
// press, or a key on the focused button), and are disabled until the bar has
// been on screen for BAR_ARM_MS, so a click already on its way when the bar
// appears cannot land on Open. The press is a gesture on Rundock's own page,
// so any request in the seconds after it is put to the person again. One slot per page: a waiting request holds it, and a
// refusal line may use it only while nothing is waiting. Built from
// Rundock UI's alert and buttons, bound to the page's document through a
// private namespace, so the app's page gains no global.
export const BAR_ARM_MS = 400;
const slots = new WeakMap();
const pageUis = new WeakMap();
function pageUi(doc) {
  let ui = pageUis.get(doc);
  if (!ui) {
    ui = installRundockUi({ document: doc });
    pageUis.set(doc, ui);
  }
  return ui;
}
export function requestWaiting(doc) {
  const slot = slots.get(doc);
  return !!(slot && slot.kind === 'confirm');
}
function clearSlot(doc, owner) {
  const slot = slots.get(doc);
  if (!slot || (owner !== undefined && slot.owner !== owner)) return;
  slots.delete(doc);
  if (slot.node.parentNode) slot.node.parentNode.removeChild(slot.node);
}
function placeSlot(doc, pane, frame, slot) {
  clearSlot(doc);
  if (frame && frame.parentNode === pane) pane.insertBefore(slot.node, frame);
  else pane.insertBefore(slot.node, pane.firstChild);
  slots.set(doc, slot);
}

function showRequestBar({ doc, pane, frame, owner, message, onOpen, onDismiss }) {
  const ui = pageUi(doc);
  const answer = (act) => (event) => {
    if (!event || event.isTrusted !== true) return;
    clearSlot(doc, owner);
    act();
  };
  const open = ui.button({ label: 'Open', variant: 'primary', onClick: answer(onOpen), disabled: true });
  const dismiss = ui.button({ label: 'Dismiss', variant: 'secondary', onClick: answer(onDismiss), disabled: true });
  const actions = doc.createElement('span');
  actions.className = 'extension-request-actions';
  actions.appendChild(open);
  actions.appendChild(dismiss);
  const node = ui.alert({ tone: 'attention', message, action: actions, urgent: true });
  node.classList.add('extension-request');
  node.setAttribute('data-extension-request', 'confirm');
  placeSlot(doc, pane, frame, { kind: 'confirm', owner, node });
  doc.defaultView.setTimeout(() => {
    open.disabled = false;
    dismiss.disabled = false;
  }, BAR_ARM_MS);
}

function showRefusalLine({ doc, pane, frame, owner, message }) {
  if (requestWaiting(doc)) return;
  const ui = pageUi(doc);
  const node = ui.alert({
    tone: 'danger', message,
    action: { label: 'Dismiss', onClick: () => clearSlot(doc, owner) },
  });
  node.classList.add('extension-request');
  node.setAttribute('data-extension-request', 'refused');
  placeSlot(doc, pane, frame, { kind: 'refused', owner, node });
}

// The words, from what the request names. A file is named by its last
// segment, the way the tree shows it; an address in full.
function requestSubject(of, detail) {
  if (of === 'open') return String(detail.target).split('/').pop();
  if (of === 'openExternal') return detail.url;
  return detail.agentName;
}
export function confirmWords(of, detail) {
  const subject = requestSubject(of, detail);
  if (of === 'open') return `Open ${subject}?`;
  if (of === 'openExternal') return `Open ${subject} in a new tab?`;
  return `Start a conversation with ${subject} with a drafted message?`;
}
export function refusalWords(of, detail, extensionName) {
  const who = extensionName ? `The ${extensionName} extension` : 'This extension';
  const subject = requestSubject(of, detail);
  const tried = of === 'ask' ? `start a conversation with ${subject}` : `open ${subject}`;
  return `${who} tried to ${tried} without you asking, so Rundock stopped it.`;
}

let nextOwner = 1;

/**
 * Mount one extension view into a pane, for one opened file.
 *
 * @param {{
 *   paneElement: Element,
 *   payload: { entry: string, styles?: string[] },
 *   path?: string,
 *   content?: string,
 *   onOpen?: (target: string) => void,
 *   onDegrade: (reason: string) => void,
 *   readyTimeoutMs?: number,
 * }} opts
 *
 * `onDegrade` is not optional, deliberately: a host mounted with nowhere to
 * fall back to is a host that can lose the surface it was given, which the
 * contract forbids. The caller owns the plain rendering; the host only ever
 * promises to hand control back with the failure named.
 */
// Every live view's way to end itself for leaving. The desktop app stops a
// leaving frame BEFORE it navigates, so the frame never loads a second
// document and the host's own load count never sees it; the app tells the
// page instead, and the page ends every live view (see app.js). All of them,
// not one: Electron cannot say which frame it was in a way the frame could
// not have forged, and ending an honest view is a smaller cost than leaving a
// misbehaving one running quietly.
const liveViews = new Set();
export function endViewsForLeaving() {
  for (const end of [...liveViews]) end();
}

export function mountExtension(opts) {
  const {
    paneElement, payload, onOpen, onSave, onChange, onDegrade, embedded,
    readyTimeoutMs = READY_TIMEOUT_MS,
  } = opts;
  // Defaulted rather than required so every existing caller gets the safe
  // behaviour: the address opens in a new browsing context, never here.
  const onOpenExternal = typeof opts.onOpenExternal === 'function'
    ? opts.onOpenExternal
    : (url) => { paneElement.ownerDocument.defaultView.open(url, '_blank', 'noopener,noreferrer'); };
  // Whether this extension asked to write, read from the payload the server
  // built out of its manifest, never from anything the frame says. Defaulted
  // hard: a payload that has lost the field cannot write, because the safe
  // reading of "I do not know" is no.
  // An EMBEDDED view (a file shown inside another note) is read-only and
  // reaches no other file, whatever its manifest declared: embed to see,
  // open to edit. Enforced in dispatch, ahead of every message that writes
  // or navigates, so there is one place that says it.
  const writes = payload && payload.writes === true;
  // Sources are handed only to an extension whose record declared them, and
  // never to an embedded view, whatever the caller passes. The seam resolves
  // them only for a note claimed by a frontmatter marker.
  const declaresSources = !!(payload && payload.sources === true) && !embedded;
  let sources = declaresSources ? wireSources(opts.sources) : [];
  // The agents the record declared. Read as a list and checked by membership,
  // never used as keys, so a name like "constructor" is simply not in it.
  const asks = payload && Array.isArray(payload.asks) ? payload.asks.filter((a) => typeof a === 'string') : [];
  // The view's state as last kept: what the seam read at mount, held to the
  // same checks as a write, so a hand-edited file never reaches a view; then
  // each state this host accepts. `init` carries it.
  let viewState = opts.state !== undefined && opts.state !== null && !viewStateProblem(opts.state) ? opts.state : null;
  if (typeof onDegrade !== 'function') {
    throw new Error('mountExtension requires onDegrade: the plain rendering is the contract\'s floor');
  }
  const filePath = String(opts.path == null ? '' : opts.path);
  const content = typeof opts.content === 'string' ? opts.content : '';
  // The same shape as the live handle, so a caller that holds one need not
  // know which it holds: frame answers null the way a torn-down mount's
  // does, and swap answers null the way the live handle does.
  const inert = { alive: () => false, frame: () => null, dispatch() {}, teardown() {}, swap: () => null };
  // Over the cap, nothing is mounted: the plain rendering is the answer,
  // decided before a frame exists to tear down.
  if (content.length > MAX_INIT_CONTENT_CHARS) {
    onDegrade(`the file is ${content.length} characters, over the ${MAX_INIT_CONTENT_CHARS} character limit an extension view may receive`);
    return inert;
  }
  const doc = paneElement.ownerDocument;
  const win = doc.defaultView;
  // Who this mount is to the page's one bar, and the names its words use,
  // all from the caller, never from the frame.
  const owner = nextOwner++;
  const extensionName = typeof opts.extensionName === 'string' ? opts.extensionName : '';
  const agentName = (id) => {
    const named = typeof opts.agentName === 'function' ? opts.agentName(id) : null;
    return typeof named === 'string' && named ? named : id;
  };

  let frame = null;
  let alive = false;
  let readyTimer = null;
  let themeObserver = null;
  // The theme the live frame was built for, so the observer below can tell
  // a theme flip from unrelated churn on the body's class list.
  let mountedTheme = null;
  // Per FRAME, not per mount: a theme rebuild makes a new frame, which is
  // entitled to its own one `init`. Reset in buildFrame.
  let initSent = false;
  // Whether this frame's `ready` said it handles `theme`. Per frame too: a
  // rebuilt frame has said nothing yet.
  let handlesTheme = false;
  let loads = 0;

  function send(message) {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage(message, '*');
  }

  function teardown() {
    liveViews.delete(endForLeaving);
    clearSlot(doc, owner);
    if (readyTimer) { win.clearTimeout(readyTimer); readyTimer = null; }
    if (themeObserver) { themeObserver.disconnect(); themeObserver = null; }
    if (frame) {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
      frame = null;
    }
    alive = false;
    win.removeEventListener('message', onMessage);
  }

  function degrade(reason) {
    teardown();
    onDegrade(reason);
  }

  function endForLeaving() { if (alive) degrade(LEFT_VIEW_REASON); }

  // The one entry for arriving messages. Exposed on the handle as
  // `dispatch` so the wire can be driven by a test; the DOM listener below
  // is one line over it. Messages from any window that is not the live
  // frame are ignored entirely, including a frame this mount has since torn
  // down: replying to the dead would only teach it to keep talking.
  function dispatch(event) {
    // A frame that has reported a failure has been torn down by the time its
    // next message arrives (degrade runs synchronously), so everything it
    // says afterwards, a ready, an open, a second error, is ignored here.
    if (!alive || !frame || event.source !== frame.contentWindow) return;
    const verdict = validateMessage(event.data);
    if (!verdict.ok) {
      // ONE CLICK, ONE ASK, EVEN A MALFORMED ONE. The first ask after a click
      // spends it whatever its shape, or a view could send a malformed ask
      // and then a valid one and have the second honoured on the same click.
      if (verdict.of === 'ask' && !embedded && requestStanding(win, frame) === 'click') spendActivation(win);
      send({ type: 'refused', of: verdict.of, reason: verdict.reason });
      return;
    }
    const data = event.data;
    if (data.type === 'ready') {
      // ONE `init` PER FRAME. A second `ready` is what the page that replaced
      // the extension sends, and it arrives BEFORE the frame's second `load`
      // (measured), so it is caught here rather than left to the load count.
      if (initSent) { degrade(LEFT_VIEW_REASON); return; }
      initSent = true;
      handlesTheme = Array.isArray(data.handles) && data.handles.indexOf('theme') >= 0;
      if (readyTimer) { win.clearTimeout(readyTimer); readyTimer = null; }
      send({ type: 'init', path: filePath, content, theme: currentTheme(doc), sources, state: viewState });
      return;
    }
    if (data.type === 'error') {
      degrade(`the extension reported a failure: ${data.message}`);
      return;
    }
    if (data.type === 'resize') {
      const h = Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, data.height));
      if (frame) frame.style.height = `${h}px`;
      return;
    }
    if (data.type === 'ask') {
      if (embedded) { send({ type: 'refused', of: 'ask', reason: ASK_REFUSED_REASONS.embedded }); return; }
      // ONE ACTIVATION, ONE REQUEST, shared with open and openExternal. An
      // ask on a fresh click spends it whether or not it is then honoured,
      // so a view cannot probe several names on one click. The person is
      // never asked about an agent the manifest did not declare.
      const declared = asks.indexOf(data.agent) >= 0;
      const message = cleanAskMessage(data.message);
      gated('ask', { agentName: agentName(data.agent) }, ASK_REFUSED_REASONS.click, () => {
        if (!declared) { send({ type: 'refused', of: 'ask', reason: ASK_REFUSED_REASONS.undeclared }); return; }
        // Team membership and the new conversation are the app's to decide.
        // It answers a reason, or nothing; on success nothing is sent back.
        const refusal = typeof opts.onAsk === 'function'
          ? opts.onAsk(data.agent, message)
          : 'this view cannot ask an agent here';
        if (typeof refusal === 'string' && refusal) send({ type: 'refused', of: 'ask', reason: refusal });
      }, declared ? null : ASK_REFUSED_REASONS.undeclared);
      return;
    }
    if (data.type === 'setState') {
      // Read-only when embedded, as `save` and `change` are. The seam adds
      // the extension and the note; this hands it the state alone.
      if (embedded) { send({ type: 'refused', of: 'setState', reason: VIEW_STATE_REASONS.embedded }); return; }
      const problem = viewStateProblem(data.state);
      if (problem) { send({ type: 'refused', of: 'setState', reason: problem }); return; }
      viewState = data.state;
      if (typeof opts.onState === 'function') opts.onState(data.state);
      return;
    }
    if (data.type === 'saveSource' || data.type === 'changeSource') {
      if (!declaresSources) { send({ type: 'refused', of: data.type, reason: SOURCE_REFUSED_REASONS.none }); return; }
      if (!writes) { send({ type: 'refused', of: data.type, reason: 'this extension did not declare writes in its manifest' }); return; }
      const hit = sources.find((s) => s.path === data.source && typeof s.content === 'string');
      if (!hit) { send({ type: 'refused', of: data.type, reason: SOURCE_REFUSED_REASONS.unlisted }); return; }
      const why = listKept(win, hit.content, data.content);
      if (why) { send({ type: 'refused', of: data.type, reason: why }); return; }
      const cb = data.type === 'saveSource' ? opts.onSaveSource : (opts.onChangeSource || opts.onSaveSource);
      if (typeof cb === 'function') cb(hit.path, data.content);
      return;
    }
    if (embedded && (data.type === 'open' || data.type === 'save' || data.type === 'change')) {
      send({ type: 'refused', of: data.type, reason: 'an embedded view is read-only and cannot open another file; open this file to use it' });
      return;
    }
    if (data.type === 'open') {
      // A CLICK, OR NOTHING. Without this a view could open any file it can
      // name, with no one touching anything, and be mounted on it and handed
      // its content; with `writes` it could then rewrite it. A view may take
      // the person somewhere they clicked; it may not walk the workspace.
      const target = data.target;
      gated('open', { target }, CLICK_REFUSED_REASON, () => {
        if (typeof onOpen === 'function') onOpen(target);
      });
      return;
    }
    if (data.type === 'openExternal') {
      const url = externalUrl(data.url);
      if (!url) {
        send({ type: 'refused', of: 'openExternal', reason: 'openExternal takes an http or https address' });
        return;
      }
      gated('openExternal', { url }, CLICK_REFUSED_REASON, () => onOpenExternal(url));
      return;
    }
    if (data.type === 'save') {
      // A shape the table accepts is still not a thing every extension may
      // do. The refusal is the same named kind an unknown type gets, because
      // from where the extension stands the two are the same fact: this host
      // will not carry that message for you. Saying "you did not declare
      // writes" is the difference between an author fixing a manifest in a
      // minute and reading the host's source to guess.
      if (!writes) {
        send({ type: 'refused', of: 'save', reason: 'this extension did not declare writes in its manifest' });
        return;
      }
      // NO WRITE MAY CHANGE THE FILE'S `sources` LIST, for every extension,
      // declaring sources or not: a view that could rewrite its note's list
      // could name any file and be handed it next time. The server holds the
      // same rule again at write time.
      const why = listKept(win, content, data.content);
      if (why) { send({ type: 'refused', of: 'save', reason: why }); return; }
      // The host writes, and the path is the host's. Nothing from the frame
      // reaches this call but bytes.
      if (typeof onSave === 'function') onSave(data.content);
      return;
    }
    // THE VIEW CHANGED; SAVE WHEN THE PAUSE IS OVER. The same privilege as
    // `save`, and the same bytes-only shape, but the host decides when to
    // write: the caller's one debounce, shared with the editors and the
    // board, so an extension announcing every keystroke writes once.
    if (data.type === 'change') {
      if (!writes) {
        send({ type: 'refused', of: 'change', reason: 'this extension did not declare writes in its manifest' });
        return;
      }
      const why = listKept(win, content, data.content);
      if (why) { send({ type: 'refused', of: 'change', reason: why }); return; }
      if (typeof onChange === 'function') onChange(data.content);
      else if (typeof onSave === 'function') onSave(data.content);
      return;
    }
  }

  // THE ONE GATE for open, openExternal and ask. A fresh click in this view
  // is honoured and spent for every frame. A live activation the host
  // cannot attribute to one is put to the person in the bar, and Open
  // performs the request as the host's own act. No click at all is refused, to the extension with its reason and
  // to the person in the same place, naming what was stopped. `blocked` is
  // a refusal that stands whatever the click (an undeclared agent), so the
  // person is never asked about it.
  function gated(of, detail, clickReason, perform, blocked) {
    const standing = requestStanding(win, frame);
    if (standing === 'click') {
      spendActivation(win);
      perform();
      return;
    }
    if (standing === 'confirm' && !blocked) {
      if (requestWaiting(doc)) { send({ type: 'refused', of, reason: REQUEST_REASONS.waiting }); return; }
      showRequestBar({
        doc, pane: paneElement, frame, owner,
        message: confirmWords(of, detail),
        onOpen: () => { if (alive) perform(); },
        onDismiss: () => send({ type: 'refused', of, reason: REQUEST_REASONS.dismissed }),
      });
      return;
    }
    if (standing === 'confirm') { send({ type: 'refused', of, reason: blocked }); return; }
    send({ type: 'refused', of, reason: clickReason });
    showRefusalLine({ doc, pane: paneElement, frame, owner, message: refusalWords(of, detail, extensionName) });
  }

  function onMessage(event) { dispatch(event); }

  // One frame construction for the first mount and the theme rebuild, so
  // the posture cannot drift between the two paths. The token values are
  // read at build time, which is what makes the rebuild below sufficient
  // for a theme change: a fresh build reads the fresh computed style.
  function buildFrame() {
    mountedTheme = currentTheme(doc);
    frame = doc.createElement('iframe');
    frame.className = 'extension-frame';
    // The whole posture in one attribute, set before anything else so a
    // failure between here and the append can never leave a wider frame.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', 'Extension view');
    initSent = false;
    handlesTheme = false;
    loads = 0;
    // The frame's SECOND load is a new document in it, which is the view
    // leaving. Bound to this frame object so a late load from a frame a
    // theme rebuild has already replaced cannot end the new one.
    const built = frame;
    built.addEventListener('load', () => {
      if (built !== frame) return;
      loads += 1;
      if (loads > 1) degrade(LEFT_VIEW_REASON);
    });
    // An embedded view is told so on its body, so the floor gives it the
    // panel's surface and no padding (extension-base.css).
    const ui = rundockUiFrameParts(doc);
    if (embedded) ui.bodyClass = `${ui.bodyClass} rundock-embedded`.trim();
    frame.srcdoc = buildSrcdoc(payload, hostTokenCss(doc), extensionBaseCss(doc), ui, { state: viewState });
    paneElement.appendChild(frame);
    // A frame mounted while an activation is live did not earn it.
    noteMount(win, frame);
    readyTimer = win.setTimeout(() => {
      degrade(`the extension did not start within ${readyTimeoutMs}ms`);
    }, readyTimeoutMs);
  }

  // A THEME CHANGE WHILE MOUNTED. A view whose `ready` said it handles
  // `theme` is sent one, carrying the new theme and the token values read
  // off the page now; the frame's bootstrap restyles in place and the view
  // keeps everything it holds, including edits not yet saved. A view that
  // said nothing is rebuilt with the new theme's values, as every view was
  // before `theme` existed: it boots afresh from a new init and loses
  // transient state. Only an actual theme flip does either; other class
  // churn on body is left alone.
  function rebuildForTheme() {
    if (!alive || currentTheme(doc) === mountedTheme) return;
    if (handlesTheme && initSent) {
      mountedTheme = currentTheme(doc);
      send({ type: 'theme', theme: mountedTheme, tokens: hostTokenValues(doc) });
      return;
    }
    if (readyTimer) { win.clearTimeout(readyTimer); readyTimer = null; }
    if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
    frame = null;
    try {
      buildFrame();
    } catch (e) {
      degrade(`the extension could not be remounted for the theme change: ${String(e && e.message || e)}`);
    }
  }

  try {
    buildFrame();
    alive = true;
    liveViews.add(endForLeaving);
    win.addEventListener('message', onMessage);
    if (typeof win.MutationObserver === 'function' && doc.body) {
      themeObserver = new win.MutationObserver(rebuildForTheme);
      themeObserver.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    }
  } catch (e) {
    degrade(`the extension could not be mounted: ${String(e && e.message || e)}`);
    return inert;
  }

  const handle = {
    alive: () => alive,
    frame: () => frame,
    dispatch,
    teardown,
    // The sources changed on disk, or the list was resolved again: the new
    // list replaces the old one, for the write check too, and the frame is
    // told if it has had its init (before that, init carries it).
    // The server refused a write this view made (over the extension's total,
    // or a check the host also holds): the view is told, named, and keeps
    // its own copy.
    refuseState(reason) {
      if (alive && initSent && typeof reason === 'string') send({ type: 'refused', of: 'setState', reason });
    },
    updateSources(list) {
      if (!alive || !declaresSources) return;
      sources = wireSources(list);
      if (initSent) send({ type: 'sources', sources });
    },
    // An update or uninstall under a live mount: the old frame leaves
    // cleanly and, for an update, the new payload mounts fresh. The old
    // frame's window stops matching the live source the moment teardown
    // runs, so a late message from it is ignored by construction.
    swap(newPayload) {
      teardown();
      if (newPayload) {
        return mountExtension({ ...opts, payload: newPayload });
      }
      return null;
    },
  };
  return handle;
}
