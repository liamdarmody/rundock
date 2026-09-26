'use strict';
// Rundock UI, held to its contract: every factory's states, events and
// accessibility wiring, read off the elements it returns.
//
// INSTALLED FROM ITS OWN SOURCE TEXT, the way a frame gets it. The host
// inlines `(installRundockUi)(window)` into every extension frame, so a
// library that reached for anything in its module's scope would work when
// imported and break in a frame. Every test here runs the library as that
// text in a fresh window, so the frame's path is the one tested.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

let frameModule = null;
async function frameParts() {
  if (!frameModule) frameModule = await import('../../public/rundock-ui-frame.js');
  return frameModule;
}

async function fresh(bodyClass = '') {
  const { rundockUiScript } = await frameParts();
  const dom = new JSDOM(`<!doctype html><html><body class="${bodyClass}"><div id="root"></div></body></html>`, {
    runScripts: 'outside-only', pretendToBeVisual: true,
  });
  dom.window.eval(rundockUiScript());
  const win = dom.window;
  const root = win.document.getElementById('root');
  const mount = (node) => { root.appendChild(node); return node; };
  const key = (target, k, extra = {}) => target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  return { win, doc: win.document, ui: win.Rundock.ui, mount, key };
}

const FACTORIES = [
  'button', 'iconButton', 'card', 'field', 'input', 'select', 'checkbox', 'toggle', 'slider', 'tabs', 'table',
  'chip', 'emptyState', 'loading', 'board', 'canvas', 'meter', 'alert', 'stat', 'optionList',
  'relativeTime', 'liveChip', 'menu',
];

