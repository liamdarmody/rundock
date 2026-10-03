// Options for look-view: reading and checking them, with no browser and no
// server, so the rules can be unit tested on their own.
//
// look-view takes one screenshot of one view of the app, served from this
// checkout against the sanitized demo workspace. It reads its options from a
// JSON file at a fixed place in the checkout (OPTIONS_FILE below), because
// `npx playwright test` accepts no arguments of its own for a spec, and a
// fixed file is something an agent can write and then run one bare command.
//
// Every problem is reported as one plain sentence naming the option that is
// wrong and what would be accepted instead.

import path from 'node:path';

// Relative to the checkout root. `.rundock/` is gitignored, so neither the
// options nor the picture can be committed by accident.
export const OPTIONS_FILE = '.rundock/look-view.json';
export const DEFAULT_OUT = '.rundock/scratch/look-view.png';

// The views a person reaches from the left-hand navigation.
export const VIEWS = ['team', 'conversations', 'files', 'routines', 'settings', 'skills', 'map', 'pins'];
export const THEMES = ['dark', 'light'];

export const DEFAULTS = Object.freeze({
  view: 'team',
  theme: 'dark',
  width: 1440,
  height: 900,
  scale: 1,
  out: DEFAULT_OUT,
});

const KNOWN = new Set(['view', 'theme', 'width', 'height', 'scale', 'out', 'file', 'conversation', 'section', 'skill', 'element', 'actions']);
const TARGET_KEYS = ['selector', 'role', 'text', 'label'];

function fail(message) {
  const err = new Error(message);
  err.lookView = true;
  return err;
}

function intIn(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw fail(`"${name}" must be a whole number from ${min} to ${max}, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function nonEmptyString(name, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail(`"${name}" must be a non-empty string, got ${JSON.stringify(value)}.`);
  }
  return value;
}

// A target names one element: by CSS selector, by role (optionally with an
// accessible name), by visible text, or by label. Exactly one way per target.
function checkTarget(where, target) {
  if (typeof target === 'string') return { selector: nonEmptyString(where, target) };
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw fail(`${where} must name an element with one of ${TARGET_KEYS.join(', ')}.`);
  }
  const ways = TARGET_KEYS.filter((k) => target[k] !== undefined);
  if (ways.length !== 1) {
    throw fail(`${where} must name an element with exactly one of ${TARGET_KEYS.join(', ')}, got ${ways.length ? ways.join(' and ') : 'none'}.`);
  }
  const out = { [ways[0]]: nonEmptyString(`${where}.${ways[0]}`, target[ways[0]]) };
  if (target.name !== undefined) {
    if (ways[0] !== 'role') throw fail(`${where}.name only goes with "role".`);
    out.name = nonEmptyString(`${where}.name`, target.name);
  }
  return out;
}

// Actions run in order after the view is open:
//   { "click": <target> }
//   { "fill": <target>, "value": "text" }
//   { "press": "Escape" }
//   { "waitForText": "Saved" }
// where <target> is a CSS selector string or { "role": "button", "name": "Save" },
// { "text": "Plan the week" }, { "label": "Name" } or { "selector": "#x" }.
function checkAction(action, i) {
  const where = `actions[${i}]`;
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw fail(`${where} must be an object such as {"click": {"role": "button", "name": "Save"}}.`);
  }
  if (action.click !== undefined) return { type: 'click', target: checkTarget(`${where}.click`, action.click) };
  if (action.fill !== undefined) {
    if (typeof action.value !== 'string') throw fail(`${where} fills an element, so it needs a string "value".`);
    return { type: 'fill', target: checkTarget(`${where}.fill`, action.fill), value: action.value };
  }
  if (action.press !== undefined) return { type: 'press', key: nonEmptyString(`${where}.press`, action.press) };
  if (action.waitForText !== undefined) return { type: 'waitForText', text: nonEmptyString(`${where}.waitForText`, action.waitForText) };
  throw fail(`${where} must be one of click, fill, press or waitForText, got ${JSON.stringify(Object.keys(action))}.`);
}

// Checks raw options (already parsed from JSON) and returns a complete,
// normalised set. `root` is the checkout root that a relative "out" resolves
// against. Throws an Error with a plain message on the first problem.
export function normalizeOptions(raw, { root }) {
  if (raw == null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw fail('The options must be a JSON object.');
  const unknown = Object.keys(raw).filter((k) => !KNOWN.has(k));
  if (unknown.length) throw fail(`Unknown option ${unknown.map((k) => `"${k}"`).join(', ')}. Known options: ${[...KNOWN].join(', ')}.`);

  const view = raw.view === undefined ? DEFAULTS.view : raw.view;
  if (!VIEWS.includes(view)) throw fail(`View not found: ${JSON.stringify(view)}. Views: ${VIEWS.join(', ')}.`);

  const theme = raw.theme === undefined ? DEFAULTS.theme : raw.theme;
  if (!THEMES.includes(theme)) throw fail(`"theme" must be "dark" or "light", got ${JSON.stringify(theme)}.`);

  const out = path.resolve(root, raw.out === undefined ? DEFAULTS.out : nonEmptyString('out', raw.out));
  if (!out.toLowerCase().endsWith('.png')) throw fail(`"out" must end in .png, got ${JSON.stringify(raw.out)}.`);

  const forView = { file: 'files', conversation: 'conversations', section: 'settings', skill: 'skills' };
  for (const [key, owner] of Object.entries(forView)) {
    if (raw[key] !== undefined && view !== owner) throw fail(`"${key}" only applies to the ${owner} view, but the view is ${view}.`);
  }

  if (raw.actions !== undefined && !Array.isArray(raw.actions)) throw fail('"actions" must be a list.');

  return {
    view,
    theme,
    width: raw.width === undefined ? DEFAULTS.width : intIn('width', raw.width, 320, 3840),
    height: raw.height === undefined ? DEFAULTS.height : intIn('height', raw.height, 320, 2400),
    scale: raw.scale === undefined ? DEFAULTS.scale : intIn('scale', raw.scale, 1, 3),
    out,
    file: view === 'files' ? (raw.file === undefined ? 'Welcome.md' : nonEmptyString('file', raw.file)) : null,
    conversation: view === 'conversations' ? (raw.conversation === undefined ? null : nonEmptyString('conversation', raw.conversation)) : null,
    section: view === 'settings' ? (raw.section === undefined ? 'workspace' : nonEmptyString('section', raw.section)) : null,
    skill: view === 'skills' ? (raw.skill === undefined ? null : nonEmptyString('skill', raw.skill)) : null,
    element: raw.element === undefined ? null : nonEmptyString('element', raw.element),
    actions: (raw.actions || []).map(checkAction),
  };
}

// Parses the text of an options file. A missing file (text === null) means
// every default: the team chart, dark, 1440 by 900.
export function parseOptionsText(text, { root, source = OPTIONS_FILE } = {}) {
  if (text === null) return normalizeOptions({}, { root });
  let raw;
  try { raw = JSON.parse(text); } catch (err) {
    throw fail(`${source} is not valid JSON: ${err.message}`);
  }
  return normalizeOptions(raw, { root });
}

// A short human description of a target, for error messages.
export function describeTarget(t) {
  if (t.selector) return `selector ${JSON.stringify(t.selector)}`;
  if (t.role) return `role ${t.role}${t.name ? ` named ${JSON.stringify(t.name)}` : ''}`;
  if (t.text) return `text ${JSON.stringify(t.text)}`;
  return `label ${JSON.stringify(t.label)}`;
}
