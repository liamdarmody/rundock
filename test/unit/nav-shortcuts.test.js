'use strict';
// Unit tests for public/nav-shortcuts.js: the nav rail's keyboard shortcuts.
//
// The rail under test is the page's own, parsed from index.html with no
// scripts run, so a test that reorders it moves the real items rather than a
// copy written here. The client is a navigator-like object passed in, which
// is the only thing the modifier is ever read from.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const N = require('../../public/nav-shortcuts.js');

const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf-8');

const MAC = { platform: 'MacIntel', userAgentData: { platform: 'macOS' } };
const MAC_WITHOUT_HINTS = { platform: 'MacIntel' };
const WINDOWS = { platform: 'Win32', userAgentData: { platform: 'Windows' } };
const LINUX = { platform: 'Linux x86_64', userAgentData: { platform: 'Linux' } };
const UNREADABLE = { platform: '' };

// The page as a signed-in reader sees it: the rail on screen (the page ships
// it hidden until a workspace loads) and the palette closed.
function page() {
  const doc = new JSDOM(PAGE).window.document;
  doc.querySelector('.nav-rail').style.display = '';
  return doc;
}

// On screen unless it or an ancestor is hidden the two ways this page hides
// things: the hidden class and an inline display of none.
function shown(el) {
  for (let n = el; n; n = n.parentElement) {
    if (n.classList.contains('hidden') || n.style.display === 'none') return false;
  }
  return true;
}

function keydown(code, key, mods = {}) {
  return {
    code, key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, ...mods,
    defaultPrevented: !!mods.defaultPrevented,
    prevented: 0,
    preventDefault() { this.prevented++; this.defaultPrevented = true; },
  };
}
const digit = (n, mods) => keydown(`Digit${n}`, String(n), mods);
const comma = (mods) => keydown('Comma', ',', mods);
const held = (modifier) => (modifier === 'Meta' ? { metaKey: true } : { ctrlKey: true });

const mainNavs = (doc) => Array.from(doc.querySelectorAll('.nav-main button.nav-item[data-nav]'), (b) => b.getAttribute('data-nav'));
const navOf = (item) => (item ? item.getAttribute('data-nav') : null);

// The handler wired as app.js wires it, with a switchNav that does what the
// real one does to the rail: lights the section it arrives on.
function wired(doc, modifier, { blocked = () => false } = {}) {
  const calls = [];
  let view = 'chat';
  const onKey = N.createKeydownHandler({
    doc,
    modifier,
    switchNav: (nav) => {
      calls.push(nav);
      view = `${nav}-view`;
      doc.querySelectorAll('.nav-item[data-nav]').forEach((n) => n.classList.toggle('active', n.getAttribute('data-nav') === nav));
    },
    currentView: () => view,
    blocked,
    isShown: shown,
  });
  return { calls, onKey, moveTo(v) { view = v; } };
}

describe('the modifier comes from the client', () => {
  test('a Mac client answers Meta, from userAgentData or from navigator.platform alone', () => {
    assert.strictEqual(N.modifierFor(MAC), 'Meta');
    assert.strictEqual(N.modifierFor(MAC_WITHOUT_HINTS), 'Meta');
    assert.strictEqual(N.modifierFor({ platform: 'iPad' }), 'Meta');
  });

  test('Windows and Linux clients answer Control', () => {
    assert.strictEqual(N.modifierFor(WINDOWS), 'Control');
    assert.strictEqual(N.modifierFor(LINUX), 'Control');
  });

  test('userAgentData is read first, and an empty one falls back to navigator.platform', () => {
    assert.strictEqual(N.modifierFor({ platform: 'MacIntel', userAgentData: { platform: 'Windows' } }), 'Control');
    assert.strictEqual(N.modifierFor({ platform: 'MacIntel', userAgentData: { platform: '' } }), 'Meta');
    assert.strictEqual(N.modifierFor({ platform: 'Win32', userAgentData: { platform: 'macOS' } }), 'Meta');
  });

  test('the control failing: an unreadable platform falls back to Ctrl and the hints say Ctrl', () => {
    for (const client of [UNREADABLE, {}, undefined, null, { userAgentData: {} }, { platform: 42 }]) {
      assert.strictEqual(N.modifierFor(client), 'Control', `client ${JSON.stringify(client)}`);
    }
    const doc = page();
    const modifier = N.modifierFor(UNREADABLE);
    N.applyHints(doc, modifier);
    const first = doc.querySelector('.nav-main button.nav-item[data-nav]');
    assert.strictEqual(first.getAttribute('data-tooltip'), 'Conversations (Ctrl 1)');
    assert.strictEqual(first.getAttribute('aria-keyshortcuts'), 'Control+1');
    assert.strictEqual(navOf(N.match(digit(1, { ctrlKey: true }), modifier, doc)), mainNavs(doc)[0]);
    assert.strictEqual(N.match(digit(1, { metaKey: true }), modifier, doc), null);
  });
});