describe('the library', () => {
  test('installs from its source text alone, with every factory and a version', async () => {
    const { ui } = await fresh();
    assert.deepStrictEqual(Object.keys(ui).filter((k) => k !== 'version').sort(), [...FACTORIES].sort());
    for (const name of FACTORIES) assert.strictEqual(typeof ui[name], 'function', name);
    assert.match(ui.version, /^\d+\.\d+$/);
    assert.ok(Object.isFrozen(ui), 'the factory set is frozen, so an extension cannot swap a component out from under another');
  });

  test('the exported factory list is the installed one', async () => {
    const { RUNDOCK_UI_FACTORIES } = await import('../../public/rundock-ui.js');
    assert.deepStrictEqual([...RUNDOCK_UI_FACTORIES].sort(), [...FACTORIES].sort());
  });

  test('a second install hands back the first', async () => {
    const { win, ui } = await fresh();
    const { rundockUiScript } = await frameParts();
    win.eval(rundockUiScript());
    assert.strictEqual(win.Rundock.ui, ui);
  });

  test('its source has no way out of the frame: no messages, no parent, no network, no parsed markup', async () => {
    // What the library may not do, read off the exact text the host
    // inlines. A library that posted a message would be a new message type
    // the host's closed table never named; one that read the parent would
    // be reaching past the opaque origin; one that fetched would be asking
    // the frame's policy to refuse it. None of it is needed to build an
    // element, so none of it is allowed in the source.
    const { rundockUiScript } = await frameParts();
    const source = rundockUiScript();
    const banned = [/postMessage/, /\bparent\b/, /\b(?:window|win|self|globalThis)\.top\b/, /\bopener\b/, /\bfetch\s*\(/,
      /XMLHttpRequest/, /WebSocket/, /EventSource/, /\beval\s*\(/, /\bFunction\s*\(/, /innerHTML/, /outerHTML/,
      /insertAdjacentHTML/, /\bimport\s*\(/, /localStorage/, /sessionStorage/, /\.cookie\b/, /\bsrc\s*=/, /\bhref\b/];
    for (const pattern of banned) {
      assert.ok(!pattern.test(source), `the library source matches ${pattern}`);
    }
  });

  test('its source never reads the bare global top, the frame\'s way to the window above it', async () => {
    // `top` as a bare identifier is the top-level browsing context, reachable
    // without naming window. A property called top (an element's style.top, a
    // rectangle's top) is not it, and neither is the word in a comment or a
    // string, so those are blanked before the scan, and the scan is proved on
    // specimens of each first.
    const code = (text) => text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");
    const BARE_TOP = /(^|[^.\w$])top\b(?!\s*:(?!:))/;
    for (const bites of ['var t = top;', 'top.postMessage(x)', 'if (top !== self) {}', '(top)', 'const w = [top];']) {
      assert.ok(BARE_TOP.test(code(bites)), `the scan misses the bare global in: ${bites}`);
    }
    for (const silent of ['el.style.top = 1;', 'rect.top + 4', "x = 'top';", '// scrolled to the top', '/* top */', '{ top: 2 }', 'obj.$top', 'stop()', 'topmost', '`from the top`']) {
      assert.ok(!BARE_TOP.test(code(silent)), `the scan trips on legitimate text: ${silent}`);
    }
    const { rundockUiScript } = await frameParts();
    const found = code(rundockUiScript()).split('\n').filter((line) => BARE_TOP.test(line));
    assert.deepStrictEqual(found, [], 'the inlined library reads the bare global top');
  });

  test('a label is text, never markup', async () => {
    const { ui } = await fresh();
    const b = ui.button({ label: '<img src=x onerror=alert(1)>' });
    assert.strictEqual(b.querySelector('img'), null);
    assert.strictEqual(b.textContent, '<img src=x onerror=alert(1)>');
  });
});

describe('button', () => {
  test('each variant is a native button of its class, secondary by default', async () => {
    const { ui } = await fresh();
    for (const variant of ['primary', 'secondary', 'danger', 'danger-confirm']) {
      const b = ui.button({ label: 'Go', variant });
      assert.strictEqual(b.tagName, 'BUTTON');
      assert.strictEqual(b.type, 'button');
      assert.ok(b.classList.contains(`rui-btn-${variant}`), variant);
    }
    assert.ok(ui.button({ label: 'Go' }).classList.contains('rui-btn-secondary'));
  });

  test('an unknown variant is refused by name', async () => {
    const { ui } = await fresh();
    assert.throws(() => ui.button({ label: 'x', variant: 'huge' }), /Rundock\.ui\.button: variant must be one of primary, secondary, danger, danger-confirm/);
  });

  test('onClick fires on a click, and not when disabled', async () => {
    const { ui, mount } = await fresh();
    let clicks = 0;
    const b = mount(ui.button({ label: 'Go', onClick: () => { clicks += 1; } }));
    b.click();
    assert.strictEqual(clicks, 1);
    const d = mount(ui.button({ label: 'Go', disabled: true, onClick: () => { clicks += 1; } }));
    assert.strictEqual(d.disabled, true);
    d.click();
    assert.strictEqual(clicks, 1);
  });
});

describe('iconButton', () => {
  test('a named native button with a decorative icon, the default 32px variant unless told', async () => {
    const { ui } = await fresh();
    const b = ui.iconButton({ label: 'More actions' });
    assert.strictEqual(b.tagName, 'BUTTON');
    assert.strictEqual(b.type, 'button');
    assert.strictEqual(b.getAttribute('aria-label'), 'More actions');
    assert.ok(b.classList.contains('rui-icon-btn') && !b.classList.contains('rui-icon-btn-send'));
    assert.strictEqual(b.querySelector('svg').getAttribute('aria-hidden'), 'true');
    assert.throws(() => ui.iconButton({}), /label must name the button/);
    assert.throws(() => ui.iconButton({ label: 'x', icon: 'rocket' }), /icon must be an element or one of/);
    assert.throws(() => ui.iconButton({ label: 'x', variant: 'huge' }), /variant must be one of default, send/);
  });

  test('the send variant moves through empty, active and cancel, renaming itself for the stop', async () => {
    const { ui, mount } = await fresh();
    const seen = [];
    const b = mount(ui.iconButton({ label: 'Send message', variant: 'send', onClick: (e, state) => seen.push(state) }));
    assert.ok(b.classList.contains('rui-icon-btn-send'));
    assert.ok(!b.classList.contains('rui-active') && !b.classList.contains('rui-cancel'), 'empty by default');
    b.setState('active');
    assert.ok(b.classList.contains('rui-active'));
    b.click();
    b.setState('cancel');
    assert.ok(b.classList.contains('rui-cancel') && !b.classList.contains('rui-active'));
    assert.strictEqual(b.getAttribute('aria-label'), 'Stop');
    assert.ok(b.querySelector('rect'), 'the stop square replaces the arrow');
    b.click();
    b.setState('empty');
    assert.strictEqual(b.getAttribute('aria-label'), 'Send message');
    assert.ok(b.querySelector('polyline'), 'the arrow is back');
    assert.deepStrictEqual(seen, ['active', 'cancel']);
    assert.throws(() => b.setState('busy'), /state must be one of empty, active, cancel/);
    assert.throws(() => ui.iconButton({ label: 'x' }).setState('active'), /only the send variant has a state/);
  });

  test('disabled holds the click', async () => {
    const { ui, mount } = await fresh();
    let hits = 0;
    const b = mount(ui.iconButton({ label: 'Send', variant: 'send', disabled: true, onClick: () => { hits += 1; } }));
    b.click();
    assert.strictEqual(hits, 0);
  });
});

describe('card', () => {
  test('actions sit at the end of a header row beside the title; without them the card is exactly what it was', async () => {
    const { ui } = await fresh();
    assert.strictEqual(ui.card({ title: 'T', subtitle: 'S', children: 'c' }).outerHTML,
      '<div class="rui-card"><div class="rui-card-title">T</div><div class="rui-card-sub">S</div>c</div>', 'no actions: unchanged');
    const tabs = ui.tabs({ label: 'Group by', options: ['Asset', 'Sector'] });
    const hint = ui.button({ label: 'Add' });
    const card = ui.card({ title: 'Portfolio & allocation', subtitle: 'By value.', actions: [tabs, hint], children: 'body' });
    const head = card.firstElementChild;
    assert.ok(head.classList.contains('rui-card-head'));
    assert.deepStrictEqual([...head.children].map((c) => c.className), ['rui-card-title', 'rui-card-actions']);
    assert.strictEqual(head.querySelector('.rui-card-title').textContent, 'Portfolio & allocation');
    assert.deepStrictEqual([...head.querySelector('.rui-card-actions').children], [tabs, hint], 'in the order given');
    assert.strictEqual(head.nextElementSibling.className, 'rui-card-sub', 'the subtitle stays under the title row');
    assert.strictEqual(card.lastChild.textContent, 'body');
    const one = ui.card({ title: 'Decision board', actions: hint });
    assert.strictEqual(one.querySelector('.rui-card-actions').firstElementChild, hint, 'one element is fine');
    assert.throws(() => ui.card({ title: 'x', actions: 'Move a card' }), /actions must be an element or an array of elements/);
    assert.throws(() => ui.card({ title: 'x', actions: [hint, 'x'] }), /actions must be an element or an array of elements/);
  });

  test('a plain card is a div with no role', async () => {
    const { ui } = await fresh();
    const c = ui.card({ title: 'Risk', subtitle: 'Limits', children: [ui.chip({ label: 'x' })] });
    assert.strictEqual(c.getAttribute('role'), null);
    assert.strictEqual(c.querySelector('.rui-card-title').textContent, 'Risk');
    assert.strictEqual(c.querySelector('.rui-card-sub').textContent, 'Limits');
    assert.ok(c.querySelector('.rui-chip'));
  });

  test('an interactive card is a keyboard button: role, tab stop, Enter and Space', async () => {
    const { ui, mount, key } = await fresh();
    let hits = 0;
    const c = mount(ui.card({ title: 'Open', interactive: true, onClick: () => { hits += 1; } }));
    assert.strictEqual(c.getAttribute('role'), 'button');
    assert.strictEqual(c.tabIndex, 0);
    key(c, 'Enter');
    key(c, ' ');
    c.click();
    assert.strictEqual(hits, 3);
    assert.throws(() => ui.card({ interactive: true }), /needs onClick/);
  });
});

describe('field', () => {
  test('the label is wired to the control and help describes it', async () => {
    const { ui } = await fresh();
    const control = ui.input({});
    const f = ui.field({ label: 'Position size', control, help: 'Percentage of value.' });
    const label = f.querySelector('label');
    assert.strictEqual(label.getAttribute('for'), control.id);
    assert.ok(control.id);
    const help = f.querySelector('.rui-field-help');
    assert.strictEqual(control.getAttribute('aria-describedby'), help.id);
    assert.strictEqual(control.getAttribute('aria-invalid'), null);
  });

  test('an error sets aria-invalid and points aria-describedby at the error text', async () => {
    const { ui } = await fresh();
    const control = ui.input({});
    const f = ui.field({ label: 'Size', control, help: 'Help', error: 'Exceeds the 8% limit.' });
    const error = f.querySelector('.rui-field-error-text');
    assert.strictEqual(control.getAttribute('aria-invalid'), 'true');
    assert.strictEqual(control.getAttribute('aria-describedby'), error.id);
    assert.strictEqual(error.textContent, 'Exceeds the 8% limit.');
    assert.strictEqual(f.querySelector('.rui-field-help').hidden, true);
    assert.ok(f.classList.contains('rui-field-error'));
    f.setError(null);
    assert.strictEqual(control.getAttribute('aria-invalid'), null);
    assert.strictEqual(error.hidden, true);
    assert.strictEqual(control.getAttribute('aria-describedby'), f.querySelector('.rui-field-help').id);
  });

  test('wraps a select by labelling the select inside it', async () => {
    const { ui } = await fresh();
    const s = ui.select({ options: ['a', 'b'] });
    const f = ui.field({ label: 'Status', control: s });
    assert.strictEqual(f.querySelector('label').getAttribute('for'), s.querySelector('select').id);
  });

  test('refuses a control that is not one', async () => {
    const { ui, doc } = await fresh();
    assert.throws(() => ui.field({ label: 'x', control: doc.createElement('div') }), /control must be an input/);
  });
});

describe('input', () => {
  test('text by default; number is right-aligned, tabular, with a decimal keyboard', async () => {
    const { ui } = await fresh();
    const t = ui.input({ value: 'CRWD', placeholder: 'Search' });
    assert.strictEqual(t.type, 'text');
    assert.strictEqual(t.value, 'CRWD');
    assert.strictEqual(t.placeholder, 'Search');
    const n = ui.input({ type: 'number', value: '196,500.00' });
    assert.strictEqual(n.getAttribute('inputmode'), 'decimal');
    assert.ok(n.classList.contains('rui-input-numeric') && n.classList.contains('rui-input-right'));
    assert.ok(!ui.input({ type: 'number', align: 'left' }).classList.contains('rui-input-right'));
  });

  test('read-only, disabled and invalid are real states', async () => {
    const { ui } = await fresh();
    assert.strictEqual(ui.input({ readOnly: true }).readOnly, true);
    assert.strictEqual(ui.input({ disabled: true }).disabled, true);
    assert.strictEqual(ui.input({ invalid: true }).getAttribute('aria-invalid'), 'true');
  });

  test('onChange hears every input with the value', async () => {
    const { ui, win } = await fresh();
    const seen = [];
    const i = ui.input({ onChange: (v) => seen.push(v) });
    i.value = 'AB';
    i.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.deepStrictEqual(seen, ['AB']);
  });
});

describe('select', () => {
  test('a native select with its options, value and a decorative arrow', async () => {
    const { ui, win } = await fresh();
    const seen = [];
    const wrap = ui.select({ options: [{ value: 'r', label: 'Researching' }, 'Open'], value: 'Open', onChange: (v) => seen.push(v) });
    const s = wrap.querySelector('select');
    assert.deepStrictEqual([...s.options].map((o) => [o.value, o.textContent]), [['r', 'Researching'], ['Open', 'Open']]);
    assert.strictEqual(s.value, 'Open');
    assert.strictEqual(wrap.querySelector('svg').getAttribute('aria-hidden'), 'true');
    s.value = 'r';
    s.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.deepStrictEqual(seen, ['r']);
  });

  test('disabled reaches the native control', async () => {
    const { ui } = await fresh();
    assert.strictEqual(ui.select({ options: ['a'], disabled: true }).querySelector('select').disabled, true);
  });
});

describe('checkbox and toggle', () => {
  test('a checkbox is a native box inside its label, and indeterminate is the property', async () => {
    const { ui, mount } = await fresh();
    const seen = [];
    const row = mount(ui.checkbox({ label: 'Prefer tax-advantaged', indeterminate: true, onChange: (v) => seen.push(v) }));
    assert.strictEqual(row.tagName, 'LABEL');
    const box = row.querySelector('input');
    assert.strictEqual(box.type, 'checkbox');
    assert.strictEqual(box.indeterminate, true);
    assert.strictEqual(box.hasAttribute('indeterminate'), false, 'there is no indeterminate attribute; the property is the state');
    row.click();
    assert.deepStrictEqual(seen, [true]);
  });

  test('a disabled checkbox holds its state', async () => {
    const { ui, mount } = await fresh();
    const row = mount(ui.checkbox({ label: 'x', checked: true, disabled: true }));
    row.click();
    assert.strictEqual(row.querySelector('input').checked, true);
  });

  test('a toggle is a checkbox with the switch role', async () => {
    const { ui, mount } = await fresh();
    const seen = [];
    const row = mount(ui.toggle({ label: 'Harvest losses', checked: true, onChange: (v) => seen.push(v) }));
    const box = row.querySelector('input');
    assert.strictEqual(box.getAttribute('role'), 'switch');
    assert.strictEqual(box.checked, true);
    row.click();
    assert.deepStrictEqual(seen, [false]);
  });
});

describe('slider', () => {
  test('aria-valuetext replaces the raw number and follows every input', async () => {
    const { ui, win } = await fresh();
    const seen = [];
    const wrap = ui.slider({ label: 'Max single position', value: 8, min: 0, max: 100, format: (v) => `${v} percent`, onChange: (v) => seen.push(v) });
    const range = wrap.querySelector('input[type=range]');
    const shown = wrap.querySelector('.rui-slider-value b');
    assert.strictEqual(range.getAttribute('aria-valuetext'), '8 percent');
    assert.strictEqual(shown.textContent, '8 percent');
    assert.strictEqual(range.getAttribute('aria-describedby'), shown.id, 'the visible value is a redundant, always-current description');
    assert.strictEqual(win.document.getElementById(range.getAttribute('aria-labelledby')), null, 'not yet in the document');
    assert.strictEqual(wrap.querySelector(`#${range.getAttribute('aria-labelledby')}`).textContent, 'Max single position');
    assert.strictEqual(range.style.getPropertyValue('--rui-fill'), '8%');
    range.value = '35';
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.strictEqual(range.getAttribute('aria-valuetext'), '35 percent');
    assert.strictEqual(shown.textContent, '35 percent');
    assert.strictEqual(range.style.getPropertyValue('--rui-fill'), '35%');
    assert.deepStrictEqual(seen, [35]);
  });

  test('refuses a range that is not one', async () => {
    const { ui } = await fresh();
    assert.throws(() => ui.slider({ min: 5, max: 5 }), /max must be a number greater than min/);
  });
});

describe('tabs, the WAI-ARIA Tabs pattern with automatic activation', () => {
  async function three(extra = {}) {
    const env = await fresh();
    const seen = [];
    const list = env.mount(env.ui.tabs({ label: 'Portfolio views', options: ['Overview', 'Positions', 'Risk'], value: 'Positions', onChange: (v) => seen.push(v), ...extra }));
    return { ...env, list, tabs: [...list.querySelectorAll('[role=tab]')], seen };
  }
  const state = (tabs) => tabs.map((t) => `${t.getAttribute('aria-selected')}/${t.tabIndex}`);

  test('a named tablist whose selected tab is the one tab stop', async () => {
    const { list, tabs } = await three();
    assert.strictEqual(list.getAttribute('role'), 'tablist');
    assert.strictEqual(list.getAttribute('aria-label'), 'Portfolio views');
    assert.deepStrictEqual(state(tabs), ['false/-1', 'true/0', 'false/-1']);
  });

  test('ArrowRight and ArrowLeft move focus and selection together, wrapping', async () => {
    const { tabs, key, doc, seen } = await three();
    tabs[1].focus();
    key(tabs[1], 'ArrowRight');
    assert.strictEqual(doc.activeElement, tabs[2]);
    assert.deepStrictEqual(state(tabs), ['false/-1', 'false/-1', 'true/0']);
    key(tabs[2], 'ArrowRight');
    assert.strictEqual(doc.activeElement, tabs[0], 'wraps from the last to the first');
    key(tabs[0], 'ArrowLeft');
    assert.strictEqual(doc.activeElement, tabs[2], 'wraps from the first to the last');
    assert.deepStrictEqual(seen, ['Risk', 'Overview', 'Risk']);
  });

  test('Home and End jump to the ends', async () => {
    const { tabs, key, doc } = await three();
    tabs[1].focus();
    key(tabs[1], 'End');
    assert.strictEqual(doc.activeElement, tabs[2]);
    key(tabs[2], 'Home');
    assert.strictEqual(doc.activeElement, tabs[0]);
    assert.deepStrictEqual(state(tabs), ['true/0', 'false/-1', 'false/-1']);
  });

  test('a click selects without a key, and other keys do nothing', async () => {
    const { tabs, key, seen } = await three();
    tabs[0].click();
    assert.deepStrictEqual(state(tabs), ['true/0', 'false/-1', 'false/-1']);
    key(tabs[0], 'ArrowDown');
    assert.deepStrictEqual(state(tabs), ['true/0', 'false/-1', 'false/-1'], 'a horizontal tablist ignores the vertical arrows');
    assert.deepStrictEqual(seen, ['Overview']);
  });

  test('vertical orientation moves on ArrowDown and ArrowUp', async () => {
    const { list, tabs, key, doc } = await three({ orientation: 'vertical' });
    assert.strictEqual(list.getAttribute('aria-orientation'), 'vertical');
    tabs[1].focus();
    key(tabs[1], 'ArrowDown');
    assert.strictEqual(doc.activeElement, tabs[2]);
    key(tabs[2], 'ArrowRight');
    assert.strictEqual(doc.activeElement, tabs[2]);
  });

  test('panels, when given, are wired both ways and shown only for the selected tab', async () => {
    const { ui, mount, doc } = await fresh();
    const a = doc.createElement('div');
    const b = doc.createElement('div');
    const list = mount(ui.tabs({ label: 'x', options: [{ value: 'a', label: 'A', panel: a }, { value: 'b', label: 'B', panel: b }] }));
    const [ta, tb] = list.querySelectorAll('[role=tab]');
    assert.strictEqual(a.getAttribute('role'), 'tabpanel');
    assert.strictEqual(ta.getAttribute('aria-controls'), a.id);
    assert.strictEqual(a.getAttribute('aria-labelledby'), ta.id);
    assert.deepStrictEqual([a.hidden, b.hidden], [false, true]);
    tb.click();
    assert.deepStrictEqual([a.hidden, b.hidden], [true, false]);
  });

  test('a tablist must be named', async () => {
    const { ui } = await fresh();
    assert.throws(() => ui.tabs({ options: ['a'] }), /label must name the tab list/);
  });
});

describe('option list, the WAI-ARIA Radio Group pattern', () => {
  async function four(value) {
    const env = await fresh();
    const seen = [];
    const group = env.mount(env.ui.optionList({ label: 'Strategy regime', options: ['Aggressive growth', 'Growth and income', 'Capital preservation', 'Value'], value, onChange: (v) => seen.push(v) }));
    return { ...env, group, radios: [...group.querySelectorAll('[role=radio]')], seen };
  }
  const state = (radios) => radios.map((r) => `${r.getAttribute('aria-checked')}/${r.tabIndex}`);

  test('a named radiogroup; the checked radio is the one tab stop', async () => {
    const { group, radios } = await four('Growth and income');
    assert.strictEqual(group.getAttribute('role'), 'radiogroup');
    assert.strictEqual(group.getAttribute('aria-label'), 'Strategy regime');
    assert.deepStrictEqual(state(radios), ['false/-1', 'true/0', 'false/-1', 'false/-1']);
  });

  test('with nothing checked, the first radio is the tab stop', async () => {
    const { radios } = await four(undefined);
    assert.deepStrictEqual(state(radios), ['false/0', 'false/-1', 'false/-1', 'false/-1']);
  });

  test('all four arrows move focus and selection together, wrapping', async () => {
    const { radios, key, doc, seen } = await four('Growth and income');
    radios[1].focus();
    key(radios[1], 'ArrowDown');
    assert.strictEqual(doc.activeElement, radios[2]);
    key(radios[2], 'ArrowRight');
    assert.strictEqual(doc.activeElement, radios[3]);
    key(radios[3], 'ArrowDown');
    assert.strictEqual(doc.activeElement, radios[0], 'wraps');
    key(radios[0], 'ArrowUp');
    assert.strictEqual(doc.activeElement, radios[3], 'wraps back');
    key(radios[3], 'ArrowLeft');
    assert.strictEqual(doc.activeElement, radios[2]);
    assert.deepStrictEqual(state(radios), ['false/-1', 'false/-1', 'true/0', 'false/-1']);
    assert.deepStrictEqual(seen, ['Capital preservation', 'Value', 'Aggressive growth', 'Value', 'Capital preservation']);
  });

  test('Space checks the focused radio; Home and End jump to the ends', async () => {
    const { radios, key, doc, seen } = await four(undefined);
    radios[0].focus();
    key(radios[0], ' ');
    assert.deepStrictEqual(state(radios), ['true/0', 'false/-1', 'false/-1', 'false/-1']);
    key(radios[0], 'End');
    assert.strictEqual(doc.activeElement, radios[3]);
    key(radios[3], 'Home');
    assert.strictEqual(doc.activeElement, radios[0]);
    assert.deepStrictEqual(seen, ['Aggressive growth', 'Value', 'Aggressive growth']);
  });
});

describe('table', () => {
  test('column headers are scoped, numeric columns align right, and cells are text or rendered nodes', async () => {
    const { ui } = await fresh();
    const wrap = ui.table({
      caption: 'Positions',
      columns: [{ key: 'ticker', label: 'Position' }, { key: 'value', label: 'Value', numeric: true }, { key: 'status', label: 'Status', render: (v) => ui.chip({ tone: v === 'Stale' ? 'attention' : 'success', label: v }) }],
      rows: [{ ticker: '<b>CRWD</b>', value: '120,000.00', status: 'Fresh' }, { ticker: 'BTC', value: '81,290.00', status: 'Stale' }],
    });
    const ths = [...wrap.querySelectorAll('th')];
    assert.deepStrictEqual(ths.map((t) => t.getAttribute('scope')), ['col', 'col', 'col']);
    assert.ok(ths[1].classList.contains('numeric'));
    const cells = [...wrap.querySelectorAll('tbody tr:first-child td')];
    assert.strictEqual(cells[0].textContent, '<b>CRWD</b>', 'cell text is never parsed');
    assert.ok(cells[1].classList.contains('numeric'));
    assert.ok(wrap.querySelector('tbody tr:last-child .rui-chip-attention'));
    assert.strictEqual(wrap.querySelector('caption').textContent, 'Positions');
  });

  test('without the new options, the markup is exactly what 1.0 drew', async () => {
    // Pinned from the 1.0 library: a table that asks for nothing new must
    // not change by a byte, whatever the editing code around it does.
    const { ui } = await fresh();
    const wrap = ui.table({
      caption: 'Positions',
      columns: [{ key: 'ticker', label: 'Position' }, { key: 'value', label: 'Value', numeric: true }, { key: 'note', align: 'right', render: (v, r) => `${v}/${r.ticker}` }],
      rows: [{ ticker: 'CRWD', value: 12, note: 'a' }, { ticker: 'BTC', value: null, note: 'b' }],
      onEdit: () => true,
    });
    assert.strictEqual(wrap.outerHTML, '<div class="rui-table-wrap"><table class="rui-table"><caption class="rui-visually-hidden">Positions</caption><thead><tr><th scope="col">Position</th><th class="numeric" scope="col">Value</th><th class="numeric" scope="col">note</th></tr></thead><tbody><tr><td>CRWD</td><td class="numeric">12</td><td class="numeric">a/CRWD</td></tr><tr><td>BTC</td><td class="numeric"></td><td class="numeric">b/BTC</td></tr></tbody></table></div>');
  });

  test('a width fixes the layout: one col per column, pixels for a number, a CSS length as given', async () => {
    const { ui } = await fresh();
    const wrap = ui.table({ columns: [{ key: 'a', width: 96 }, { key: 'b', width: '20%' }, { key: 'c' }], rows: [{ a: 1, b: 2, c: 3 }] });
    const table = wrap.querySelector('table');
    assert.ok(table.classList.contains('rui-table-fixed'));
    const cols = [...table.querySelectorAll('colgroup > col')];
    assert.deepStrictEqual(cols.map((c) => c.style.width), ['96px', '20%', '']);
    assert.strictEqual(table.firstElementChild.tagName, 'COLGROUP', 'the colgroup comes before the head');
    for (const bad of [0, -4, 'wide', '12', 'calc(1px)', NaN]) {
      assert.throws(() => ui.table({ columns: [{ key: 'a', width: bad }] }), /width must be/, String(bad));
    }
  });

  test('minWidth and widest are described, not guessed; with nothing laid out the table is left as drawn', async () => {
    const { ui } = await fresh();
    for (const bad of ['80px', -1, NaN]) assert.throws(() => ui.table({ columns: [{ key: 'a', minWidth: bad }] }), /minWidth must be a number of pixels/, String(bad));
    for (const bad of [3, [{}], ['ok', 7]]) assert.throws(() => ui.table({ columns: [{ key: 'a', widest: bad }] }), /widest must be text or an element/, JSON.stringify(bad));
    for (const bad of ['yes', 1, 0]) assert.throws(() => ui.table({ columns: [{ key: 'a', grow: bad }] }), /grow must be true or false/, String(bad));
    assert.doesNotThrow(() => ui.table({ columns: [{ key: 'a', grow: true }, { key: 'b', grow: false }] }));
    const t = ui.table({ columns: [{ key: 'a', minWidth: 80, widest: ['Not priced', ui.chip({ label: 'Stale' })] }], rows: [{ a: 1 }] });
    assert.strictEqual(t.querySelector('colgroup'), null, 'no layout here (no ResizeObserver): nothing measured, nothing locked');
    assert.strictEqual(t.querySelector('.rui-table-ghost'), null, 'and no sample left in the table');
  });

  test('a resizable column has a handle on its header: a focusable vertical separator named for its column; the rest have none', async () => {
    const { ui } = await fresh();
    const t = ui.table({
      resizable: true,
      columns: [{ key: 'ticker', label: 'Ticker' }, { key: 'acct', label: 'Account' }, { key: 'menu', label: ui.chip({ label: 'Actions' }), resizable: false }],
      rows: [{ ticker: 'VTI', acct: 'Taxable', menu: '' }],
      onResize: () => {},
    });
    const ths = [...t.querySelectorAll('thead th')];
    const handles = ths.map((th) => th.querySelector('.rui-col-resize'));
    assert.deepStrictEqual(handles.map(Boolean), [true, true, false], 'resizable: false on a column wins over the table');
    const h = handles[0];
    assert.strictEqual(h.getAttribute('role'), 'separator');
    assert.strictEqual(h.getAttribute('aria-orientation'), 'vertical');
    assert.strictEqual(h.getAttribute('aria-label'), 'Resize the Ticker column');
    assert.strictEqual(h.tabIndex, 0);
    assert.strictEqual(ths[0].textContent, 'Ticker', 'the handle adds no text to the header');
    assert.strictEqual(ui.table({ columns: [{ key: 'a', resizable: true }] }).querySelector('.rui-col-resize') !== null, true, 'one column can be resizable on its own');
    assert.strictEqual(ui.table({ columns: [{ key: 'a' }] }).querySelector('.rui-col-resize'), null, 'none unless asked');
    assert.throws(() => ui.table({ resizable: 'yes', columns: [{ key: 'a' }] }), /resizable must be true or false/);
    assert.throws(() => ui.table({ columns: [{ key: 'a', resizable: 1 }] }), /resizable must be true or false/);
    assert.throws(() => ui.table({ columns: [{ key: 'a' }], onResize: 'save' }), /onResize must be a function/);
  });

  test('with nothing laid out, the keys still resize and reset, and onResize hears each', async () => {
    const { ui, mount, key } = await fresh();
    const heard = [];
    const t = mount(ui.table({ resizable: true, columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], rows: [{ a: 1, b: 2 }], onResize: (c) => heard.push(c) }));
    const handle = t.querySelector('.rui-col-resize');
    key(handle, 'ArrowRight');
    key(handle, 'ArrowRight', { shiftKey: true });
    key(handle, 'Enter');
    assert.deepStrictEqual(heard.map((c) => c.key), ['a', 'a', 'a']);
    assert.strictEqual(heard[1].width - heard[0].width, 32, 'Shift steps 32px');
    assert.strictEqual(heard[2].width, null, 'Enter resets, and says so with null');
    assert.strictEqual(handle.getAttribute('aria-valuenow') !== null, true);
  });

  test('resizing writes nothing: the rows and columns handed in are deep-equal after a drag, a key step and a reset', async () => {
    const { ui, mount, key, win } = await fresh();
    const format = (v) => `${v} units`;
    const rows = [{ t: 'VTI', q: 120 }, { t: 'BTC', q: 2 }];
    const columns = [{ key: 't', label: 'Ticker', minWidth: 60, widest: ['Not priced'] }, { key: 'q', label: 'Quantity', numeric: true, width: 140, format }];
    const rowsBefore = rows.map((row) => ({ ...row }));
    const columnsBefore = columns.map((column) => (column.widest ? { ...column, widest: [...column.widest] } : { ...column }));
    const heard = [];
    const t = mount(ui.table({ resizable: true, columns, rows, onResize: (c) => heard.push(c) }));
    const [a, b] = t.querySelectorAll('.rui-col-resize');
    const pointer = (type, x) => a.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, pointerId: 1 }));
    pointer('pointerdown', 100);
    pointer('pointermove', 140);
    pointer('pointerup', 140);
    key(b, 'ArrowLeft');
    key(b, 'Enter');
    assert.deepStrictEqual(heard.map((c) => c.key), ['t', 'q', 'q'], 'onResize heard the drag, the step and the reset');
    assert.strictEqual(heard[0].width, 100, 'the drag: natural 60 plus 40');
    assert.strictEqual(typeof heard[1].width, 'number', 'the step');
    assert.strictEqual(heard[2].width, null, 'the reset');
    assert.deepStrictEqual(rows, rowsBefore, 'the rows handed in are untouched');
    assert.deepStrictEqual(columns, columnsBefore, 'the columns handed in are untouched, a kept width included');
  });

  test('widths are never shared under an open editor, and are shared again for the current size once it closes', async () => {
    const { ui, mount, key, win } = await fresh();
    const observers = [];
    win.ResizeObserver = class { constructor(cb) { observers.push(cb); } observe() {} disconnect() {} };
    win.requestAnimationFrame = (f) => { f(); return 1; };
    const wrap = mount(ui.table({
      columns: [{ key: 't', label: 'Ticker', minWidth: 100 }, { key: 'q', label: 'Quantity', numeric: true, minWidth: 100, edit: { type: 'number' } }],
      rows: [{ t: 'VTI', q: 1 }],
      onEdit: () => true,
    }));
    let width = 600;
    Object.defineProperty(wrap, 'clientWidth', { get: () => width });
    const resized = () => observers.forEach((cb) => cb([]));
    const table = wrap.querySelector('table');
    resized();
    assert.strictEqual(table.style.width, '600px', 'shared for the container');
    wrap.querySelector('.rui-cell').click();
    width = 900;
    resized();
    assert.strictEqual(table.style.width, '600px', 'never while a cell is being edited');
    key(wrap.querySelector('.rui-cell-editor'), 'Escape');
    assert.strictEqual(wrap.querySelector('.rui-cell-editor'), null);
    assert.strictEqual(table.style.width, '900px', 'shared again for the current size once it closes, with no further resize');
  });

  // The main column, in a window that lays nothing out: every natural width
  // is its minWidth, the container's width is stated, and innerText (which
  // this engine lacks, and which tells a text column from a control) reads
  // the cell's text. `kept` stands in for the view's own state.
  async function laidOut(options, width, kept) {
    const { rundockUiScript } = await frameParts();
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    if (kept) Object.defineProperty(win, 'Rundock', { value: { viewState: Object.freeze({ get: (k) => kept[k], set: () => {} }) }, enumerable: true });
    win.eval(rundockUiScript());
    const observers = [];
    win.ResizeObserver = class { constructor(cb) { observers.push(cb); } observe() {} disconnect() {} };
    win.requestAnimationFrame = (f) => { f(); return 1; };
    Object.defineProperty(win.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
    const wrap = win.document.getElementById('root').appendChild(win.Rundock.ui.table(options));
    Object.defineProperty(wrap, 'clientWidth', { get: () => width });
    observers.forEach((cb) => cb([]));
    const table = wrap.querySelector('table');
    const read = () => {
      const filler = table.querySelector('col.rui-table-filler');
      return {
        widths: [...table.querySelectorAll('colgroup > col:not(.rui-table-filler)')].map((col) => parseFloat(col.style.width)),
        filler: filler ? parseFloat(filler.style.width) : 0,
        table: parseFloat(table.style.width),
      };
    };
    const key = (i, k, extra = {}) => table.querySelectorAll('thead th')[i].querySelector('.rui-col-resize')
      .dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
    return { ...read(), read, key };
  }
  // A column none of whose cells shows text, as a row menu is.
  const blank = () => '';

  test('with room to spare and no grow, the widest text column is the main column: it takes all the spare room and every other column keeps its natural width', async () => {
    const menu = { key: 'actions', label: '', minWidth: 40, render: blank };
    const sparse = await laidOut({
      columns: [{ key: 'item', label: 'Item', minWidth: 120 }, { key: 'note', label: 'Note', minWidth: 200 }, { key: 'section', label: 'Section', minWidth: 60 }, menu],
      rows: [{ item: 'Write the launch post', note: 'Draft in review', section: 'Now' }],
    }, 900);
    assert.deepStrictEqual(sparse.widths, [120, 900 - 120 - 60 - 40, 60, 40], 'Note, the widest, takes the room; Item, Section and the menu keep their natural widths');
    assert.strictEqual(sparse.filler, 0, 'no filler while there is a main column');
    assert.strictEqual(sparse.table, 900, 'the table fills its container');
    const tie = await laidOut({
      columns: [{ key: 'a', label: 'A', minWidth: 150 }, { key: 'b', label: 'B', minWidth: 150 }],
      rows: [{ a: 'one', b: 'two' }],
    }, 500);
    assert.deepStrictEqual(tie.widths, [350, 150], 'on a tie, the first');
    // Natural widths before the 280px cap: both columns are capped at 280,
    // and Note, naturally the wider, is the one chosen.
    const capped = await laidOut({
      columns: [{ key: 'item', label: 'Item', minWidth: 300 }, { key: 'note', label: 'Note', minWidth: 400 }],
      rows: [{ item: 'Write the launch post', note: 'Draft in review' }],
    }, 1000);
    assert.deepStrictEqual(capped.widths, [280, 720], 'chosen by its width before the cap');
  });

  test('numeric, control and fixed columns are never the main column, however wide', async () => {
    const { widths, filler, table } = await laidOut({
      columns: [
        { key: 'name', label: 'Name', minWidth: 80 },
        { key: 'units', label: 'Units', numeric: true, minWidth: 300 },
        { key: 'account', label: 'Account', width: 250, minWidth: 400 },
        { key: 'watch', label: 'Watch', minWidth: 200, edit: { type: 'checkbox' } },
        { key: 'actions', label: '', minWidth: 220, render: blank },
      ],
      rows: [{ name: 'VTI', units: '120', account: 'Taxable', watch: false }],
    }, 1400);
    assert.ok(widths[0] > 80, 'Name, the only text column that is not fixed, takes the room');
    assert.deepStrictEqual([widths[1], widths[3], widths[4]], [300, 200, 220], 'the numeric column, the checkbox and the row menu keep their natural widths');
    assert.strictEqual(widths[2], 250, 'the fixed column, naturally the widest text, keeps its width');
    assert.strictEqual(filler, 0, 'no filler while there is a main column');
    assert.strictEqual(table, 1400, 'the table fills its container');
  });

  test('an explicit grow names the main column, even beside a wider text column', async () => {
    const { widths, filler } = await laidOut({
      columns: [{ key: 'item', label: 'Item', minWidth: 120, grow: true }, { key: 'note', label: 'Note', minWidth: 200 }],
      rows: [{ item: 'Write the launch post', note: 'Draft in review' }],
    }, 600);
    assert.deepStrictEqual(widths, [400, 200], 'Item, the grow column, takes the room; Note keeps its natural width');
    assert.strictEqual(filler, 0);
  });

  test('with no column that qualifies, the filler takes the rest and every column keeps its natural width', async () => {
    const { widths, filler, table } = await laidOut({
      columns: [
        { key: 'ticker', label: 'Ticker', width: 90 },
        { key: 'units', label: 'Units', numeric: true, minWidth: 100 },
        { key: 'watch', label: 'Watch', minWidth: 60, edit: { type: 'checkbox' } },
        { key: 'actions', label: '', minWidth: 40, render: blank },
      ],
      rows: [{ ticker: 'VTI', units: '120', watch: true }],
    }, 600);
    assert.deepStrictEqual(widths, [90, 100, 60, 40], 'nothing scales: each column at its own width');
    assert.ok(filler > 0, 'the filler holds the room no column takes');
    assert.strictEqual(table, 600, 'rows still run the full width');
  });

  test('a main column fixed by a resize or a saved width sends the spare to the filler; a resize beside it is taken up by the main column', async () => {
    const columns = [{ key: 'item', label: 'Item', minWidth: 120 }, { key: 'section', label: 'Section', minWidth: 60 }, { key: 'actions', label: '', minWidth: 40, render: blank, resizable: false }];
    const rows = [{ item: 'Write the launch post', section: 'Now' }];
    const t = await laidOut({ resizable: true, stateKey: 'tracker', columns, rows }, 600);
    assert.deepStrictEqual(t.widths, [500, 60, 40], 'Item is the main column');
    t.key(1, 'ArrowRight');
    let now = t.read();
    assert.deepStrictEqual(now.widths, [492, 68, 40], 'Section took the step and Item, the main column, gave up exactly that');
    assert.strictEqual(now.filler, 0);
    t.key(0, 'ArrowLeft', { shiftKey: true });
    now = t.read();
    assert.deepStrictEqual(now.widths, [460, 68, 40], 'Item is fixed at its new width, and nothing else moved');
    assert.strictEqual(now.filler, 32, 'the room it gave up goes to the filler');
    assert.strictEqual(now.table, 600);
    const saved = await laidOut({ resizable: true, stateKey: 'tracker', columns, rows }, 600, { 'rui.table.tracker': { item: 150 } });
    assert.deepStrictEqual(saved.widths, [150, 60, 40], 'a saved width fixes the main column, and the others keep their natural widths');
    assert.strictEqual(saved.filler, 600 - 150 - 60 - 40, 'the spare goes to the filler');
  });

  test('a dense table with no room to spare is unchanged: every column at its natural width, no filler, wider than its container', async () => {
    const { widths, filler, table } = await laidOut({
      columns: [{ key: 'name', label: 'Name', minWidth: 200 }, { key: 'account', label: 'Account', minWidth: 150 }, { key: 'units', label: 'Units', numeric: true, minWidth: 100 }, { key: 'actions', label: '', minWidth: 40, render: blank }],
      rows: [{ name: 'Vanguard Total World', account: 'Taxable', units: '640' }],
    }, 400);
    assert.deepStrictEqual(widths, [200, 150, 100, 40]);
    assert.strictEqual(filler, 0);
    assert.strictEqual(table, 490, 'it keeps its widths, and its wrapper scrolls');
  });

  test('format draws the display from the value and the row, as text or a node', async () => {
    const { ui } = await fresh();
    const wrap = ui.table({
      columns: [{ key: 'q', numeric: true, format: (v, row) => `${v} of ${row.t}` }, { key: 't', format: (v) => ui.chip({ label: v }) }],
      rows: [{ q: 3, t: '<b>X</b>' }],
    });
    const cells = [...wrap.querySelectorAll('td')];
    assert.strictEqual(cells[0].textContent, '3 of <b>X</b>');
    assert.ok(cells[1].querySelector('.rui-chip'));
    assert.strictEqual(cells[1].querySelector('b'), null, 'format text is never parsed');
    assert.throws(() => ui.table({ columns: [{ key: 'a', format: 'x' }] }), /format must be a function/);
    assert.throws(() => ui.table({ columns: [{ key: 'a', format: String, render: String }] }), /render or format, not both/);
  });
});

// A refusal's line: the row directly under the cell's own row.
const lineOf = (td) => {
  const next = td.parentNode.nextElementSibling;
  return next && next.classList.contains('rui-table-message-row') ? next.querySelector('.rui-cell-message') : null;
};

// The positions an editable table is tested on: a ticker, an account, an
// editable quantity with a floor, and a derived value that is never editable.
function positionsTable(ui, extra = {}) {
  const calls = [];
  const rows = [{ t: 'VTI', acct: 'Taxable', q: 120, mv: 'x' }, { t: 'BTC', acct: 'Wallet', q: 2, mv: 'y' }];
  const wrap = ui.table({
    caption: 'Positions',
    columns: [{ key: 't', label: 'Ticker' }, { key: 'acct', label: 'Account' },
      { key: 'q', label: 'Quantity', numeric: true, format: (v) => Number(v).toLocaleString('en-US'), edit: { type: 'number', min: 0, ...(extra.edit || {}) } },
      { key: 'mv', label: 'Market value', numeric: true }],
    rows,
    onEdit: extra.noEdit ? undefined : (change) => { calls.push(change); return extra.result === undefined ? true : (typeof extra.result === 'function' ? extra.result(change) : extra.result); },
  });
  const cellOf = (i) => wrap.querySelectorAll('tbody tr:not(.rui-table-message-row)')[i].children[2];
  return { wrap, rows, calls, cellOf, button: (i) => cellOf(i).querySelector('button.rui-cell'), editor: (i) => cellOf(i).querySelector('input.rui-cell-editor') };
}

describe('table: editable cells', () => {
  test('a value reads as text in a button named by its column and row; click, Enter and F2 open it, Escape returns focus', async () => {
    const { ui, mount, key, doc } = await fresh();
    const t = positionsTable(ui);
    mount(t.wrap);
    assert.strictEqual(t.editor(0), null, 'no input until asked');
    assert.strictEqual(t.button(0).textContent, '120');
    assert.strictEqual(t.button(0).getAttribute('aria-label'), 'Quantity of VTI, 120');
    assert.strictEqual(t.button(0).type, 'button');
    for (const open of [() => t.button(0).click(), () => key(t.button(0), 'Enter'), () => key(t.button(0), 'F2')]) {
      open();
      const input = t.editor(0);
      assert.ok(input, 'the editor opens');
      assert.strictEqual(doc.activeElement, input);
      assert.strictEqual(input.value, '120');
      assert.strictEqual(input.getAttribute('aria-label'), 'Quantity of VTI');
      assert.ok(t.cellOf(0).classList.contains('rui-editing'));
      assert.strictEqual(t.button(0).tabIndex, -1, 'the covered button leaves the tab order');
      assert.strictEqual(t.button(0).getAttribute('aria-hidden'), 'true');
      key(input, 'Escape');
      assert.strictEqual(t.editor(0), null, 'Escape closes it');
      assert.strictEqual(doc.activeElement, t.button(0), 'and returns focus to the cell');
      assert.strictEqual(t.button(0).hasAttribute('tabindex'), false, 'a tab stop again');
      assert.strictEqual(t.button(0).hasAttribute('aria-hidden'), false);
    }
    assert.deepStrictEqual(t.calls, [], 'Escape asks nothing');
    assert.strictEqual(t.wrap.querySelectorAll('tbody tr')[0].children[3].querySelector('button'), null, 'a column without edit is read-only');
  });

  test('Enter commits through onEdit; true shows the new value, and the row is never written', async () => {
    const { ui, mount, key, doc } = await fresh();
    const t = positionsTable(ui);
    mount(t.wrap);
    t.button(0).click();
    t.editor(0).value = ' 1,250.5 ';
    key(t.editor(0), 'Enter');
    assert.strictEqual(t.calls.length, 1);
    assert.strictEqual(t.calls[0].row, t.rows[0], 'the caller\'s own row');
    assert.deepStrictEqual({ ...t.calls[0], row: null }, { row: null, key: 'q', value: 1250.5, previous: 120 });
    assert.strictEqual(t.editor(0), null);
    assert.strictEqual(t.button(0).textContent, '1,250.5');
    assert.strictEqual(t.button(0).getAttribute('aria-label'), 'Quantity of VTI, 1,250.5');
    assert.strictEqual(doc.activeElement, t.button(0));
    assert.strictEqual(t.rows[0].q, 120, 'the table writes nothing, not even the row it was given');
    t.button(0).click();
    assert.strictEqual(t.editor(0).value, '1,250.5', 'the next edit starts from the accepted value, as the cell shows it');
    key(t.editor(0), 'Enter');
    assert.strictEqual(t.calls.length, 1, 'an unchanged value asks nothing');
    assert.strictEqual(t.editor(0), null);
  });

  test('a number opens as the cell shows it when that reads back as the same value, so no character moves; otherwise raw', async () => {
    const { ui, mount, key } = await fresh();
    const calls = [];
    const wrap = mount(ui.table({
      columns: [{ key: 't' },
        { key: 'p', numeric: true, format: (v) => (typeof v === 'number' ? v.toFixed(2) : 'Not set'), edit: { min: 0 } },
        { key: 'c', numeric: true, format: (v) => `$${v}`, edit: {} }],
      rows: [{ t: 'VTI', p: 290, c: 5 }, { t: 'BTC', c: 7 }],
      onEdit: (c) => { calls.push(c); return c.value === 1 ? 'No' : true; },
    }));
    const open = (r, c) => { wrap.querySelectorAll('tbody tr')[r].children[c].querySelector('.rui-cell').click(); return wrap.querySelectorAll('tbody tr')[r].children[c].querySelector('.rui-cell-editor'); };
    let e = open(0, 1);
    assert.strictEqual(e.value, '290.00', 'the shown text, which reads back as 290');
    key(e, 'Enter');
    assert.deepStrictEqual(calls, [], 'opened and closed unchanged: nothing asked');
    e = open(0, 1);
    e.value = '1';
    key(e, 'Enter');
    assert.strictEqual(e.value, '290.00', 'a refusal reverts to the same text');
    key(e, 'Escape');
    assert.strictEqual(open(1, 1).value, '', '"Not set" is not a number: raw, empty');
    key(wrap.querySelectorAll('tbody tr')[1].children[1].querySelector('.rui-cell-editor'), 'Escape');
    assert.strictEqual(open(0, 2).value, '5', '"$5" does not read back: raw');
  });

  test('edit.label names the row, and when(row) leaves a row read-only', async () => {
    const { ui, mount } = await fresh();
    const t = positionsTable(ui, { edit: { label: (r) => `${r.t} in ${r.acct}`, when: (r) => r.t !== 'BTC' } });
    mount(t.wrap);
    assert.strictEqual(t.button(0).getAttribute('aria-label'), 'Quantity of VTI in Taxable, 120');
    assert.strictEqual(t.button(1), null, 'BTC is read-only');
    assert.strictEqual(t.cellOf(1).textContent, '2', 'and still formatted');
    t.button(0).click();
    assert.strictEqual(t.editor(0).getAttribute('aria-label'), 'Quantity of VTI in Taxable');
  });

  test('with no onEdit nothing can enter edit mode', async () => {
    const { ui, mount } = await fresh();
    const t = positionsTable(ui, { noEdit: true });
    mount(t.wrap);
    assert.strictEqual(t.wrap.querySelector('button, input'), null);
    t.cellOf(0).click();
    assert.strictEqual(t.wrap.querySelector('input'), null);
    assert.strictEqual(t.cellOf(0).textContent, '120');
  });

  test('an edit is described, not guessed: an unknown type, a render beside edit, or a bad range is refused', async () => {
    const { ui } = await fresh();
    const make = (column) => () => ui.table({ columns: [{ key: 'a', ...column }], onEdit: () => true });
    assert.throws(make({ edit: { type: 'date' } }), /edit.type must be one of/);
    assert.throws(make({ edit: 'yes' }), /edit must be an object/);
    assert.throws(make({ edit: {}, render: String }), /editable column draws with format/);
    assert.throws(make({ edit: { min: '0' } }), /edit.min must be a number/);
    assert.throws(make({ edit: { when: true } }), /edit.when must be a function/);
    assert.throws(() => ui.table({ columns: [{ key: 'a' }], onEdit: 'save' }), /onEdit must be a function/);
  });
});

describe('table: onEdit decides', () => {
  test('a string rejects: the value reverts, the message shows inline, and focus stays in the editor', async () => {
    const { ui, mount, key, doc } = await fresh();
    const t = positionsTable(ui, { result: 'More than you hold' });
    mount(t.wrap);
    t.button(0).click();
    t.editor(0).value = '500';
    key(t.editor(0), 'Enter');
    assert.strictEqual(t.calls.length, 1);
    const input = t.editor(0);
    assert.ok(input, 'the editor stays open');
    assert.strictEqual(doc.activeElement, input, 'focus stays');
    assert.strictEqual(input.value, '120', 'the value reverts');
    assert.strictEqual(input.getAttribute('aria-invalid'), 'true');
    const message = lineOf(t.cellOf(0));
    assert.strictEqual(message.textContent, 'Quantity: More than you hold');
    assert.strictEqual(message.getAttribute('role'), 'alert');
    assert.strictEqual(input.getAttribute('aria-describedby'), message.id);
    key(input, 'Escape');
    assert.strictEqual(message.isConnected, false, 'Escape clears it');
    assert.strictEqual(t.button(0).textContent, '120');
    assert.strictEqual(t.button(0).hasAttribute('aria-describedby'), false);
  });

  test('anything but true or a message is a rejection, including a throw: the table shows nothing unconfirmed', async () => {
    for (const result of [undefined, false, '', 1, () => { throw new Error('disk'); }]) {
      const { ui, mount, key } = await fresh();
      const t = positionsTable(ui, { result: typeof result === 'function' ? result : () => result });
      mount(t.wrap);
      t.button(0).click();
      t.editor(0).value = '7';
      key(t.editor(0), 'Enter');
      assert.strictEqual(t.editor(0).value, '120', String(result));
      assert.strictEqual(lineOf(t.cellOf(0)).textContent, 'Quantity: This change was not saved.');
    }
  });

  test('the table refuses a number it cannot read, or one out of range, without asking onEdit', async () => {
    const cases = [
      [{}, 'abc', 'Enter a number of 0 or more.'], [{}, '', 'Enter a number of 0 or more.'], [{}, '-1', 'Enter a number of 0 or more.'],
      [{ min: null, max: 10 }, '11', 'Enter a number of 10 or less.'], [{ max: 10 }, '1.2.3', 'Enter a number from 0 to 10.'],
      [{ min: null }, '12abc', 'Enter a number.'],
    ];
    for (const [edit, typed, said] of cases) {
      const { ui, mount, key, doc } = await fresh();
      const t = positionsTable(ui, { edit });
      mount(t.wrap);
      t.button(0).click();
      t.editor(0).value = typed;
      key(t.editor(0), 'Enter');
      assert.deepStrictEqual(t.calls, [], typed);
      assert.strictEqual(lineOf(t.cellOf(0)).textContent, `Quantity: ${said}`, typed);
      assert.strictEqual(t.editor(0).value, typed, 'what was typed stays, to be corrected');
      assert.strictEqual(doc.activeElement, t.editor(0));
    }
  });

  test('leaving the editor commits; a rejection then closes it on the old value and leaves the message on the cell', async () => {
    const { ui, mount, doc, win } = await fresh();
    const t = positionsTable(ui, { result: (c) => (c.value === 9 ? true : 'No') });
    mount(t.wrap);
    t.button(0).click();
    t.editor(0).value = '9';
    t.editor(0).blur();
    assert.strictEqual(t.editor(0), null);
    assert.strictEqual(t.button(0).textContent, '9', 'accepted on blur');
    t.button(1).click();
    t.editor(1).value = '3';
    const away = doc.body.appendChild(doc.createElement('button'));
    away.focus();
    assert.strictEqual(t.editor(1), null, 'closed, since focus has gone');
    assert.strictEqual(t.button(1).textContent, '2', 'on the old value');
    assert.strictEqual(doc.activeElement, away, 'focus is not pulled back');
    const message = lineOf(t.cellOf(1));
    assert.strictEqual(message.textContent, 'Quantity: No');
    assert.strictEqual(t.button(1).getAttribute('aria-describedby'), message.id);
    assert.ok(win);
  });

  test('an accepted blur never pulls focus back to the cell', async () => {
    const { ui, mount, doc } = await fresh();
    const t = positionsTable(ui);
    mount(t.wrap);
    t.button(0).click();
    t.editor(0).value = '5';
    const away = doc.body.appendChild(doc.createElement('button'));
    away.focus();
    assert.strictEqual(t.button(0).textContent, '5');
    assert.strictEqual(doc.activeElement, away);
  });

  test('a promise holds the cell while saving, then settles as true or a message would', async () => {
    const { ui, mount, key, doc } = await fresh();
    let answer;
    const t = positionsTable(ui, { result: () => new Promise((resolve) => { answer = resolve; }) });
    mount(t.wrap);
    t.button(0).click();
    t.editor(0).value = '8';
    key(t.editor(0), 'Enter');
    const input = t.editor(0);
    assert.ok(input.readOnly, 'held: the editor cannot change under the save');
    assert.strictEqual(t.cellOf(0).getAttribute('aria-busy'), 'true');
    key(input, 'Enter');
    key(input, 'Escape');
    assert.strictEqual(t.calls.length, 1, 'a held cell asks once');
    assert.strictEqual(t.editor(0), input, 'and Escape cannot walk away from it');
    answer('The note is locked');
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(input.readOnly, false);
    assert.strictEqual(t.cellOf(0).hasAttribute('aria-busy'), false);
    assert.strictEqual(input.value, '120', 'refused: reverted');
    assert.strictEqual(lineOf(t.cellOf(0)).textContent, 'Quantity: The note is locked');
    input.value = '9';
    key(input, 'Enter');
    answer(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(t.editor(0), null);
    assert.strictEqual(t.button(0).textContent, '9');
    assert.strictEqual(doc.activeElement, t.button(0));
  });

  test('a held cell never traps Tab: the key is left to the browser, nothing is asked again, and the save settles without pulling focus back', async () => {
    const { ui, mount, key, doc } = await fresh();
    let answer;
    const t = positionsTable(ui, { result: () => new Promise((resolve) => { answer = resolve; }) });
    mount(t.wrap);
    t.button(0).click();
    t.editor(0).value = '8';
    key(t.editor(0), 'Enter');
    const input = t.editor(0);
    assert.strictEqual(key(input, 'Tab'), true, 'Tab is not prevented while held, so focus can leave');
    assert.strictEqual(key(input, 'Tab', { shiftKey: true }), true, 'nor Shift+Tab');
    assert.strictEqual(key(input, 'Enter'), false, 'Enter is still held');
    const away = doc.body.appendChild(doc.createElement('button'));
    away.focus();
    assert.strictEqual(t.editor(0), input, 'leaving does not commit a held cell again');
    assert.strictEqual(t.calls.length, 1);
    answer(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(t.editor(0), null, 'settled: closed on the new value');
    assert.strictEqual(t.button(0).textContent, '8');
    assert.strictEqual(doc.activeElement, away, 'focus is not pulled back');
  });

  test('a promise that fails is a refusal', async () => {
    const { ui, mount, key } = await fresh();
    const t = positionsTable(ui, { result: () => Promise.reject(new Error('offline')) });
    mount(t.wrap);
    t.button(0).click();
    t.editor(0).value = '8';
    key(t.editor(0), 'Enter');
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(lineOf(t.cellOf(0)).textContent, 'Quantity: This change was not saved.');
    assert.strictEqual(t.editor(0).value, '120');
  });
});

describe('table: where a refusal and a save are shown', () => {
  const messageRow = (t, i) => {
    const next = t.wrap.querySelectorAll('tbody > tr:not(.rui-table-message-row)')[i].nextElementSibling;
    return next && next.classList.contains('rui-table-message-row') ? next : null;
  };
  test('a refusal gets a line of its own directly under its row, spanning the table and naming the column; it goes when cleared', async () => {
    const { ui, mount, key } = await fresh();
    const t = positionsTable(ui, { result: 'More than you hold' });
    mount(t.wrap);
    assert.strictEqual(t.wrap.querySelector('.rui-table-message-row'), null, 'no line is reserved while nothing is refused');
    t.button(0).click();
    t.editor(0).value = '500';
    key(t.editor(0), 'Enter');
    const line = messageRow(t, 0);
    assert.ok(line, 'the line sits directly under the refused row');
    const td = line.querySelector('td');
    assert.strictEqual(td.getAttribute('colspan'), '4', 'spanning the table');
    const message = td.querySelector('.rui-cell-message');
    assert.strictEqual(message.textContent, 'Quantity: More than you hold');
    assert.strictEqual(message.getAttribute('role'), 'alert');
    assert.strictEqual(t.editor(0).getAttribute('aria-describedby'), message.id);
    assert.strictEqual(messageRow(t, 1), null, 'the row below keeps no line of its own');
    key(t.editor(0), 'Escape');
    assert.strictEqual(t.wrap.querySelector('.rui-table-message-row'), null, 'cleared: the line goes, and the rows close up');
    assert.strictEqual(t.button(0).hasAttribute('aria-describedby'), false);
  });

  test('a held save says "Saving…" in the cell, politely and at full strength, and moves no row', async () => {
    const { ui, mount, key } = await fresh();
    let answer;
    const t = positionsTable(ui, { result: () => new Promise((r) => { answer = r; }) });
    mount(t.wrap);
    const saving = t.cellOf(0).querySelector('.rui-cell-saving');
    assert.ok(saving, 'the live region is there before it is needed, so what it says is announced');
    assert.strictEqual(saving.getAttribute('role'), 'status');
    assert.strictEqual(saving.textContent, '');
    t.button(0).click();
    t.editor(0).value = '8';
    key(t.editor(0), 'Enter');
    assert.strictEqual(saving.textContent, 'Saving…');
    assert.strictEqual(t.wrap.querySelector('.rui-table-message-row'), null, 'a save is not an interruption: no line');
    assert.strictEqual(t.editor(0).hasAttribute('aria-invalid'), false);
    answer(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(saving.textContent, '');
  });

  test('a refusal after focus has gone keeps its line under the row, described by the cell', async () => {
    const { ui, mount, doc } = await fresh();
    const t = positionsTable(ui, { result: 'No' });
    mount(t.wrap);
    t.button(1).click();
    t.editor(1).value = '3';
    doc.body.appendChild(doc.createElement('button')).focus();
    const message = messageRow(t, 1).querySelector('.rui-cell-message');
    assert.strictEqual(message.textContent, 'Quantity: No');
    assert.strictEqual(t.button(1).getAttribute('aria-describedby'), message.id);
  });
});

describe('table: Tab moves between editable cells', () => {
  test('Tab commits and opens the next editable cell, Shift+Tab the one before; at the end focus rests on the cell', async () => {
    const { ui, mount, key, doc } = await fresh();
    const t = positionsTable(ui);
    mount(t.wrap);
    t.button(0).click();
    t.editor(0).value = '130';
    key(t.editor(0), 'Tab');
    assert.strictEqual(t.calls.at(-1).value, 130);
    assert.strictEqual(t.editor(0), null);
    assert.strictEqual(doc.activeElement, t.editor(1), 'the next row\'s editor is open and focused');
    key(t.editor(1), 'Tab', { shiftKey: true });
    assert.strictEqual(doc.activeElement, t.editor(0), 'Shift+Tab goes back');
    key(t.editor(0), 'Escape');
    t.button(1).click();
    key(t.editor(1), 'Tab');
    assert.strictEqual(t.editor(1), null, 'the last cell closes');
    assert.strictEqual(doc.activeElement, t.button(1), 'and focus rests on it, so the next Tab leaves the table');
  });

  test('a refused Tab stays put', async () => {
    const { ui, mount, key, doc } = await fresh();
    const t = positionsTable(ui, { result: 'No' });
    mount(t.wrap);
    t.button(0).click();
    t.editor(0).value = '1';
    key(t.editor(0), 'Tab');
    assert.strictEqual(doc.activeElement, t.editor(0));
    assert.strictEqual(t.editor(1), null);
  });
});

describe('table: select and checkbox columns', () => {
  const build = (ui, onEdit, when) => ui.table({
    columns: [{ key: 't', label: 'Ticker' },
      { key: 'kind', label: 'Kind', edit: { type: 'select', options: [{ value: 'eq', label: 'Equity' }, 'Bond'] } },
      { key: 'held', label: 'Held', edit: { type: 'checkbox', when } }],
    rows: [{ t: 'VTI', kind: 'eq', held: false }],
    onEdit,
  });

  test('a select column shows the option label and commits on change', async () => {
    const { ui, mount, win, doc } = await fresh();
    const calls = [];
    const wrap = mount(build(ui, (c) => { calls.push(c); return true; }));
    const cell = wrap.querySelectorAll('td')[1];
    assert.strictEqual(cell.querySelector('.rui-cell').textContent, 'Equity');
    cell.querySelector('.rui-cell').click();
    const sel = cell.querySelector('select');
    assert.strictEqual(doc.activeElement, sel);
    assert.strictEqual(sel.value, 'eq');
    assert.strictEqual(sel.getAttribute('aria-label'), 'Kind of VTI');
    assert.ok(sel.closest('.rui-select-wrap').classList.contains('rui-cell-editor'), 'the whole select, arrow and all, is laid over the cell');
    sel.value = 'Bond';
    sel.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.deepStrictEqual({ ...calls[0], row: null }, { row: null, key: 'kind', value: 'Bond', previous: 'eq' });
    assert.strictEqual(cell.querySelector('select'), null);
    assert.strictEqual(cell.querySelector('.rui-cell').textContent, 'Bond');
  });

  test('a select held by a promise cannot be changed until it settles, and is free again after', async () => {
    const { ui, mount, win, doc, key } = await fresh();
    const calls = [];
    let answer;
    const wrap = mount(build(ui, (c) => { calls.push(c); return new Promise((r) => { answer = r; }); }));
    const cell = wrap.querySelectorAll('td')[1];
    cell.querySelector('.rui-cell').click();
    const sel = cell.querySelector('select');
    const mousedown = () => sel.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    sel.value = 'Bond';
    sel.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(sel.getAttribute('aria-disabled'), 'true', 'held, and says so');
    assert.strictEqual(sel.disabled, false, 'aria-disabled, not disabled, so it keeps focus');
    assert.strictEqual(doc.activeElement, sel);
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End', ' ', 'e']) assert.strictEqual(key(sel, k), false, `${JSON.stringify(k)} changes nothing while held`);
    assert.strictEqual(mousedown(), false, 'the list cannot open while held');
    sel.value = 'eq';
    sel.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.strictEqual(sel.value, 'Bond', 'a change that gets through anyway is put back to the value being saved');
    assert.strictEqual(calls.length, 1, 'and asks nothing');
    answer('Locked');
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(sel.hasAttribute('aria-disabled'), false, 'settled: free again');
    assert.strictEqual(sel.value, 'eq', 'refused: reverted');
    assert.strictEqual(key(sel, 'ArrowDown'), true, 'the keys work again');
    assert.strictEqual(mousedown(), true, 'and the list opens again');
  });

  test('a checkbox toggles in one activation, reverts on refusal, and is disabled while held or read-only', async () => {
    const { ui, mount } = await fresh();
    const answers = ['Not now', true];
    const calls = [];
    const wrap = mount(build(ui, (c) => { calls.push(c); return answers.shift(); }));
    const cell = wrap.querySelectorAll('td')[2];
    const box = cell.querySelector('input[type=checkbox]');
    assert.strictEqual(box.getAttribute('aria-label'), 'Held of VTI');
    assert.strictEqual(cell.querySelector('button'), null, 'no editor to open: the box is the control');
    box.click();
    assert.deepStrictEqual({ ...calls[0], row: null }, { row: null, key: 'held', value: true, previous: false });
    assert.strictEqual(box.checked, false, 'refused: unticked again');
    assert.strictEqual(lineOf(cell).textContent, 'Held: Not now');
    box.click();
    assert.strictEqual(box.checked, true);
    assert.strictEqual(lineOf(cell), null);

    let answer;
    const held = mount(build(ui, () => new Promise((r) => { answer = r; })));
    const hbox = held.querySelectorAll('td')[2].querySelector('input');
    hbox.click();
    assert.strictEqual(hbox.getAttribute('aria-disabled'), 'true', 'held while saving, and still focusable');
    hbox.click();
    assert.strictEqual(hbox.checked, true, 'a second click while held changes nothing');
    answer(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(hbox.hasAttribute('aria-disabled'), false);
    assert.strictEqual(hbox.checked, true);

    for (const readOnly of [build(ui, undefined), build(ui, () => true, () => false)]) {
      const rbox = readOnly.querySelectorAll('td')[2].querySelector('input[type=checkbox]');
      assert.strictEqual(rbox.disabled, true, 'no onEdit, or when(row) false: shown, not changeable');
    }
  });
});

describe('chip, empty state, loading, live chip', () => {
  test('a chip per tone, neutral by default, and an unknown tone refused', async () => {
    const { ui } = await fresh();
    for (const tone of ['neutral', 'accent', 'attention', 'success', 'danger']) {
      assert.ok(ui.chip({ tone, label: tone }).classList.contains(`rui-chip-${tone}`));
    }
    assert.ok(ui.chip({ label: 'x' }).classList.contains('rui-chip-neutral'));
    assert.throws(() => ui.chip({ tone: 'purple' }), /tone must be one of/);
  });

  test('an empty state carries its title and subtitle, and a decorative icon', async () => {
    const { ui } = await fresh();
    const e = ui.emptyState({ icon: 'inbox', title: 'No positions yet', subtitle: 'Connect an account.' });
    assert.strictEqual(e.querySelector('.rui-empty-title').textContent, 'No positions yet');
    assert.strictEqual(e.querySelector('.rui-empty-subtitle').textContent, 'Connect an account.');
    assert.strictEqual(e.querySelector('svg').getAttribute('aria-hidden'), 'true');
  });

  test('loading is a polite status with words for a screen reader', async () => {
    const { ui } = await fresh();
    const l = ui.loading({ label: 'Loading positions' });
    assert.strictEqual(l.getAttribute('role'), 'status');
    assert.strictEqual(l.getAttribute('aria-live'), 'polite');
    assert.strictEqual(l.textContent, 'Loading positions');
  });

  test('a live chip says its label and hides its dot', async () => {
    const { ui } = await fresh();
    const c = ui.liveChip({});
    assert.strictEqual(c.textContent, 'Live');
    assert.strictEqual(c.querySelector('.rui-live-dot').getAttribute('aria-hidden'), 'true');
  });
});

describe('menu, the WAI-ARIA menu button pattern', () => {
  test('a separator is a full-width rule the keys pass over and nobody can choose', async () => {
    const { ui, mount, key, doc } = await fresh();
    const chosen = [];
    const m = mount(ui.menu({ label: 'Actions for VTI', items: ['Move to Roth IRA', 'Move to Cash', { separator: true }, 'Remove VTI'], onSelect: (v) => chosen.push(v) }));
    const list = m.querySelector('[role=menu]');
    assert.deepStrictEqual([...list.children].map((c) => c.getAttribute('role')), ['menuitem', 'menuitem', 'separator', 'menuitem'], 'in place, between the moves and Remove');
    const rule = list.querySelector('[role=separator]');
    assert.ok(rule.classList.contains('rui-menu-separator'));
    assert.strictEqual(rule.hasAttribute('tabindex'), false, 'never a tab stop');
    const items = [...list.querySelectorAll('[role=menuitem]')];
    m.querySelector('.rui-menu-btn').click();
    key(items[0], 'ArrowDown');
    key(items[1], 'ArrowDown');
    assert.strictEqual(doc.activeElement, items[2], 'ArrowDown passes over the rule to Remove');
    key(items[2], 'ArrowUp');
    assert.strictEqual(doc.activeElement, items[1], 'and ArrowUp back over it');
    key(items[1], 'End');
    assert.strictEqual(doc.activeElement, items[2]);
    rule.click();
    assert.deepStrictEqual(chosen, [], 'the rule chooses nothing');
    assert.ok(list.classList.contains('rui-open'), 'and does not close the menu');
    items[2].click();
    assert.deepStrictEqual(chosen, ['Remove VTI'], 'the item after it is still the right one');
  });

  test('a menu needs a real item besides its separators, and only separator: true is one', async () => {
    const { ui } = await fresh();
    assert.throws(() => ui.menu({ label: 'x', items: [{ separator: true }] }), /at least one item besides separators/);
    assert.throws(() => ui.menu({ label: 'x', items: ['a', { separator: 'yes' }] }), /every item must be a string or \{ value, label \}/);
  });

  async function made(items = ['Researching', 'Thesis built', 'Position open']) {
    const env = await fresh();
    const seen = [];
    const m = env.mount(env.ui.menu({ label: 'Change status', items, onSelect: (v) => seen.push(v) }));
    return { ...env, m, trigger: m.querySelector('.rui-menu-btn'), list: m.querySelector('[role=menu]'), items: [...m.querySelectorAll('[role^=menuitem]')], seen };
  }

  test('the trigger announces a closed popup it controls', async () => {
    const { trigger, list } = await made();
    assert.strictEqual(trigger.getAttribute('aria-haspopup'), 'true');
    assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(trigger.getAttribute('aria-controls'), list.id);
    assert.strictEqual(trigger.getAttribute('aria-label'), 'Change status');
    assert.strictEqual(list.getAttribute('aria-labelledby'), trigger.id);
    assert.ok(!list.classList.contains('rui-open'));
  });

  test('opens on the trigger, arrows move through the items, Escape closes and returns focus', async () => {
    const { trigger, list, items, key, doc } = await made();
    trigger.focus();
    key(trigger, 'ArrowDown');
    assert.strictEqual(trigger.getAttribute('aria-expanded'), 'true');
    assert.ok(list.classList.contains('rui-open'));
    assert.strictEqual(doc.activeElement, items[0]);
    key(items[0], 'ArrowDown');
    assert.strictEqual(doc.activeElement, items[1]);
    key(items[1], 'End');
    assert.strictEqual(doc.activeElement, items[2]);
    key(items[2], 'ArrowDown');
    assert.strictEqual(doc.activeElement, items[0], 'wraps');
    key(items[0], 'ArrowUp');
    assert.strictEqual(doc.activeElement, items[2]);
    key(items[2], 'Home');
    assert.strictEqual(doc.activeElement, items[0]);
    key(items[0], 'Escape');
    assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(doc.activeElement, trigger);
  });

  test('ArrowUp on the trigger opens on the last item', async () => {
    const { trigger, items, key, doc } = await made();
    trigger.focus();
    key(trigger, 'ArrowUp');
    assert.strictEqual(doc.activeElement, items[2]);
  });

  test('choosing an item selects it, closes, and returns focus to the trigger', async () => {
    const { trigger, items, doc, seen } = await made();
    trigger.click();
    items[1].click();
    assert.deepStrictEqual(seen, ['Thesis built']);
    assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(doc.activeElement, trigger);
  });

  test('Tab and a press outside both close it', async () => {
    const { trigger, items, key, doc, win } = await made();
    trigger.click();
    key(items[0], 'Tab');
    assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false');
    trigger.click();
    doc.body.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
    assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false');
  });

  test('checkable items are radio items that say which is current, and open on it', async () => {
    const { trigger, items, doc } = await made([{ value: 'a', label: 'A', checked: false }, { value: 'b', label: 'B', checked: true }]);
    assert.deepStrictEqual(items.map((i) => `${i.getAttribute('role')}/${i.getAttribute('aria-checked')}`), ['menuitemradio/false', 'menuitemradio/true']);
    trigger.click();
    assert.strictEqual(doc.activeElement, items[1], 'focus lands on the current item');
  });

  test('an icon trigger must be named', async () => {
    const { ui } = await fresh();
    assert.throws(() => ui.menu({ items: ['a'] }), /label must name an icon trigger/);
  });
});

describe('board', () => {
  async function made(extra = {}) {
    const env = await fresh();
    const moves = [];
    const b = env.mount(env.ui.board({
      columns: [
        { id: 'research', title: 'Researching', cards: [{ id: 'pltr', title: 'PLTR', meta: 'Govt AI' }, { id: 'snow', title: 'SNOW', statusOptions: ['research', 'open'] }] },
        { id: 'thesis', title: 'Thesis built', cards: [{ id: 'crwd', title: 'CRWD' }] },
        { id: 'open', title: 'Position open', cards: [] },
      ],
      onCardMove: (...args) => moves.push(args),
      ...extra,
    }));
    const card = (id) => b.querySelector(`[data-card="${id}"]`);
    const column = (id) => b.querySelector(`.rui-board-col[data-column="${id}"]`);
    return { ...env, b, card, column, moves };
  }

  test('every card has a named menu listing the columns, its own marked current', async () => {
    const { card } = await made();
    const trigger = card('pltr').querySelector('.rui-menu-btn');
    assert.strictEqual(trigger.getAttribute('aria-label'), 'Move PLTR');
    const items = [...card('pltr').querySelectorAll('[role=menuitemradio]')];
    assert.deepStrictEqual(items.map((i) => `${i.textContent}/${i.getAttribute('aria-checked')}`), ['Researching/true', 'Thesis built/false', 'Position open/false']);
  });

  test('columns are named groups', async () => {
    const { column, doc } = await made();
    const col = column('thesis');
    assert.strictEqual(col.getAttribute('role'), 'group');
    assert.strictEqual(doc.getElementById(col.getAttribute('aria-labelledby')).textContent, 'Thesis built');
  });

  test('a menu choice moves the card, reports the move, says it aloud, and keeps focus on the card', async () => {
    const { card, column, moves, doc, b } = await made();
    card('pltr').querySelector('.rui-menu-btn').click();
    [...card('pltr').querySelectorAll('[role=menuitemradio]')].find((i) => i.textContent === 'Thesis built').click();
    assert.ok(column('thesis').contains(card('pltr')));
    assert.deepStrictEqual(moves, [['pltr', 'thesis', 'research']]);
    assert.strictEqual(doc.activeElement, card('pltr').querySelector('.rui-menu-btn'), 'focus follows the card');
    const current = [...card('pltr').querySelectorAll('[role=menuitemradio]')].find((i) => i.getAttribute('aria-checked') === 'true');
    assert.strictEqual(current.textContent, 'Thesis built', 'the menu now marks the new column');
    assert.strictEqual(b.querySelector('[role=status]').textContent, 'Moved PLTR to Thesis built');
  });

  test('statusOptions narrows where a card may go', async () => {
    const { card } = await made();
    const labels = [...card('snow').querySelectorAll('[role=menuitemradio]')].map((i) => i.textContent);
    assert.deepStrictEqual(labels, ['Researching', 'Position open']);
  });

  test('drag and drop is an enhancement over the same move', async () => {
    const { card, column, moves, win } = await made();
    const drag = (type, target) => target.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }));
    assert.strictEqual(card('crwd').getAttribute('draggable'), 'true');
    drag('dragstart', card('crwd'));
    drag('dragover', column('open'));
    drag('drop', column('open'));
    drag('dragend', card('crwd'));
    assert.ok(column('open').contains(card('crwd')));
    assert.deepStrictEqual(moves, [['crwd', 'open', 'thesis']]);
  });
});

describe('canvas', () => {
  test('draws synchronously into a surface it names', async () => {
    const { ui } = await fresh();
    const c = ui.canvas({ label: 'Allocation by sector', render: (el) => { el.textContent = 'drawn'; } });
    const drawn = c.querySelector('.rui-canvas-drawn');
    assert.strictEqual(drawn.textContent, 'drawn');
    assert.strictEqual(drawn.getAttribute('role'), 'img');
    assert.strictEqual(drawn.getAttribute('aria-label'), 'Allocation by sector');
    assert.strictEqual(c.querySelector('.rui-canvas-skeleton'), null);
  });

  test('shows the skeleton while an asynchronous render is pending', async () => {
    const { ui } = await fresh();
    let resolve;
    const c = ui.canvas({ render: () => new Promise((r) => { resolve = r; }) });
    assert.ok(c.querySelector('.rui-canvas-skeleton[role=status]'));
    resolve();
    await new Promise((r) => setImmediate(r));
    assert.ok(c.querySelector('.rui-canvas-drawn'));
  });

  test('a failed render shows the failure and a Retry that draws again', async () => {
    const { ui } = await fresh();
    let attempts = 0;
    const c = ui.canvas({ render: (el) => { attempts += 1; if (attempts === 1) throw new Error('no data'); el.textContent = 'ok'; } });
    assert.ok(c.querySelector('.rui-canvas-failed[role=status]'));
    assert.strictEqual(c.dataset.error, 'no data');
    c.querySelector('.rui-canvas-failed button').click();
    assert.strictEqual(c.querySelector('.rui-canvas-drawn').textContent, 'ok');
  });
});

describe('meter', () => {
  test('under its limit: one sentence names it, the fill and marker sit at their fractions', async () => {
    const { ui } = await fresh();
    const m = ui.meter({ label: 'Largest sector', value: 0.21, limit: 0.3 });
    assert.strictEqual(m.getAttribute('role'), 'img');
    assert.strictEqual(m.getAttribute('aria-label'), 'Largest sector, 21% of a 30% maximum');
    assert.strictEqual(m.querySelector('.rui-meter-value').textContent, '21% of 30% max');
    assert.strictEqual(m.querySelector('.rui-meter-fill').style.width, '21%');
    assert.strictEqual(m.querySelector('.rui-meter-marker').style.left, '30%');
    assert.ok(!m.classList.contains('rui-over'));
  });

  test('over its limit switches the value and the fill to danger, and says so', async () => {
    const { ui } = await fresh();
    const m = ui.meter({ label: 'Largest position', value: 0.18, limit: 0.15 });
    assert.ok(m.querySelector('.rui-meter-value').classList.contains('rui-over'));
    assert.ok(m.querySelector('.rui-meter-fill').classList.contains('rui-over'));
    assert.match(m.getAttribute('aria-label'), /over the limit$/);
  });

  test('a minimum is under when below it, and no limit is a plain share', async () => {
    const { ui } = await fresh();
    const min = ui.meter({ label: 'Cash', value: 0.03, limit: 0.05, isMinimum: true });
    assert.strictEqual(min.querySelector('.rui-meter-value').textContent, '3% of 5% min');
    assert.match(min.getAttribute('aria-label'), /under the limit$/);
    const plain = ui.meter({ label: 'Technology', value: 0.3 });
    assert.strictEqual(plain.querySelector('.rui-meter-marker'), null);
    assert.strictEqual(plain.querySelector('.rui-meter-value').textContent, '30%');
  });
});

describe('alert and stat', () => {
  test('an alert is a status by default, an alert when urgent, with its tone and an action', async () => {
    const { ui } = await fresh();
    let clicked = 0;
    const a = ui.alert({ tone: 'attention', message: 'One allocation exceeds its limit.', action: { label: 'Review', onClick: () => { clicked += 1; } } });
    assert.strictEqual(a.getAttribute('role'), 'status');
    assert.ok(a.classList.contains('rui-alert-attention'));
    assert.strictEqual(a.querySelector('svg').getAttribute('aria-hidden'), 'true');
    a.querySelector('.rui-alert-action').click();
    assert.strictEqual(clicked, 1);
    assert.strictEqual(ui.alert({ tone: 'danger', message: 'x', urgent: true }).getAttribute('role'), 'alert');
    assert.throws(() => ui.alert({ tone: 'neutral' }), /tone must be one of attention, danger, success/);
  });

  test('a stat marks a negative value and says its direction in words', async () => {
    const { ui } = await fresh();
    const s = ui.stat({ label: 'Day change', value: '−$2,140', negative: true, delta: '0.5% today', trend: 'down' });
    assert.ok(s.querySelector('.rui-stat-value').classList.contains('rui-negative'));
    const delta = s.querySelector('.rui-stat-delta');
    assert.ok(delta.classList.contains('rui-down'));
    assert.strictEqual(delta.querySelector('.rui-visually-hidden').textContent, 'Down ');
    assert.ok(ui.stat({ label: 'x', value: -3 }).querySelector('.rui-negative'), 'a negative number is negative without being told');
  });
});

describe('relative time', () => {
  test('a real <time> with the machine value and the human words', async () => {
    const { ui } = await fresh();
    const t = ui.relativeTime({ iso: '2026-09-23T10:00:00Z', now: '2026-09-23T10:12:00Z', prefix: 'Updated' });
    assert.strictEqual(t.tagName, 'TIME');
    assert.strictEqual(t.getAttribute('datetime'), '2026-09-23T10:00:00.000Z');
    assert.strictEqual(t.textContent, 'Updated 12 minutes ago');
    assert.ok(!t.classList.contains('rui-stale'));
  });

  test('stale past its threshold, said in words as well as colour', async () => {
    const { ui } = await fresh();
    const t = ui.relativeTime({ iso: '2026-09-20T10:00:00Z', now: '2026-09-23T10:00:00Z', staleAfterMs: 86400000, prefix: 'Priced' });
    assert.ok(t.classList.contains('rui-stale'));
    assert.strictEqual(t.textContent, 'Priced 3 days ago, stale');
  });

  test('refuses a timestamp that is not one', async () => {
    const { ui } = await fresh();
    assert.throws(() => ui.relativeTime({ iso: 'yesterday' }), /iso must be an ISO 8601 timestamp/);
  });
});
