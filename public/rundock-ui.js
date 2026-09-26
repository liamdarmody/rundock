// Rundock UI: the component library for Rundock and its extensions.
//
// `Rundock.ui.<component>(options)` returns an element the caller composes.
// Controls and containers are Rundock's; what an extension draws inside a
// `canvas` is its own. docs/RUNDOCK-UI.md is the reference for every factory.
//
// ONE FUNCTION, AND THAT IS HOW IT REACHES A FRAME. An extension frame has an
// opaque origin and `default-src 'none'`: it cannot load a script from
// Rundock. So the host inlines this library into every frame it builds as
// source text, `(installRundockUi)(window)`, read off the function itself
// (see public/rundock-ui-frame.js). That is why everything below lives inside
// installRundockUi and nothing reaches outside it: the function is the whole
// of what travels, and a reference to anything in this module's scope would
// be undefined in the frame. test/unit/rundock-ui.test.js installs it from
// its own source text for exactly that reason.
//
// IT HAS NO HOST PRIVILEGES AND ADDS NO MESSAGE TYPES. It runs inside the
// frame, as the frame, before the extension's entry script: it builds
// elements and listens to them, and nothing else. It never posts a message,
// never reads the parent, never fetches. The closed message table in
// public/extension-host.js is exactly as closed with it as without it, and a
// test holds this source to that.
//
// THE VERSION IS A CONTRACT, THE LOOK IS NOT. `Rundock.ui.version` is
// "MAJOR.MINOR". A new component or a new option is a minor; a change to what
// an existing call does or accepts is a major. A visual change is neither,
// because the host injects the library, so every extension gets it at once
// with nothing to republish. An extension declares the version it was built
// against in `rundock.json` (`extension.rundockUi`), and the install refuses
// one this Rundock cannot honour (lib/packages/rundock-ui-version.js holds
// the same number, and a test holds the two together).