describe('binding by position', () => {
  test('the nth digit opens the nth main view, read from the page', () => {
    const doc = page();
    const order = mainNavs(doc);
    assert.strictEqual(order.length, 7, 'the rail this was written against has seven main views');
    order.forEach((nav, i) => {
      assert.strictEqual(navOf(N.match(digit(i + 1, { metaKey: true }), 'Meta', doc)), nav);
      assert.strictEqual(navOf(N.match(digit(i + 1, { ctrlKey: true }), 'Control', doc)), nav);
    });
  });

  test('8, 9 and 0 are unbound, the comma opens Settings, and the theme toggle has no key', () => {
    const doc = page();
    for (const n of [8, 9, 0]) assert.strictEqual(N.match(digit(n, { metaKey: true }), 'Meta', doc), null, `digit ${n}`);
    assert.strictEqual(navOf(N.match(comma({ metaKey: true }), 'Meta', doc)), 'settings');
    assert.strictEqual(navOf(N.match(comma({ ctrlKey: true }), 'Control', doc)), 'settings');
    assert.ok(!N.bindings(doc).some((b) => b.item.id === 'theme-toggle'));
  });

  test('digits match the physical key, so a layout that types another character still works', () => {
    const doc = page();
    const azerty = keydown('Digit2', 'é', { metaKey: true });
    assert.strictEqual(navOf(N.match(azerty, 'Meta', doc)), mainNavs(doc)[1]);
    assert.strictEqual(N.match(keydown('Numpad2', '2', { metaKey: true }), 'Meta', doc), null);
  });

  test('reordering the rail moves the bindings and the hints with it', () => {
    const doc = page();
    const main = doc.querySelector('.nav-main');
    const items = main.querySelectorAll('button.nav-item[data-nav]');
    const last = items[items.length - 1];
    const first = items[0];
    N.applyHints(doc, 'Meta');
    main.insertBefore(last, first);
    // The binding follows at once, because it reads the rail at the key press.
    assert.strictEqual(N.match(digit(1, { metaKey: true }), 'Meta', doc), last);
    assert.strictEqual(N.match(digit(2, { metaKey: true }), 'Meta', doc), first);
    // The hints follow once rebuilt, from the same read.
    N.applyHints(doc, 'Meta');
    assert.strictEqual(last.getAttribute('data-tooltip'), `${last.getAttribute('data-nav-label')} (⌘1)`);
    assert.strictEqual(last.getAttribute('aria-keyshortcuts'), 'Meta+1');
    assert.strictEqual(first.getAttribute('data-tooltip'), 'Conversations (⌘2)');
    assert.strictEqual(first.getAttribute('aria-keyshortcuts'), 'Meta+2');
  });

  test('an item moved out of the main group loses its hint when the hints are rebuilt', () => {
    const doc = page();
    N.applyHints(doc, 'Control');
    const map = doc.querySelector('.nav-main [data-nav="map"]');
    doc.querySelector('.nav-bottom').appendChild(map);
    N.applyHints(doc, 'Control');
    assert.strictEqual(map.getAttribute('data-tooltip'), 'Map');
    assert.strictEqual(map.hasAttribute('aria-keyshortcuts'), false);
    assert.strictEqual(N.match(digit(7, { ctrlKey: true }), 'Control', doc), null);
  });
});

describe('only the bare modifier acts', () => {
  for (const [modifier, other] of [['Meta', 'ctrlKey'], ['Control', 'metaKey']]) {
    test(`with ${modifier}: Shift, Alt, the other platform's modifier or both modifiers do nothing`, () => {
      const doc = page();
      const own = held(modifier);
      const refused = [
        digit(2, { ...own, shiftKey: true }),
        digit(2, { ...own, altKey: true }),
        digit(2, { [other]: true }),
        digit(2, { ...own, [other]: true }),
        digit(2, {}),
        comma({ ...own, shiftKey: true }),
        comma({ ...own, altKey: true }),
        comma({ [other]: true }),
      ];
      const { calls, onKey } = wired(doc, modifier);
      for (const event of refused) {
        assert.strictEqual(N.match(event, modifier, doc), null, JSON.stringify(event));
        onKey(event);
        assert.strictEqual(event.prevented, 0, `${JSON.stringify(event)} was prevented`);
      }
      assert.deepStrictEqual(calls, []);
    });
  }
});

describe('hints', () => {
  for (const [client, modifier, hint] of [[MAC, 'Meta', (k) => `⌘${k}`], [WINDOWS, 'Control', (k) => `Ctrl ${k}`], [LINUX, 'Control', (k) => `Ctrl ${k}`]]) {
    test(`a ${client.platform} client's tooltips and aria-keyshortcuts name the key that opens each item`, () => {
      const doc = page();
      N.applyHints(doc, N.modifierFor(client));
      const items = Array.from(doc.querySelectorAll('.nav-main button.nav-item[data-nav]'));
      items.forEach((item, i) => {
        assert.strictEqual(item.getAttribute('data-tooltip'), `${item.getAttribute('data-nav-label')} (${hint(i + 1)})`);
        assert.strictEqual(item.getAttribute('aria-keyshortcuts'), `${modifier}+${i + 1}`);
      });
      const settings = doc.querySelector('[data-nav="settings"]');
      assert.strictEqual(settings.getAttribute('data-tooltip'), `Settings (${hint(',')})`);
      assert.strictEqual(settings.getAttribute('aria-keyshortcuts'), `${modifier}+,`);
      const theme = doc.getElementById('theme-toggle');
      assert.strictEqual(theme.getAttribute('data-tooltip'), 'Theme');
      assert.strictEqual(theme.hasAttribute('aria-keyshortcuts'), false);
      // The hint and the key agree: the key each item names opens that item.
      for (const item of [...items, settings]) {
        const [mod, key] = item.getAttribute('aria-keyshortcuts').split('+');
        const event = key === ',' ? comma(held(mod)) : digit(key, held(mod));
        assert.strictEqual(N.match(event, modifier, doc), item);
      }
    });
  }

  test('the hint takes the form of the top bar search hint', () => {
    assert.strictEqual(N.hintFor('K', 'Meta'), '⌘K');
    assert.strictEqual(N.hintFor('K', 'Control'), 'Ctrl K');
  });

  test('applying the hints again rebuilds them rather than adding to them', () => {
    const doc = page();
    N.applyHints(doc, 'Meta');
    N.applyHints(doc, 'Meta');
    N.applyHints(doc, 'Control');
    const first = doc.querySelector('.nav-main button.nav-item[data-nav]');
    assert.strictEqual(first.getAttribute('data-tooltip'), 'Conversations (Ctrl 1)');
  });
});