export function installRundockUi(win) {
  'use strict';
  const VERSION = '1.0';
  // Installed once per window: a second call hands back the first.
  if (win.Rundock && win.Rundock.ui && win.Rundock.ui.version) return win.Rundock.ui;
  const doc = win.document;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let counter = 0;
  const nextId = (prefix) => `rui-${prefix}-${++counter}`;

  function fail(component, message) {
    throw new TypeError(`Rundock.ui.${component}: ${message}`);
  }
  function oneOf(component, name, value, allowed, fallback) {
    if (value === undefined || value === null) return fallback;
    if (allowed.indexOf(value) === -1) fail(component, `${name} must be one of ${allowed.join(', ')}`);
    return value;
  }
  function fn(component, name, value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'function') fail(component, `${name} must be a function`);
    return value;
  }

  function el(tag, className, attrs) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        if (attrs[key] !== undefined && attrs[key] !== null && attrs[key] !== false) {
          node.setAttribute(key, attrs[key] === true ? '' : String(attrs[key]));
        }
      }
    }
    return node;
  }

  // Strings become text, never markup: no factory ever parses HTML it was
  // handed, so a label that happens to contain a tag shows the tag.
  function append(target, content) {
    if (content === undefined || content === null || content === false) return target;
    if (Array.isArray(content)) {
      for (const item of content) append(target, item);
      return target;
    }
    if (typeof content === 'object' && typeof content.nodeType === 'number') {
      target.appendChild(content);
      return target;
    }
    target.appendChild(doc.createTextNode(String(content)));
    return target;
  }

  function hiddenText(text) {
    const span = el('span', 'rui-visually-hidden');
    span.textContent = text;
    return span;
  }

  // Icons: Lucide geometry (viewBox 24, round caps, stroke currentColor),
  // written as data so no markup is ever parsed.
  const ICONS = {
    chevron: [['polyline', { points: '6 9 12 15 18 9' }]],
    kebab: [['circle', { cx: 12, cy: 5, r: 1 }], ['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 12, cy: 19, r: 1 }]],
    attention: [['path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z' }], ['line', { x1: 12, y1: 9, x2: 12, y2: 13 }], ['line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }]],
    danger: [['circle', { cx: 12, cy: 12, r: 10 }], ['line', { x1: 12, y1: 8, x2: 12, y2: 12 }], ['line', { x1: 12, y1: 16, x2: 12.01, y2: 16 }]],
    success: [['path', { d: 'M20 6 9 17l-5-5' }]],
    inbox: [['path', { d: 'M22 12h-6l-2 3h-4l-2-3H2' }], ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z' }]],
    // The chat composer's own send arrow and stop square.
    send: [['line', { x1: 12, y1: 19, x2: 12, y2: 5 }], ['polyline', { points: '5 12 12 5 19 12' }]],
    stop: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2, fill: 'currentColor', stroke: 'none' }]],
    close: [['line', { x1: 18, y1: 6, x2: 6, y2: 18 }], ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]],
    plus: [['line', { x1: 12, y1: 5, x2: 12, y2: 19 }], ['line', { x1: 5, y1: 12, x2: 19, y2: 12 }]],
    more: [['circle', { cx: 12, cy: 5, r: 1 }], ['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 12, cy: 19, r: 1 }]],
  };
  function icon(name, className, strokeWidth) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', String(strokeWidth || 1.8));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (className) svg.setAttribute('class', className);
    for (const [tag, attrs] of ICONS[name]) {
      const shape = doc.createElementNS(SVG_NS, tag);
      for (const key of Object.keys(attrs)) shape.setAttribute(key, String(attrs[key]));
      svg.appendChild(shape);
    }
    return svg;
  }

  // Options for select, tabs and the option list: a string is its own value
  // and label, an object names both.
  function normalizeOptions(component, options) {
    if (!Array.isArray(options) || options.length === 0) fail(component, 'options must be a non-empty array');
    return options.map((option) => {
      if (typeof option === 'string') return { value: option, label: option };
      if (!option || typeof option !== 'object' || option.value === undefined) {
        fail(component, 'every option must be a string or { value, label }');
      }
      return Object.assign({}, option, { value: String(option.value), label: option.label === undefined ? String(option.value) : option.label });
    });
  }

  // ---------------------------------------------------------------------
  // button
  // ---------------------------------------------------------------------
  const BUTTON_VARIANTS = ['primary', 'secondary', 'danger', 'danger-confirm'];
  function button(opts) {
    const o = opts || {};
    const variant = oneOf('button', 'variant', o.variant, BUTTON_VARIANTS, 'secondary');
    const onClick = fn('button', 'onClick', o.onClick);
    const node = el('button', `rui-btn rui-btn-${variant}`, { type: o.type === 'submit' ? 'submit' : 'button' });
    append(node, o.label);
    node.disabled = !!o.disabled;
    if (onClick) node.addEventListener('click', (event) => onClick(event));
    return node;
  }

  // ---------------------------------------------------------------------
  // iconButton
  // ---------------------------------------------------------------------
  const ICON_BUTTON_VARIANTS = ['default', 'send'];
  const SEND_STATES = ['empty', 'active', 'cancel'];
  function iconButton(opts) {
    const o = opts || {};
    const variant = oneOf('iconButton', 'variant', o.variant, ICON_BUTTON_VARIANTS, 'default');
    const onClick = fn('iconButton', 'onClick', o.onClick);
    // No visible text, so the name is required: it is all a screen reader has.
    if (!o.label) fail('iconButton', 'label must name the button, which has no visible text');
    const iconOf = (value, fallback) => {
      if (value && typeof value.nodeType === 'number') {
        value.setAttribute('aria-hidden', 'true');
        return value;
      }
      const name = value === undefined || value === null ? fallback : value;
      if (!Object.prototype.hasOwnProperty.call(ICONS, name)) fail('iconButton', `icon must be an element or one of ${Object.keys(ICONS).join(', ')}`);
      return icon(name, null, variant === 'send' ? 2.5 : 1.8);
    };
    const node = el('button', variant === 'send' ? 'rui-icon-btn rui-icon-btn-send' : 'rui-icon-btn', { type: 'button' });
    const labels = { normal: String(o.label), cancel: o.cancelLabel ? String(o.cancelLabel) : 'Stop' };
    const icons = { normal: iconOf(o.icon, variant === 'send' ? 'send' : 'more'), cancel: variant === 'send' ? iconOf(o.cancelIcon, 'stop') : null };
    let state = 'empty';
    function draw() {
      const cancel = state === 'cancel';
      node.classList.toggle('rui-active', state === 'active');
      node.classList.toggle('rui-cancel', cancel);
      node.setAttribute('aria-label', cancel ? labels.cancel : labels.normal);
      node.title = cancel ? labels.cancel : labels.normal;
      node.textContent = '';
      node.appendChild(cancel ? icons.cancel : icons.normal);
    }
    // The send variant has three states, the composer's own: empty (nothing
    // to send), active (something to send), cancel (a stop button while work
    // runs). A composer changes it as the person types, so it is a method.
    node.setState = (next) => {
      if (variant !== 'send') fail('iconButton', 'only the send variant has a state');
      state = oneOf('iconButton', 'state', next, SEND_STATES, 'empty');
      draw();
    };
    if (variant === 'send') state = oneOf('iconButton', 'state', o.state, SEND_STATES, 'empty');
    draw();
    node.disabled = !!o.disabled;
    if (onClick) node.addEventListener('click', (event) => onClick(event, state));
    return node;
  }

  // ---------------------------------------------------------------------
  // card
  // ---------------------------------------------------------------------
  function card(opts) {
    const o = opts || {};
    const onClick = fn('card', 'onClick', o.onClick);
    if (o.interactive && !onClick) fail('card', 'an interactive card needs onClick');
    const node = el('div', o.interactive ? 'rui-card rui-card-interactive' : 'rui-card');
    const title = o.title !== undefined && o.title !== null ? append(el('div', 'rui-card-title'), o.title) : null;
    // Controls on the title line (tabs, a hint, a button) go in `actions`: a
    // header row with the title first and the actions at its end, centred on
    // the title. Without actions the card's markup is exactly as before.
    if (o.actions !== undefined && o.actions !== null) {
      const list = Array.isArray(o.actions) ? o.actions : [o.actions];
      if (!list.length || list.some((a) => !a || typeof a.nodeType !== 'number')) fail('card', 'actions must be an element or an array of elements');
      const head = node.appendChild(el('div', 'rui-card-head'));
      if (title) head.appendChild(title);
      append(head.appendChild(el('div', 'rui-card-actions')), list);
    } else if (title) node.appendChild(title);
    if (o.subtitle !== undefined && o.subtitle !== null) append(node, append(el('div', 'rui-card-sub'), o.subtitle));
    append(node, o.children);
    if (o.interactive) {
      // A styled div that acts: a role, a tab stop, and the two keys a real
      // button answers, so a keyboard reaches everything a pointer does.
      node.setAttribute('role', 'button');
      node.tabIndex = 0;
      node.addEventListener('click', (event) => onClick(event));
      node.addEventListener('keydown', (event) => {
        if (event.target !== node) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick(event);
        }
      });
    }
    return node;
  }

  // ---------------------------------------------------------------------
  // input
  // ---------------------------------------------------------------------
  function input(opts) {
    const o = opts || {};
    const type = oneOf('input', 'type', o.type, ['text', 'number'], 'text');
    const align = oneOf('input', 'align', o.align, ['left', 'right'], type === 'number' ? 'right' : 'left');
    const onChange = fn('input', 'onChange', o.onChange);
    // A number is typed as text with a decimal keyboard: a native number
    // input cannot show "196,500.00", and a formatted figure is what a
    // number in a table of money looks like.
    const node = el('input', 'rui-input', { type: 'text', inputmode: type === 'number' ? 'decimal' : null });
    if (type === 'number') node.classList.add('rui-input-numeric');
    if (align === 'right') node.classList.add('rui-input-right');
    if (o.value !== undefined && o.value !== null) node.value = String(o.value);
    if (o.placeholder) node.placeholder = String(o.placeholder);
    if (o.label) node.setAttribute('aria-label', String(o.label));
    node.readOnly = !!o.readOnly;
    node.disabled = !!o.disabled;
    if (o.invalid) node.setAttribute('aria-invalid', 'true');
    if (onChange) node.addEventListener('input', (event) => onChange(node.value, event));
    return node;
  }

  // ---------------------------------------------------------------------
  // select
  // ---------------------------------------------------------------------
  function select(opts) {
    const o = opts || {};
    const options = normalizeOptions('select', o.options);
    const onChange = fn('select', 'onChange', o.onChange);
    const wrap = el('div', 'rui-select-wrap');
    const node = el('select', 'rui-select');
    for (const option of options) {
      const item = el('option', null, { value: option.value });
      item.textContent = String(option.label);
      if (option.disabled) item.disabled = true;
      node.appendChild(item);
    }
    if (o.value !== undefined && o.value !== null) node.value = String(o.value);
    if (o.label) node.setAttribute('aria-label', String(o.label));
    node.disabled = !!o.disabled;
    if (o.disabled) wrap.classList.add('rui-disabled');
    if (onChange) node.addEventListener('change', (event) => onChange(node.value, event));
    wrap.appendChild(node);
    // The arrow is drawn by the wrapper and never takes a click.
    wrap.appendChild(icon('chevron'));
    return wrap;
  }

  // ---------------------------------------------------------------------
  // field
  // ---------------------------------------------------------------------
  // The control a field labels: the element itself when it is one, or the
  // one inside a wrapper (select draws its arrow around its <select>).
  function controlOf(node) {
    if (!node || typeof node.nodeType !== 'number') return null;
    if (node.matches('input, select, textarea')) return node;
    return node.querySelector('input, select, textarea');
  }
  function field(opts) {
    const o = opts || {};
    const control = controlOf(o.control);
    if (!control) fail('field', 'control must be an input, a select or a textarea, or an element holding one');
    if (!control.id) control.id = nextId('control');
    const node = el('div', 'rui-field');
    const label = el('label', 'rui-field-label', { for: control.id });
    append(label, o.label);
    node.appendChild(label);
    node.appendChild(o.control);
    let help = null;
    if (o.help !== undefined && o.help !== null) {
      help = append(el('span', 'rui-field-help', { id: nextId('help') }), o.help);
      node.appendChild(help);
    }
    const error = el('span', 'rui-field-error-text', { id: nextId('error') });
    node.appendChild(error);
    // The wiring is the field's job, not the stylesheet's: a red border
    // tells a sighted person, and only aria-invalid and aria-describedby tell
    // anyone else.
    node.setError = (message) => {
      const has = message !== undefined && message !== null && message !== '';
      error.textContent = has ? String(message) : '';
      error.hidden = !has;
      node.classList.toggle('rui-field-error', has);
      if (help) help.hidden = has;
      if (has) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
      const described = [];
      if (help && !has) described.push(help.id);
      if (has) described.push(error.id);
      if (described.length) control.setAttribute('aria-describedby', described.join(' '));
      else control.removeAttribute('aria-describedby');
    };
    node.setError(o.error);
    return node;
  }

  // ---------------------------------------------------------------------
  // checkbox and toggle
  // ---------------------------------------------------------------------
  function checkbox(opts) {
    const o = opts || {};
    const onChange = fn('checkbox', 'onChange', o.onChange);
    // The label wraps the box and carries 4px of padding, so the native
    // click target is 24 by 24 around a 16 by 16 box with no script.
    const row = el('label', 'rui-check-row');
    const box = el('input', 'rui-checkbox', { type: 'checkbox' });
    box.checked = !!o.checked;
    // A property, never an attribute: there is no indeterminate attribute.
    box.indeterminate = !!o.indeterminate;
    box.disabled = !!o.disabled;
    if (o.disabled) row.classList.add('rui-disabled');
    if (onChange) box.addEventListener('change', (event) => onChange(box.checked, event));
    row.appendChild(box);
    append(row, o.label);
    return row;
  }

  function toggle(opts) {
    const o = opts || {};
    const onChange = fn('toggle', 'onChange', o.onChange);
    const row = el('label', 'rui-toggle-row');
    // A real checkbox with the switch role, the pattern views/routines.js
    // already uses: the checked state is announced as on or off, and it
    // follows the native property with nothing to keep in step.
    const box = el('input', 'rui-toggle', { type: 'checkbox', role: 'switch' });
    box.checked = !!o.checked;
    box.disabled = !!o.disabled;
    if (o.disabled) row.classList.add('rui-disabled');
    if (onChange) box.addEventListener('change', (event) => onChange(box.checked, event));
    row.appendChild(box);
    append(row, o.label);
    return row;
  }

  // ---------------------------------------------------------------------
  // slider
  // ---------------------------------------------------------------------
  function slider(opts) {
    const o = opts || {};
    const min = o.min === undefined ? 0 : Number(o.min);
    const max = o.max === undefined ? 100 : Number(o.max);
    const step = o.step === undefined ? 1 : o.step;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) fail('slider', 'max must be a number greater than min');
    const format = fn('slider', 'format', o.format) || ((v) => String(v));
    const onChange = fn('slider', 'onChange', o.onChange);
    const wrap = el('div', 'rui-slider-wrap');
    const head = el('div', 'rui-slider-value');
    const name = el('span', null, { id: nextId('slider-label') });
    append(name, o.label);
    const shown = el('b', null, { id: nextId('slider-value') });
    head.appendChild(name);
    head.appendChild(shown);
    const range = el('input', 'rui-slider', { type: 'range' });
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(o.value === undefined ? min : o.value);
    range.disabled = !!o.disabled;
    range.setAttribute('aria-labelledby', name.id);
    range.setAttribute('aria-describedby', shown.id);
    // aria-valuetext REPLACES the raw number in what is announced, which is
    // why it is set on every input rather than left to describedby, which
    // only adds a second announcement after "0.35".
    const sync = () => {
      const value = Number(range.value);
      const text = String(format(value));
      shown.textContent = text;
      range.setAttribute('aria-valuetext', text);
      range.style.setProperty('--rui-fill', `${((value - min) / (max - min)) * 100}%`);
      return value;
    };
    sync();
    range.addEventListener('input', (event) => {
      const value = sync();
      if (onChange) onChange(value, event);
    });
    wrap.appendChild(head);
    wrap.appendChild(range);
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Roving tabindex, shared by tabs and the option list: exactly one item in
  // the group is a tab stop at a time, and the keys move focus and selection
  // together (the Tabs pattern's automatic activation, and the Radio Group
  // pattern, both from the WAI-ARIA Authoring Practices).
  // ---------------------------------------------------------------------
  function rove(items, keys, choose) {
    return (event) => {
      const index = items.indexOf(event.target);
      if (index === -1) return;
      let next = -1;
      if (keys.next.indexOf(event.key) !== -1) next = (index + 1) % items.length;
      else if (keys.prev.indexOf(event.key) !== -1) next = (index - 1 + items.length) % items.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      else if (keys.confirm && event.key === keys.confirm) {
        event.preventDefault();
        choose(index, false, event);
        return;
      }
      if (next === -1) return;
      event.preventDefault();
      choose(next, true, event);
    };
  }

  // ---------------------------------------------------------------------
  // tabs
  // ---------------------------------------------------------------------
  function tabs(opts) {
    const o = opts || {};
    const options = normalizeOptions('tabs', o.options);
    const orientation = oneOf('tabs', 'orientation', o.orientation, ['horizontal', 'vertical'], 'horizontal');
    const onChange = fn('tabs', 'onChange', o.onChange);
    if (!o.label) fail('tabs', 'label must name the tab list for assistive technology');
    const list = el('div', `rui-tabs rui-tabs-${orientation}`, { role: 'tablist', 'aria-label': String(o.label), 'aria-orientation': orientation });
    let current = o.value === undefined ? options[0].value : String(o.value);
    if (!options.some((option) => option.value === current)) current = options[0].value;
    const items = options.map((option) => {
      const tab = el('button', 'rui-tab', { type: 'button', role: 'tab', id: nextId('tab') });
      tab.dataset.value = option.value;
      append(tab, option.label);
      // A panel, when given, is wired both ways and shown only while its
      // tab is selected; without one the tabs are the bar and the caller
      // swaps content from onChange.
      if (option.panel && typeof option.panel.nodeType === 'number') {
        const panel = option.panel;
        if (!panel.id) panel.id = nextId('tabpanel');
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
        if (!panel.hasAttribute('tabindex')) panel.tabIndex = 0;
        tab.setAttribute('aria-controls', panel.id);
      }
      list.appendChild(tab);
      return tab;
    });
    function render() {
      items.forEach((tab, i) => {
        const on = options[i].value === current;
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
        tab.classList.toggle('rui-selected', on);
        if (options[i].panel && typeof options[i].panel.nodeType === 'number') options[i].panel.hidden = !on;
      });
    }
    function choose(index, moveFocus, event) {
      const changed = options[index].value !== current;
      current = options[index].value;
      render();
      if (moveFocus) items[index].focus();
      if (changed && onChange) onChange(current, event);
    }
    const keys = orientation === 'vertical'
      ? { next: ['ArrowDown'], prev: ['ArrowUp'] }
      : { next: ['ArrowRight'], prev: ['ArrowLeft'] };
    list.addEventListener('keydown', rove(items, keys, choose));
    items.forEach((tab, i) => tab.addEventListener('click', (event) => choose(i, false, event)));
    render();
    return list;
  }

  // ---------------------------------------------------------------------
  // option list (a single-select radio group)
  // ---------------------------------------------------------------------
  function optionList(opts) {
    const o = opts || {};
    const options = normalizeOptions('optionList', o.options);
    const onChange = fn('optionList', 'onChange', o.onChange);
    if (!o.label) fail('optionList', 'label must name the group for assistive technology');
    const group = el('div', 'rui-option-list', { role: 'radiogroup', 'aria-label': String(o.label) });
    let current = o.value === undefined || o.value === null ? null : String(o.value);
    if (current !== null && !options.some((option) => option.value === current)) current = null;
    const items = options.map((option) => {
      const radio = el('button', 'rui-option', { type: 'button', role: 'radio' });
      radio.dataset.value = option.value;
      radio.appendChild(el('span', 'rui-option-dot', { 'aria-hidden': 'true' }));
      append(radio, option.label);
      group.appendChild(radio);
      return radio;
    });
    function render() {
      // With nothing chosen the first option is the tab stop, per the
      // pattern; with a choice, the chosen one is.
      const stop = current === null ? 0 : options.findIndex((option) => option.value === current);
      items.forEach((radio, i) => {
        const on = options[i].value === current;
        radio.setAttribute('aria-checked', on ? 'true' : 'false');
        radio.tabIndex = i === stop ? 0 : -1;
        radio.classList.toggle('rui-selected', on);
      });
    }
    function choose(index, moveFocus, event) {
      const changed = options[index].value !== current;
      current = options[index].value;
      render();
      if (moveFocus) items[index].focus();
      if (changed && onChange) onChange(current, event);
    }
    group.addEventListener('keydown', rove(items, { next: ['ArrowDown', 'ArrowRight'], prev: ['ArrowUp', 'ArrowLeft'], confirm: ' ' }, choose));
    items.forEach((radio, i) => radio.addEventListener('click', (event) => choose(i, false, event)));
    render();
    return group;
  }

  // ---------------------------------------------------------------------
  // table
  // ---------------------------------------------------------------------
  // A column width: a positive number of pixels, or a plain CSS length.
  const WIDTH = /^\d+(\.\d+)?(px|%|rem|em|ch)$/;
  function widthOf(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return `${value}px`;
    if (typeof value === 'string' && WIDTH.test(value) && parseFloat(value) > 0) return value;
    return fail('table', 'width must be a positive number of pixels or a CSS length such as "96px" or "20%"');
  }

  const EDIT_TYPES = ['number', 'text', 'select', 'checkbox'];
  function editOf(column, render) {
    const e = column.edit;
    if (e === undefined || e === null) return null;
    if (typeof e !== 'object') fail('table', 'edit must be an object');
    // The table redraws an edited cell from its value, which a render that
    // builds its own element cannot promise.
    if (render) fail('table', 'an editable column draws with format, not render');
    const bound = (name) => {
      if (e[name] === undefined || e[name] === null) return null;
      if (typeof e[name] !== 'number' || !Number.isFinite(e[name])) fail('table', `edit.${name} must be a number`);
      return e[name];
    };
    const type = oneOf('table', 'edit.type', e.type, EDIT_TYPES, 'number');
    return {
      type, min: bound('min'), max: bound('max'),
      options: type === 'select' ? normalizeOptions('table', e.options) : null,
      label: fn('table', 'edit.label', e.label), when: fn('table', 'edit.when', e.when),
    };
  }
  const textOf = (content) => (content && typeof content.nodeType === 'number' ? content.textContent : (content === undefined || content === null ? '' : String(content)));

  function minWidthOf(value) {
    if (value === undefined || value === null) return 0;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('table', 'minWidth must be a number of pixels');
    return value;
  }
  // What a column may show that its first rows do not ("Not priced", a stale
  // date): measured with the cells, so the column is wide enough for it.
  function widestOf(value) {
    if (value === undefined || value === null) return [];
    const list = Array.isArray(value) ? value : [value];
    for (const item of list) if (typeof item !== 'string' && !(item && typeof item.nodeType === 'number')) fail('table', 'widest must be text or an element, or an array of them');
    return list;
  }

  function table(opts) {
    const o = opts || {};
    if (!Array.isArray(o.columns) || o.columns.length === 0) fail('table', 'columns must be a non-empty array');
    const rows = Array.isArray(o.rows) ? o.rows : [];
    const onEdit = fn('table', 'onEdit', o.onEdit);
    const onResize = fn('table', 'onResize', o.onResize);
    const resizableOf = (value) => (value === undefined ? undefined : (typeof value === 'boolean' ? value : fail('table', 'resizable must be true or false')));
    const resizable = !!resizableOf(o.resizable);
    // KEPT WIDTHS. With `stateKey`, the widths the person set are kept in the
    // view's own state (Rundock.viewState, which the host installs in a
    // mounted view) under `rui.table.<stateKey>`, as `{ <column key>: px }`:
    // read once here, written on each resize and reset. The table posts
    // nothing itself. With no stateKey, or no Rundock.viewState (the
    // gallery, a test page), the table never looks.
    const stateKey = o.stateKey === undefined ? null
      : (typeof o.stateKey === 'string' && /^[A-Za-z0-9._:-]{1,54}$/.test(o.stateKey) ? `rui.table.${o.stateKey}`
        : fail('table', 'stateKey must be 1 to 54 letters, digits, ".", "_", ":" or "-"'));
    const store = stateKey && win.Rundock && win.Rundock.viewState && typeof win.Rundock.viewState.get === 'function' ? win.Rundock.viewState : null;
    const stored = store ? store.get(stateKey) : null;
    const keptWidths = {};
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) for (const name of Object.keys(stored)) keptWidths[name] = stored[name];
    const columns = o.columns.map((column) => {
      if (!column || typeof column !== 'object' || typeof column.key !== 'string') fail('table', 'every column needs a string key');
      const render = fn('table', 'render', column.render);
      const format = fn('table', 'format', column.format);
      if (render && format) fail('table', 'a column takes render or format, not both');
      return {
        key: column.key,
        label: column.label === undefined ? column.key : column.label,
        align: oneOf('table', 'align', column.align, ['left', 'right'], column.numeric ? 'right' : 'left'),
        numeric: !!column.numeric,
        render: render || format,
        width: widthOf(column.width),
        minWidth: minWidthOf(column.minWidth),
        grow: column.grow === undefined ? false : (typeof column.grow === 'boolean' ? column.grow : fail('table', 'grow must be true or false')),
        resizable: resizableOf(column.resizable),
        widest: widestOf(column.widest),
        edit: editOf(column, render),
      };
    });
    // What a cell shows: its format, a select's option label, or the value.
    const show = (column, value, row) => {
      if (column.render) return column.render(value, row);
      const option = column.edit && column.edit.options && column.edit.options.find((choice) => choice.value === String(value));
      return option ? option.label : value;
    };
    const cells = [];
    const wrap = el('div', 'rui-table-wrap');
    const node = el('table', 'rui-table');
    if (o.caption) append(node.appendChild(el('caption', 'rui-visually-hidden')), o.caption);
    // Fixed widths are all or nothing for the layout: a colgroup names each
    // column's width, and a fixed layout holds them whatever a cell holds.
    if (columns.some((column) => column.width)) {
      node.classList.add('rui-table-fixed');
      const group = el('colgroup');
      for (const column of columns) {
        const col = group.appendChild(el('col'));
        if (column.width) col.style.width = column.width;
      }
      node.insertBefore(group, node.firstChild);
    }
    const head = node.appendChild(el('thead')).appendChild(el('tr'));
    const handles = [];
    columns.forEach((column, i) => {
      const th = el('th', column.align === 'right' ? 'numeric' : null, { scope: 'col' });
      append(th, column.label);
      head.appendChild(th);
      // A resize handle on the header's right edge: a focusable vertical
      // separator, driven by pointer or keyboard (see resizing, below).
      if (column.resizable === undefined ? resizable : column.resizable) {
        th.classList.add('rui-th-resizable');
        handles[i] = th.appendChild(el('div', 'rui-col-resize', {
          role: 'separator', 'aria-orientation': 'vertical', tabindex: '0',
          'aria-label': `Resize the ${textOf(column.label) || column.key} column`,
        }));
      }
    });
    const body = node.appendChild(el('tbody'));
    for (const row of rows) {
      const tr = body.appendChild(el('tr'));
      for (const column of columns) {
        const td = el('td', column.align === 'right' ? 'numeric' : null);
        const value = row ? row[column.key] : undefined;
        if (column.edit) {
          // Editable only with somewhere to send the edit: the table itself
          // never writes, so with no onEdit every cell is read-only.
          const editable = !!onEdit && (!column.edit.when || !!column.edit.when(row));
          const first = columns[0];
          const name = `${textOf(column.label)} of ${column.edit.label ? String(column.edit.label(row)) : textOf(show(first, row ? row[first.key] : undefined, row))}`;
          let cell = null;
          if (column.edit.type === 'checkbox') cell = checkCell(td, column, row, value, name, editable);
          else if (editable) cell = editCell(td, column, row, value, name);
          else append(td, show(column, value, row));
          if (cell) cells.push(cell);
        } else append(td, show(column, value, row));
        tr.appendChild(td);
      }
    }
    wrap.appendChild(node);
    // DEFAULT WIDTHS. Measured once, the first time the table is laid out,
    // and locked in a fixed layout, so editing never shifts a column.
    //  - A column's natural width is its header and its widest cell on one
    //    line (with any `widest` sample), and at least `minWidth`.
    //  - Every column takes exactly its natural width, except text wider than
    //    280px, which is capped there and ends in an ellipsis, with the full
    //    text in the cell's title. A numeric column or one that is not text (a
    //    checkbox, a row menu) is never capped, and no column is narrower
    //    than its header.
    //  - Spare room goes to one main column: the column with `grow: true`,
    //    or, when no column sets grow, the one with the widest natural
    //    width (before the cap; the first on a tie) among those that are
    //    not fixed by an explicit width, not a control (a checkbox, a row
    //    menu) and not numeric. It takes all the room, uncapped, and every
    //    other column keeps its natural width. Only when there is no main
    //    column, or it is fixed by resizing or a saved width, does the room
    //    go to an empty filler column after the last. A table wider than
    //    its container keeps its widths and scrolls inside its wrapper,
    //    never the page.
    //  - An explicit `width` wins. The room is shared again when the
    //    container's width changes, never while a cell is being edited.
    //    Where nothing lays out (no ResizeObserver) the table is left as drawn.
    const CAP = 280;
    let natural = null;
    let base = null;
    let minimum = null;
    let control = null;
    let grow = -1;
    // A width set by resizing: pixels, or 'auto' after a reset to the rule
    // (which also sets aside a width the extension passed in). And each
    // column's width as last laid out.
    const override = [];
    let now = [];
    // What is drawn in a cell, left to right, plus its padding; a visually
    // hidden label (a header named for assistive technology) draws nothing.
    function inkWidth(cell) {
      let left = Infinity;
      let right = -Infinity;
      for (const child of cell.childNodes) {
        if (child.nodeType === 1 && (child.classList.contains('rui-visually-hidden') || child.classList.contains('rui-col-resize'))) continue;
        const range = doc.createRange();
        range.selectNode(child);
        // An engine that lays nothing out has no rectangles: no ink.
        const box = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
        if (!box || !box.width) continue;
        left = Math.min(left, box.left);
        right = Math.max(right, box.right);
      }
      const style = win.getComputedStyle(cell);
      return (right > left ? right - left : 0) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    }
    const rowsOf = () => [...body.querySelectorAll(':scope > tr:not(.rui-table-message-row):not(.rui-table-ghost)')];
    function measure() {
      const ghosts = [];
      const most = Math.max(0, ...columns.map((column) => column.widest.length));
      for (let i = 0; i < most; i += 1) {
        const tr = body.appendChild(el('tr', 'rui-table-ghost', { 'aria-hidden': 'true' }));
        for (const column of columns) {
          const sample = column.widest[i];
          append(tr.appendChild(el('td', column.align === 'right' ? 'numeric' : null)), sample && typeof sample.nodeType === 'number' ? sample.cloneNode(true) : sample);
        }
        ghosts.push(tr);
      }
      // Explicit widths set aside while measuring, so a reset knows the
      // natural width of every column, not only of the ones without one.
      const group = node.querySelector(':scope > colgroup');
      const kept = group ? [...group.children].map((col) => col.style.width) : [];
      if (group) for (const col of group.children) col.style.width = '';
      node.classList.add('rui-table-measuring');
      natural = columns.map((column, i) => Math.max(Math.ceil(head.children[i].getBoundingClientRect().width), column.minWidth));
      const header = columns.map((column, i) => Math.ceil(inkWidth(head.children[i])));
      node.classList.remove('rui-table-measuring');
      if (group) [...group.children].forEach((col, i) => { col.style.width = kept[i]; });
      minimum = header.map((w, i) => Math.max(w, columns[i].minWidth));
      // A kept width is a saved width: it wins over the rule until reset,
      // and never falls below the column's floor, so a width kept when the
      // header was narrower cannot cut it now.
      columns.forEach((column, i) => {
        const px = Object.prototype.hasOwnProperty.call(keptWidths, column.key) ? keptWidths[column.key] : null;
        if (handles[i] && override[i] === undefined && typeof px === 'number' && Number.isFinite(px) && px > 0) override[i] = Math.max(minimum[i], Math.round(px));
      });
      for (const tr of ghosts) tr.remove();
      // Text is what a column shows as text: rendered text, so a row menu's
      // hidden item labels do not make its column one.
      const long = columns.map((column, i) => !column.numeric && column.align === 'left'
        && !(column.edit && column.edit.type === 'checkbox') && natural[i] > CAP
        && rowsOf().some((tr) => tr.children[i] && (tr.children[i].innerText || '').trim() !== ''));
      base = natural.map((w, i) => (long[i] ? Math.max(header[i], Math.min(w, CAP)) : w));
      grow = columns.findIndex((column) => column.grow && !column.width);
      // A control (a checkbox, or a column none of whose cells shows text,
      // such as a row menu) keeps its natural width; with no rows, a column
      // with no visible header text counts as one.
      const rows = rowsOf();
      control = columns.map((column, i) => (column.edit && column.edit.type === 'checkbox')
        || (rows.length ? !rows.some((tr) => tr.children[i] && (tr.children[i].innerText || '').trim() !== '') : header[i] <= 0));
      // With no grow column, the main column is picked once, here: the
      // widest by natural width of the columns that are text (numeric by
      // the same test as the cap), not a control and not given a width.
      // A resize or a kept width later fixes it; it is never picked again.
      if (!columns.some((column) => column.grow)) {
        grow = columns.reduce((best, column, i) => (!column.width && !control[i] && !column.numeric && column.align === 'left'
          && (best === -1 || natural[i] > natural[best]) ? i : best), -1);
      }
    }
    function share(available) {
      let group = node.querySelector(':scope > colgroup');
      if (!group) {
        group = el('colgroup');
        for (let i = 0; i < columns.length; i += 1) group.appendChild(el('col'));
        node.insertBefore(group, node.querySelector(':scope > thead'));
      }
      node.classList.toggle('rui-table-fixed', true);
      const cols = [...group.children];
      // Fixed: a resized width, or an explicit (saved) one not reset. The
      // rest start at the rule's width.
      const resized = columns.map((column, i) => (typeof override[i] === 'number' ? override[i] : null));
      const explicit = columns.map((column, i) => resized[i] === null && !!column.width && override[i] !== 'auto');
      columns.forEach((column, i) => { cols[i].style.width = resized[i] !== null ? `${resized[i]}px` : (explicit[i] ? column.width : `${base[i]}px`); });
      // Explicit widths as laid out: a fixed table narrower than its columns
      // grows to their sum and keeps each one as set, so reading them at 1px
      // reads them unstretched.
      node.style.width = '1px';
      now = columns.map((column, i) => (explicit[i] ? head.children[i].getBoundingClientRect().width : (resized[i] !== null ? resized[i] : base[i])));
      // Only an unfixed column that shows text or numbers can take room; a
      // checkbox or a row menu is a control and keeps its natural width.
      const scalable = columns.map((column, i) => resized[i] === null && !explicit[i] && !control[i]);
      const held = now.reduce((sum, w, i) => sum + (scalable[i] ? 0 : w), 0);
      const flex = now.reduce((sum, w, i) => sum + (scalable[i] ? w : 0), 0);
      const room = available - held - flex;
      let fill = 0;
      if (room > 0) {
        // The main column takes it all while it is not fixed; otherwise the
        // filler does, and no other column moves.
        const growing = grow !== -1 && scalable[grow] ? grow : -1;
        if (growing !== -1) now[growing] += room;
        else fill = room;
      }
      scalable.forEach((on, i) => { if (on) cols[i].style.width = `${now[i]}px`; });
      if (fill > 0.5 || fillerCol) filler(cols, fill > 0.5 ? fill : 0);
      handles.forEach((handle, i) => {
        handle.setAttribute('aria-valuenow', String(Math.round(now[i])));
        handle.setAttribute('aria-valuemin', String(Math.round(minimum[i])));
      });
      // In pixels, not 100%: a container that changes under an open editor
      // then scrolls the table, or leaves room after it, instead of
      // reflowing its columns. Wider than its container, it scrolls.
      node.style.width = `${now.reduce((sum, w) => sum + w, 0) + (fill > 0.5 ? fill : 0)}px`;
      // A cut-off value keeps its whole text in the cell's title.
      for (const tr of rowsOf()) {
        for (const cell of tr.children) {
          const target = cell.querySelector(':scope > .rui-cell') || cell;
          if (target.scrollWidth > target.clientWidth + 1) target.title = (target.innerText || '').trim();
          else target.removeAttribute('title');
        }
      }
    }
    // The filler: an empty column after the last, holding the room no real
    // column should take. No text, never focusable, hidden from assistive
    // technology, and never given a resize handle.
    let fillerCol = null;
    function filler(cols, room) {
      if (!fillerCol) {
        fillerCol = cols[0].parentNode.appendChild(el('col', 'rui-table-filler'));
        head.appendChild(el('th', 'rui-table-filler', { 'aria-hidden': 'true' }));
        for (const tr of rowsOf()) tr.appendChild(el('td', 'rui-table-filler', { 'aria-hidden': 'true' }));
      }
      fillerCol.style.width = `${room}px`;
    }
    // RESIZING. A column is set to a width by dragging its handle or by the
    // arrow keys (8px, 32px with Shift), never below its header or its
    // minWidth, and is fixed there: the main column takes up the difference
    // (the filler does when the main column is the one fixed), and when the
    // fixed columns alone are wider than the container the table scrolls.
    // Enter or a double-click puts the column back to the rule.
    // onResize({ key, width }) says so, with width null after a reset, for
    // the view to keep.
    function ready() {
      if (!natural) measure();
      if (!now.length) share(wrap.clientWidth);
    }
    function resizeTo(i, px) {
      ready();
      override[i] = Math.max(minimum[i], Math.round(px));
      share(wrap.clientWidth);
    }
    const report = (i) => {
      const width = override[i] === 'auto' ? null : override[i];
      if (store) {
        if (width === null) delete keptWidths[columns[i].key];
        else keptWidths[columns[i].key] = width;
        store.set(stateKey, Object.keys(keptWidths).length ? { ...keptWidths } : undefined);
      }
      if (onResize) onResize({ key: columns[i].key, width });
    };
    function reset(i) {
      ready();
      override[i] = 'auto';
      share(wrap.clientWidth);
      report(i);
    }
    handles.forEach((handle, i) => {
      let start = null;
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        ready();
        start = { x: event.clientX, width: now[i] };
        handle.classList.add('rui-dragging');
        if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener('pointermove', (event) => { if (start) resizeTo(i, start.width + event.clientX - start.x); });
      const end = () => {
        if (!start) return;
        start = null;
        handle.classList.remove('rui-dragging');
        if (typeof override[i] === 'number') report(i);
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      handle.addEventListener('dblclick', (event) => { event.preventDefault(); reset(i); });
      handle.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          ready();
          const step = event.shiftKey ? 32 : 8;
          resizeTo(i, now[i] + (event.key === 'ArrowRight' ? step : -step));
          report(i);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          reset(i);
        }
      });
    });
    let queued = false;
    // A resize that arrives under an open editor is remembered, not lost:
    // the room is shared for the container's size then once the editor
    // closes, with no further resize needed.
    let stale = false;
    function fit() {
      queued = false;
      const available = wrap.clientWidth;
      if (!available) return;
      if (node.querySelector('.rui-editing')) {
        stale = true;
        return;
      }
      stale = false;
      if (!natural) measure();
      share(available);
    }
    function refit() {
      if (stale && !node.querySelector('.rui-editing')) fit();
    }
    // Never inside the observer's own callback: resizing the table there
    // (and the scrollbar that can follow) resizes what it observes, which
    // the browser reports as a ResizeObserver loop error, and a frame's
    // error stands the whole view down. So the work waits for the next
    // frame, and many notifications make one fit.
    if ((columns.some((column) => !column.width) || handles.some(Boolean)) && typeof win.ResizeObserver === 'function') {
      new win.ResizeObserver(() => {
        if (queued) return;
        queued = true;
        win.requestAnimationFrame(fit);
      }).observe(wrap);
    }
    return wrap;

    // onEdit's answer, now or once a promise settles: settle(true), or
    // settle(the reason). Anything but true or a message refuses, so the
    // table never shows a value the extension did not confirm.
    function decide(change, hold, settle) {
      const verdict = (answer) => (answer === true || (typeof answer === 'string' && answer) ? answer : 'This change was not saved.');
      let result;
      try { result = onEdit(change); } catch (error) { result = null; }
      if (!result || typeof result.then !== 'function') return settle(verdict(result));
      hold(true);
      return result.then((answer) => { hold(false); settle(verdict(answer)); }, () => { hold(false); settle(verdict(null)); });
    }
    function busy(td, on) {
      if (on) td.setAttribute('aria-busy', 'true');
      else td.removeAttribute('aria-busy');
      td.classList.toggle('rui-saving', on);
    }
    // The one place a refusal is said: a line of its own directly under the
    // refused row, spanning the table and naming the column, announced as an
    // alert and describing whichever control is showing. It pushes the rows
    // below down only while it shows, because a refusal is an interruption;
    // opening and editing move nothing. say(undefined, control) moves the
    // current message onto a control without changing it.
    function noteFor(td, column) {
      const line = el('tr', 'rui-table-message-row');
      // Its one cell spans every column, a filler included, set when shown.
      const message = line.appendChild(el('td'))
        .appendChild(el('div', 'rui-cell-message', { id: nextId('cell-message'), role: 'alert' }));
      return (text, control) => {
        if (text) {
          message.textContent = `${textOf(column.label)}: ${text}`;
          if (!line.parentNode) td.parentNode.parentNode.insertBefore(line, td.parentNode.nextSibling);
          line.firstChild.colSpan = head.children.length;
        } else if (text !== undefined) line.remove();
        const shown = !!line.parentNode;
        if (shown) control.setAttribute('aria-describedby', message.id);
        else control.removeAttribute('aria-describedby');
        if (control.tagName === 'BUTTON') return;
        if (shown) control.setAttribute('aria-invalid', 'true');
        else control.removeAttribute('aria-invalid');
      };
    }
    // "Saving…", said politely while a save is held, inside the cell and out
    // of the flow, so a save moves no row. The region is there from the
    // start, so what it says is announced.
    function savingFor(td) {
      const note = td.appendChild(el('span', 'rui-cell-saving', { role: 'status' }));
      return (on) => { note.textContent = on ? 'Saving…' : ''; };
    }

    // One editable cell: a button showing the value, which opens an editor
    // laid over the cell, so opening it moves nothing (see rundock-ui.css).
    function editCell(td, column, row, initial, name) {
      const type = column.edit.type;
      let value = initial;
      let box = null;
      let editor = null;
      let held = false;
      let heldAt = '';
      td.classList.add('rui-td-edit');
      const display = td.appendChild(el('button', 'rui-cell', { type: 'button' }));
      const say = noteFor(td, column);
      const saving = savingFor(td);
      const cell = { open };
      const current = () => (value === undefined || value === null ? '' : String(value));
      const parse = (typed) => (/^-?(\d+\.?\d*|\.\d+)$/.test(typed.replace(/,/g, '')) ? Number(typed.replace(/,/g, '')) : NaN);
      // What the editor opens on: the text the cell shows, when a number
      // reads back from it as the same value ("1,250.5", "290.00"), so no
      // character moves on open; otherwise the raw value.
      const opening = () => (type === 'number' && parse(display.textContent) === value ? display.textContent : current());
      function draw() {
        display.textContent = '';
        append(display, show(column, value, row));
        display.setAttribute('aria-label', `${name}, ${display.textContent}`);
      }
      function open() {
        if (box) return;
        if (type === 'select') {
          box = select({ options: column.edit.options, value: current(), label: name });
          editor = box.querySelector('select');
          // Held, the select keeps its focus but takes no change: no key and
          // no press opens or moves it, and a change that gets through is
          // put back to the value being saved.
          editor.addEventListener('change', () => {
            if (held) editor.value = heldAt;
            else commit('enter');
          });
          editor.addEventListener('mousedown', (event) => { if (held) event.preventDefault(); });
        } else {
          box = editor = el('input', 'rui-input', { type: 'text', inputmode: type === 'number' ? 'decimal' : null, 'aria-label': name });
          if (type === 'number') editor.classList.add('rui-input-numeric');
          if (column.align === 'right') editor.classList.add('rui-input-right');
          editor.value = opening();
        }
        box.classList.add('rui-cell-editor');
        editor.addEventListener('keydown', onKey);
        editor.addEventListener('blur', () => { if (editor && !held) commit('blur'); });
        td.classList.add('rui-editing');
        display.setAttribute('aria-hidden', 'true');
        display.tabIndex = -1;
        td.insertBefore(box, display.nextSibling);
        say(undefined, editor);
        editor.focus();
        if (type !== 'select') editor.select();
      }
      function close(focus) {
        if (!box) return;
        const gone = box;
        box = editor = null;
        gone.remove();
        td.classList.remove('rui-editing');
        display.removeAttribute('aria-hidden');
        display.removeAttribute('tabindex');
        draw();
        say(undefined, display);
        if (focus) display.focus();
        refit();
      }
      // Where focus goes after a commit: Tab opens the next editable cell
      // (Shift+Tab the one before), or rests on this one at either end.
      // Focus that has already left is never pulled back.
      function done(via) {
        const here = doc.activeElement === editor;
        const next = here && (via === 'next' || via === 'back') ? cells[cells.indexOf(cell) + (via === 'next' ? 1 : -1)] : null;
        close(here && !next);
        if (next) next.open();
      }
      // Refused where it happened: with focus still in the editor it stays
      // open and says why; once focus has gone it closes on the old value
      // and leaves the reason on the cell.
      function refuse(text, revert) {
        if (doc.activeElement !== editor) {
          close(false);
          return say(text, display);
        }
        if (revert) editor.value = opening();
        say(text, editor);
        if (type !== 'select') editor.select();
      }
      function hold(on) {
        held = on;
        busy(td, on);
        saving(on);
        if (editor && type !== 'select') editor.readOnly = on;
        if (editor && type === 'select') {
          heldAt = editor.value;
          if (on) editor.setAttribute('aria-disabled', 'true');
          else editor.removeAttribute('aria-disabled');
        }
      }
      function commit(via) {
        if (held) return;
        const typed = editor.value.trim();
        let next = typed;
        if (type === 'number') {
          next = parse(typed);
          const { min, max } = column.edit;
          if (Number.isNaN(next) || (min !== null && next < min) || (max !== null && next > max)) {
            return refuse(min !== null && max !== null ? `Enter a number from ${min} to ${max}.`
              : min !== null ? `Enter a number of ${min} or more.` : max !== null ? `Enter a number of ${max} or less.` : 'Enter a number.');
          }
        }
        if (String(next) === current()) {
          say('', editor);
          return done(via);
        }
        return decide({ row, key: column.key, value: next, previous: value }, hold, (verdict) => {
          if (verdict !== true) return refuse(verdict, true);
          value = next;
          say('', editor);
          return done(via);
        });
      }
      function onKey(event) {
        const via = { Enter: 'enter', Escape: 'escape', Tab: event.shiftKey ? 'back' : 'next' }[event.key];
        if (!via) {
          if (held && type === 'select') event.preventDefault();
          return;
        }
        // Held, Tab is left to the browser, so focus can always leave: a
        // held cell never commits on blur, and settles where it is.
        if (held && (via === 'next' || via === 'back')) return;
        event.preventDefault();
        event.stopPropagation();
        if (held) return;
        if (via !== 'escape') return commit(via);
        say('', editor);
        return close(true);
      }
      display.addEventListener('click', open);
      display.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== 'F2') return;
        event.preventDefault();
        open();
      });
      draw();
      return cell;
    }

    // A checkbox needs no editor: one activation toggles it and asks. While
    // held it is aria-disabled rather than disabled, so it keeps focus.
    function checkCell(td, column, row, initial, name, editable) {
      let value = !!initial;
      let pending = null;
      const box = td.appendChild(el('input', 'rui-checkbox', { type: 'checkbox', 'aria-label': name }));
      box.checked = value;
      box.disabled = !editable;
      if (!editable) return null;
      const say = noteFor(td, column);
      const saving = savingFor(td);
      box.addEventListener('change', () => {
        if (pending !== null) {
          box.checked = pending;
          return;
        }
        const next = box.checked;
        decide({ row, key: column.key, value: next, previous: value }, (on) => {
          pending = on ? next : null;
          busy(td, on);
          saving(on);
          if (on) box.setAttribute('aria-disabled', 'true');
          else box.removeAttribute('aria-disabled');
        }, (verdict) => {
          if (verdict === true) value = next;
          box.checked = value;
          say(verdict === true ? '' : verdict, box);
        });
      });
      return { open: () => box.focus() };
    }
  }

  // ---------------------------------------------------------------------
  // chip
  // ---------------------------------------------------------------------
  const TONES = ['neutral', 'accent', 'attention', 'success', 'danger'];
  function chip(opts) {
    const o = opts || {};
    const tone = oneOf('chip', 'tone', o.tone, TONES, 'neutral');
    // The label is its own element, the chip's one flex item, so the
    // stylesheet can trim its text box to the ink (rundock-ui.css, chip).
    const node = el('span', `rui-chip rui-chip-${tone}`);
    node.appendChild(append(el('span', 'rui-chip-label'), o.label));
    return node;
  }

  // ---------------------------------------------------------------------
  // empty state and loading
  // ---------------------------------------------------------------------
  function emptyState(opts) {
    const o = opts || {};
    const node = el('div', 'rui-empty');
    if (o.icon === 'inbox' || o.icon === true) node.appendChild(icon('inbox', 'rui-empty-icon'));
    else if (o.icon && typeof o.icon.nodeType === 'number') {
      o.icon.classList.add('rui-empty-icon');
      o.icon.setAttribute('aria-hidden', 'true');
      node.appendChild(o.icon);
    }
    if (o.title !== undefined && o.title !== null) append(node.appendChild(el('div', 'rui-empty-title')), o.title);
    if (o.subtitle !== undefined && o.subtitle !== null) append(node.appendChild(el('div', 'rui-empty-subtitle')), o.subtitle);
    append(node, o.children);
    return node;
  }

  function loading(opts) {
    const o = opts || {};
    // A status, so a screen reader hears that something is coming when this
    // replaces content, and polite, so it never interrupts.
    const node = el('div', 'rui-loading', { role: 'status', 'aria-live': 'polite' });
    node.appendChild(hiddenText(o.label ? String(o.label) : 'Loading'));
    return node;
  }

  // ---------------------------------------------------------------------
  // menu
  // ---------------------------------------------------------------------
  function menu(opts) {
    const o = opts || {};
    const onSelect = fn('menu', 'onSelect', o.onSelect);
    if (!Array.isArray(o.items) || o.items.length === 0) fail('menu', 'items must be a non-empty array');
    // A separator is a rule between groups ({ separator: true }): in the
    // list in its place, and never an item, so the keys pass over it and
    // nothing can choose it.
    const all = o.items.map((item) => {
      if (item && typeof item === 'object' && item.separator === true) return { separator: true };
      if (typeof item === 'string') return { value: item, label: item };
      if (!item || typeof item !== 'object' || item.value === undefined) fail('menu', 'every item must be a string or { value, label }');
      return Object.assign({}, item, { value: String(item.value), label: item.label === undefined ? String(item.value) : item.label });
    });
    if (!all.some((item) => !item.separator)) fail('menu', 'items must hold at least one item besides separators');
    const items = all.filter((item) => !item.separator);
    const root = el('div', 'rui-menu');
    const listId = nextId('menu');
    let trigger;
    if (typeof o.trigger === 'string') {
      trigger = el('button', 'rui-btn rui-btn-secondary', { type: 'button' });
      trigger.textContent = o.trigger;
    } else {
      if (!o.label) fail('menu', 'label must name an icon trigger for assistive technology');
      trigger = el('button', 'rui-menu-btn', { type: 'button', 'aria-label': String(o.label) });
      trigger.appendChild(icon('kebab', null, 2));
    }
    trigger.id = nextId('menu-trigger');
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', listId);
    const list = el('div', 'rui-menu-list', { role: 'menu', id: listId, 'aria-labelledby': trigger.id });
    const buttons = items.map((item) => {
      // An item that carries `checked` is one choice of several (the board's
      // columns), so it is a radio item and says which one is current.
      const checkable = item.checked !== undefined;
      const node = el('button', 'rui-menu-item', { type: 'button', role: checkable ? 'menuitemradio' : 'menuitem', tabindex: '-1' });
      if (checkable) {
        node.setAttribute('aria-checked', item.checked ? 'true' : 'false');
        if (item.checked) node.classList.add('rui-current');
      }
      if (item.disabled) node.setAttribute('aria-disabled', 'true');
      node.dataset.value = item.value;
      append(node, item.label);
      return node;
    });
    let placed = 0;
    for (const item of all) list.appendChild(item.separator ? el('div', 'rui-menu-separator', { role: 'separator' }) : buttons[placed++]);
    let open = false;
    function onOutside(event) {
      if (!root.contains(event.target)) close(false);
    }
    function onScroll() { close(false); }
    // Placed against the viewport, so a menu opened inside a scrolling
    // container (a board column) is never clipped by it; any scroll closes
    // it rather than leaving it floating away from its trigger.
    function place() {
      const rect = trigger.getBoundingClientRect();
      list.style.position = 'fixed';
      list.style.top = `${rect.bottom + 4}px`;
      list.style.right = 'auto';
      list.style.left = `${Math.max(4, rect.right - list.offsetWidth)}px`;
    }
    function openMenu(focusIndex) {
      if (open) return;
      open = true;
      list.classList.add('rui-open');
      place();
      trigger.setAttribute('aria-expanded', 'true');
      doc.addEventListener('pointerdown', onOutside, true);
      win.addEventListener('scroll', onScroll, true);
      win.addEventListener('resize', onScroll);
      const current = items.findIndex((item) => item.checked);
      const index = focusIndex === 'last' ? buttons.length - 1 : (focusIndex === 'current' && current !== -1 ? current : 0);
      buttons[index].focus({ preventScroll: true });
    }
    function close(returnFocus) {
      if (!open) return;
      open = false;
      list.classList.remove('rui-open');
      list.removeAttribute('style');
      trigger.setAttribute('aria-expanded', 'false');
      doc.removeEventListener('pointerdown', onOutside, true);
      win.removeEventListener('scroll', onScroll, true);
      win.removeEventListener('resize', onScroll);
      if (returnFocus) trigger.focus();
    }
    trigger.addEventListener('click', () => (open ? close(true) : openMenu('current')));
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openMenu('current');
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        openMenu('last');
      }
    });
    list.addEventListener('keydown', (event) => {
      const index = buttons.indexOf(event.target);
      if (index === -1) return;
      let next = -1;
      if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
      else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
        return;
      } else if (event.key === 'Tab') {
        close(false);
        return;
      }
      if (next === -1) return;
      event.preventDefault();
      buttons[next].focus({ preventScroll: true });
    });
    buttons.forEach((node, i) => node.addEventListener('click', (event) => {
      if (items[i].disabled) return;
      close(true);
      if (onSelect) onSelect(items[i].value, event);
    }));
    root.appendChild(trigger);
    root.appendChild(list);
    return root;
  }

  // ---------------------------------------------------------------------
  // board
  // ---------------------------------------------------------------------
  function board(opts) {
    const o = opts || {};
    const onCardMove = fn('board', 'onCardMove', o.onCardMove);
    if (!Array.isArray(o.columns) || o.columns.length === 0) fail('board', 'columns must be a non-empty array');
    const columns = o.columns.map((column) => {
      if (!column || typeof column !== 'object' || column.id === undefined) fail('board', 'every column needs an id');
      return { id: String(column.id), title: column.title === undefined ? String(column.id) : column.title, cards: Array.isArray(column.cards) ? column.cards : [] };
    });
    const root = el('div', 'rui-board');
    // Where a move is said out loud: a card that changes column moves in the
    // DOM, and without this a screen reader hears nothing happen.
    const status = el('div', 'rui-visually-hidden', { role: 'status', 'aria-live': 'polite' });
    const columnNodes = new Map();
    for (const column of columns) {
      const col = el('div', 'rui-board-col', { role: 'group' });
      col.dataset.column = column.id;
      const title = el('div', 'rui-board-col-title', { id: nextId('board-col') });
      append(title, column.title);
      col.setAttribute('aria-labelledby', title.id);
      col.appendChild(title);
      const list = el('div', 'rui-board-cards');
      col.appendChild(list);
      root.appendChild(col);
      columnNodes.set(column.id, list);
      // Drag is the enhancement, layered over the menu that already moves
      // every card without it.
      col.addEventListener('dragover', (event) => {
        if (dragging) { event.preventDefault(); col.classList.add('rui-drop'); }
      });
      col.addEventListener('dragleave', () => col.classList.remove('rui-drop'));
      col.addEventListener('drop', (event) => {
        col.classList.remove('rui-drop');
        if (!dragging) return;
        event.preventDefault();
        move(dragging, column.id, null);
      });
    }
    let dragging = null;
    function columnTitle(id) {
      const found = columns.find((column) => column.id === id);
      return found ? String(found.title) : id;
    }
    function buildCard(data, columnId) {
      if (!data || typeof data !== 'object' || data.id === undefined) fail('board', 'every card needs an id');
      const id = String(data.id);
      const node = el('div', 'rui-board-card', { draggable: 'true' });
      node.dataset.card = id;
      node.dataset.column = columnId;
      const titleRow = el('div', 'rui-board-card-title');
      const name = append(el('span'), data.title === undefined ? id : data.title);
      titleRow.appendChild(name);
      node.appendChild(titleRow);
      if (data.meta !== undefined && data.meta !== null) append(node.appendChild(el('div', 'rui-board-card-meta')), data.meta);
      node._rui = { id, data, titleRow, name };
      renderMenu(node);
      node.addEventListener('dragstart', (event) => {
        dragging = node;
        node.classList.add('rui-dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          try { event.dataTransfer.setData('text/plain', id); } catch (e) { /* some engines refuse; the drag still works */ }
        }
      });
      node.addEventListener('dragend', () => {
        node.classList.remove('rui-dragging');
        dragging = null;
      });
      return node;
    }
    // The menu is rebuilt on every move so its current item is always the
    // card's column, and the card's own statusOptions (a list of column ids)
    // narrows where it may go.
    function renderMenu(node) {
      const { data, titleRow, name } = node._rui;
      const old = titleRow.querySelector('.rui-menu');
      const allowed = Array.isArray(data.statusOptions) ? data.statusOptions.map(String) : columns.map((column) => column.id);
      const here = node.dataset.column;
      const items = columns
        .filter((column) => column.id === here || allowed.indexOf(column.id) !== -1)
        .map((column) => ({ value: column.id, label: column.title, checked: column.id === here }));
      const m = menu({
        label: `Move ${name.textContent}`,
        items,
        onSelect: (to) => {
          if (to !== node.dataset.column) move(node, to, m.querySelector('.rui-menu-btn'));
        },
      });
      if (old) titleRow.replaceChild(m, old);
      else titleRow.appendChild(m);
    }
    function move(node, to, focusAfter) {
      const from = node.dataset.column;
      if (from === to || !columnNodes.has(to)) return;
      columnNodes.get(to).appendChild(node);
      node.dataset.column = to;
      renderMenu(node);
      // Focus follows the card to its new column, onto its new menu button,
      // so a keyboard move never drops the person back at the top.
      if (focusAfter) {
        const again = node.querySelector('.rui-menu-btn');
        if (again) again.focus();
      }
      status.textContent = `Moved ${node._rui.name.textContent} to ${columnTitle(to)}`;
      if (onCardMove) onCardMove(node._rui.id, to, from);
    }
    for (const column of columns) {
      for (const data of column.cards) columnNodes.get(column.id).appendChild(buildCard(data, column.id));
    }
    root.appendChild(status);
    return root;
  }

  // ---------------------------------------------------------------------
  // canvas: the one place an extension draws as it likes
  // ---------------------------------------------------------------------
  function canvas(opts) {
    const o = opts || {};
    const render = fn('canvas', 'render', o.render);
    if (!render) fail('canvas', 'render must be a function that draws into the element it is given');
    const root = el('div', 'rui-canvas');
    function draw() {
      root.textContent = '';
      const skeleton = el('div', 'rui-canvas-skeleton', { role: 'status', 'aria-live': 'polite' });
      skeleton.appendChild(hiddenText('Drawing'));
      root.appendChild(skeleton);
      const surface = el('div', 'rui-canvas-drawn');
      // Encouraged rather than enforced: what is drawn is the extension's,
      // so the name for it is too.
      if (o.label) {
        surface.setAttribute('role', 'img');
        surface.setAttribute('aria-label', String(o.label));
      }
      const done = () => {
        if (skeleton.parentNode === root) root.replaceChild(surface, skeleton);
      };
      const failed = (error) => {
        root.textContent = '';
        const box = el('div', 'rui-canvas-failed', { role: 'status' });
        const reason = el('p', 'rui-canvas-failed-reason');
        reason.textContent = o.failedText ? String(o.failedText) : 'This could not be drawn.';
        box.appendChild(reason);
        box.appendChild(button({ label: 'Retry', variant: 'secondary', onClick: () => draw() }));
        root.appendChild(box);
        root.dataset.error = String(error && error.message ? error.message : error);
      };
      let result;
      try {
        result = render(surface);
      } catch (error) {
        failed(error);
        return;
      }
      if (result && typeof result.then === 'function') result.then(done, failed);
      else done();
    }
    draw();
    return root;
  }

  // ---------------------------------------------------------------------
  // meter
  // ---------------------------------------------------------------------
  const percent = (fraction) => `${Number((fraction * 100).toFixed(1))}%`;
  function meter(opts) {
    const o = opts || {};
    const value = Number(o.value);
    if (!Number.isFinite(value)) fail('meter', 'value must be a number between 0 and 1');
    const hasLimit = o.limit !== undefined && o.limit !== null;
    const limit = hasLimit ? Number(o.limit) : null;
    if (hasLimit && !Number.isFinite(limit)) fail('meter', 'limit must be a number between 0 and 1');
    const format = fn('meter', 'format', o.format) || percent;
    const minimum = !!o.isMinimum;
    const over = hasLimit && (minimum ? value < limit : value > limit);
    const markerAt = o.marker === undefined || o.marker === null ? limit : Number(o.marker);
    const clamp = (x) => Math.max(0, Math.min(1, x));
    const valueText = hasLimit ? `${format(value)} of ${format(limit)} ${minimum ? 'min' : 'max'}` : format(value);
    const node = el('div', over ? 'rui-meter rui-over' : 'rui-meter', { role: 'img' });
    // A display, not a control: one sentence names the whole of it.
    node.setAttribute('aria-label', o.ariaLabel ? String(o.ariaLabel)
      : `${o.label ? `${o.label}, ` : ''}${hasLimit ? `${format(value)} of a ${format(limit)} ${minimum ? 'minimum' : 'maximum'}` : format(value)}${over ? `, ${minimum ? 'under' : 'over'} the limit` : ''}`);
    const head = el('div', 'rui-meter-label', { 'aria-hidden': 'true' });
    append(head.appendChild(el('span', 'rui-meter-name')), o.label);
    append(head.appendChild(el('span', over ? 'rui-meter-value rui-over' : 'rui-meter-value')), valueText);
    const track = el('div', 'rui-meter-track', { 'aria-hidden': 'true' });
    const fill = el('div', over ? 'rui-meter-fill rui-over' : 'rui-meter-fill');
    fill.style.width = `${clamp(value) * 100}%`;
    track.appendChild(fill);
    if (markerAt !== null && Number.isFinite(markerAt)) {
      const marker = el('div', 'rui-meter-marker');
      marker.style.left = `${clamp(markerAt) * 100}%`;
      track.appendChild(marker);
    }
    node.appendChild(head);
    node.appendChild(track);
    return node;
  }

  // ---------------------------------------------------------------------
  // alert
  // ---------------------------------------------------------------------
  function alert(opts) {
    const o = opts || {};
    const tone = oneOf('alert', 'tone', o.tone, ['attention', 'danger', 'success'], 'attention');
    // status by default, which waits its turn; alert only when the caller
    // says this cannot wait.
    const node = el('div', `rui-alert rui-alert-${tone}`, { role: o.urgent ? 'alert' : 'status' });
    node.appendChild(icon(tone));
    append(node.appendChild(el('div', 'rui-alert-message')), o.message);
    if (o.action) {
      let action = o.action;
      if (!(typeof action.nodeType === 'number')) {
        action = button({ label: o.action.label, variant: 'secondary', onClick: o.action.onClick });
      }
      action.classList.add('rui-alert-action');
      node.appendChild(action);
    }
    return node;
  }

  // ---------------------------------------------------------------------
  // stat
  // ---------------------------------------------------------------------
  function stat(opts) {
    const o = opts || {};
    const trend = oneOf('stat', 'trend', o.trend, ['up', 'down'], null);
    const negative = o.negative !== undefined ? !!o.negative : (typeof o.value === 'number' && o.value < 0);
    const node = el('div', 'rui-stat');
    append(node.appendChild(el('div', 'rui-stat-label')), o.label);
    append(node.appendChild(el('div', negative ? 'rui-stat-value rui-negative' : 'rui-stat-value')), o.value);
    if (o.delta !== undefined && o.delta !== null) {
      const delta = el('div', trend ? `rui-stat-delta rui-${trend}` : 'rui-stat-delta');
      // The arrow is for the eye; the words are for everyone, so the
      // direction never rests on colour alone.
      if (trend) {
        delta.appendChild(el('span', null, { 'aria-hidden': 'true' })).textContent = trend === 'up' ? '↑ ' : '↓ ';
        delta.appendChild(hiddenText(trend === 'up' ? 'Up ' : 'Down '));
      }
      append(delta, o.delta);
      node.appendChild(delta);
    }
    return node;
  }

  // ---------------------------------------------------------------------
  // relative time
  // ---------------------------------------------------------------------
  const UNITS = [['year', 31536000000], ['month', 2592000000], ['week', 604800000], ['day', 86400000], ['hour', 3600000], ['minute', 60000], ['second', 1000]];
  function relativeTime(opts) {
    const o = opts || {};
    const when = new Date(o.iso);
    if (typeof o.iso !== 'string' || Number.isNaN(when.getTime())) fail('relativeTime', 'iso must be an ISO 8601 timestamp');
    const now = o.now === undefined ? Date.now() : new Date(o.now).getTime();
    const age = now - when.getTime();
    const stale = typeof o.staleAfterMs === 'number' && age > o.staleAfterMs;
    const format = new win.Intl.RelativeTimeFormat(o.locale || 'en', { numeric: 'auto' });
    let text = format.format(0, 'second');
    for (const [unit, ms] of UNITS) {
      if (Math.abs(age) >= ms) {
        text = format.format(-Math.round(age / ms), unit);
        break;
      }
    }
    const node = el('time', stale ? 'rui-time rui-stale' : 'rui-time', { datetime: when.toISOString(), title: when.toLocaleString(o.locale || 'en') });
    append(node, o.prefix ? `${o.prefix} ${text}` : text);
    // Stale is said in words as well as colour.
    if (stale) node.appendChild(hiddenText(', stale'));
    return node;
  }

  // ---------------------------------------------------------------------
  // live chip
  // ---------------------------------------------------------------------
  function liveChip(opts) {
    const o = opts || {};
    const node = el('span', 'rui-live');
    node.appendChild(el('span', 'rui-live-dot', { 'aria-hidden': 'true' }));
    append(node, o.label === undefined ? 'Live' : o.label);
    return node;
  }

  const ui = {
    version: VERSION,
    button, iconButton, card, field, input, select, checkbox, toggle, slider, tabs, table,
    chip, emptyState, loading, board, canvas, meter, alert, stat, optionList,
    relativeTime, liveChip, menu,
  };
  Object.freeze(ui);
  const namespace = win.Rundock && typeof win.Rundock === 'object' ? win.Rundock : {};
  Object.defineProperty(namespace, 'ui', { value: ui, enumerable: true, configurable: false, writable: false });
  if (win.Rundock !== namespace) {
    Object.defineProperty(win, 'Rundock', { value: namespace, enumerable: true, configurable: false, writable: false });
  }
  return ui;
}

export const RUNDOCK_UI_FACTORIES = [
  'button', 'iconButton', 'card', 'field', 'input', 'select', 'checkbox', 'toggle', 'slider', 'tabs', 'table',
  'chip', 'emptyState', 'loading', 'board', 'canvas', 'meter', 'alert', 'stat', 'optionList',
  'relativeTime', 'liveChip', 'menu',
];