describe('the handler', () => {
  test('a shortcut switches through the switch it is given and prevents only itself', () => {
    const doc = page();
    const { calls, onKey } = wired(doc, 'Meta');
    const press = digit(3, { metaKey: true });
    onKey(press);
    assert.deepStrictEqual(calls, [mainNavs(doc)[2]]);
    assert.strictEqual(press.prevented, 1);
    onKey(comma({ metaKey: true }));
    assert.deepStrictEqual(calls, [mainNavs(doc)[2], 'settings']);
  });

  test('copy, paste, select-all, undo, redo, zoom, find, save and the palette pass through untouched', () => {
    for (const modifier of ['Meta', 'Control']) {
      const doc = page();
      const { calls, onKey } = wired(doc, modifier);
      const own = held(modifier);
      const passing = [
        keydown('KeyC', 'c', own), keydown('KeyV', 'v', own), keydown('KeyA', 'a', own),
        keydown('KeyZ', 'z', own), keydown('KeyZ', 'z', { ...own, shiftKey: true }), keydown('KeyY', 'y', own),
        keydown('Equal', '=', own), keydown('Minus', '-', own), keydown('Digit0', '0', own),
        keydown('KeyF', 'f', own), keydown('KeyS', 's', own), keydown('KeyK', 'k', own),
      ];
      for (const event of passing) {
        onKey(event);
        assert.strictEqual(event.prevented, 0, `${modifier}+${event.key} was prevented`);
      }
      assert.deepStrictEqual(calls, []);
    }
  });

  test('while the search palette is open nothing happens, by its flag or by its dialog alone', () => {
    const doc = page();
    let open = true;
    const { calls, onKey } = wired(doc, 'Meta', { blocked: () => open });
    const whileFlagged = digit(2, { metaKey: true });
    onKey(whileFlagged);
    assert.strictEqual(whileFlagged.prevented, 0);
    open = false;
    doc.getElementById('palette-overlay').classList.remove('hidden');
    const whileShown = digit(2, { metaKey: true });
    onKey(whileShown);
    assert.strictEqual(whileShown.prevented, 0);
    assert.deepStrictEqual(calls, []);
    doc.getElementById('palette-overlay').classList.add('hidden');
    onKey(digit(2, { metaKey: true }));
    assert.deepStrictEqual(calls, [mainNavs(doc)[1]], 'the control: with the palette closed it acts');
  });

  test('while any modal dialog is open nothing happens', () => {
    for (const markup of ['<div role="dialog" aria-modal="true">x</div>', '<dialog open>x</dialog>']) {
      const doc = page();
      const { calls, onKey } = wired(doc, 'Control');
      doc.body.insertAdjacentHTML('beforeend', markup);
      const press = digit(2, { ctrlKey: true });
      onKey(press);
      assert.strictEqual(press.prevented, 0);
      assert.deepStrictEqual(calls, []);
    }
  });

  test('with the rail off screen, as on the workspace picker, nothing happens', () => {
    const doc = page();
    doc.querySelector('.nav-rail').style.display = 'none';
    const { calls, onKey } = wired(doc, 'Meta');
    const press = digit(1, { metaKey: true });
    onKey(press);
    assert.strictEqual(press.prevented, 0);
    assert.deepStrictEqual(calls, []);
  });

  test('a key another handler already claimed is left to it', () => {
    const doc = page();
    const { calls, onKey } = wired(doc, 'Meta');
    onKey(digit(2, { metaKey: true, defaultPrevented: true }));
    assert.deepStrictEqual(calls, []);
  });

  test('the retry: holding the key or pressing it five times arrives once', () => {
    const doc = page();
    const { calls, onKey, moveTo } = wired(doc, 'Meta');
    const held7 =[digit(7, { metaKey: true }), ...Array.from({ length: 4 }, () => digit(7, { metaKey: true, repeat: true }))];
    for (const event of held7) onKey(event);
    assert.ok(held7.every((e) => e.prevented === 1), 'every repeat of its own key is still its own');
    for (let i = 0; i < 5; i++) onKey(digit(7, { metaKey: true }));
    assert.deepStrictEqual(calls, ['map']);
    // A view that finishes loading while the key is still held moves on
    // under it; the held key is still one press.
    onKey(digit(2, { metaKey: true }));
    moveTo('profile');
    for (let i = 0; i < 4; i++) onKey(digit(2, { metaKey: true, repeat: true }));
    assert.deepStrictEqual(calls, ['map', 'team']);
  });

  test('pressing the same key after moving within the section arrives again, as a click would', () => {
    const doc = page();
    const { calls, onKey, moveTo } = wired(doc, 'Meta');
    const team = mainNavs(doc)[1];
    onKey(digit(2, { metaKey: true }));
    moveTo('profile');
    onKey(digit(2, { metaKey: true }));
    assert.deepStrictEqual(calls, [team, team]);
  });

  test('pressing a key after leaving by other means arrives again', () => {
    const doc = page();
    const { calls, onKey } = wired(doc, 'Meta');
    onKey(digit(7, { metaKey: true }));
    doc.querySelector('[data-nav="map"]').classList.remove('active');
    onKey(digit(7, { metaKey: true }));
    assert.deepStrictEqual(calls, ['map', 'map']);
  });
});
