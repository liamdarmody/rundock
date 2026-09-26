// The Rundock UI gallery: every component, every state, both themes, drawn
// by the library itself inside real extension frames.
//
// Served by the app at /rundock-ui/gallery. Each theme is a sandboxed frame
// whose document the extension host builds with its own builder
// (buildRegionSrcdoc), so what this page shows is exactly what an extension
// is given: the token values of that theme, the floor, Rundock UI's
// stylesheet and library, and then this gallery as the "extension". It is
// the reference docs/RUNDOCK-UI.md links to and the page the visual and
// keyboard e2e drive (test/e2e/rundock-ui-gallery.spec.js).

import { buildRegionSrcdoc } from './extension-host.js';

// The gallery's own layout, as an extension's stylesheet would be: only the
// frame around each demo. Every component draws itself.
const GALLERY_CSS = `
  body { padding: 24px 28px 40px; }
  .g-pane-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); margin: 0 0 22px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
  .g-block { margin-bottom: 36px; padding-bottom: 28px; border-bottom: 1px solid var(--border); }
  .g-block:last-child { border-bottom: 0; }
  .g-index { font-family: var(--font-mono); font-size: 10px; color: var(--text-3); }
  .g-name { font-size: var(--title); font-weight: 700; color: var(--text-1); margin: 2px 0 3px; }
  .g-meta { font-size: var(--label); color: var(--text-3); margin: 0 0 16px; line-height: 1.5; max-width: 640px; }
  .g-title { font-size: var(--label); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-3); margin: 18px 0 10px; }
  .g-row { display: flex; flex-wrap: wrap; gap: 22px 24px; align-items: flex-end; }
  .g-col { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
  .g-item { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .g-state { font-size: 10px; font-family: var(--font-mono); color: var(--text-3); }
  .g-w220 { width: 220px; } .g-w280 { width: 280px; } .g-w200 { width: 200px; } .g-w440 { width: 440px; max-width: 100%; }
  .g-w220 > :first-child, .g-w280 > :first-child, .g-w200 > :first-child, .g-w440 > :first-child { align-self: stretch; }
`;

// The gallery as an extension entry: a function whose source is the whole
// script, so it runs in the frame with nothing but Rundock.ui to draw with.
function drawGallery() {
  // Every error the frame raises is kept on the body, so the e2e can hold the
  // library to raising none (the host stands a view down on the first).
  window.addEventListener('error', (event) => { document.body.dataset.errors = `${document.body.dataset.errors || ''}${event.message}|`; });
  const ui = window.Rundock.ui;
  const make = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const force = (node, ...states) => {
    const target = node.matches('input, select, button') ? node : (node.querySelector('input, select, button') || node);
    for (const s of states) target.classList.add(`rui-force-${s}`);
    return node;
  };
  const item = (node, state, cls) => {
    const wrap = make('div', `g-item${cls ? ` ${cls}` : ''}`);
    wrap.appendChild(node);
    if (state) wrap.appendChild(make('span', 'g-state', state));
    return wrap;
  };
  const row = (...items) => { const r = make('div', 'g-row'); items.forEach((i) => r.appendChild(i)); return r; };
  const block = (index, name, meta, ...parts) => {
    const b = make('section', 'g-block');
    b.dataset.component = name;
    b.appendChild(make('div', 'g-index', index));
    b.appendChild(make('div', 'g-name', name));
    b.appendChild(make('div', 'g-meta', meta));
    parts.forEach((p) => b.appendChild(p));
    document.body.appendChild(b);
  };
  const title = (text) => make('div', 'g-title', text);
  const light = document.body.classList.contains('light');
  document.body.appendChild(make('div', 'g-pane-label', light ? 'Light theme' : 'Dark theme'));

  const buttonStates = (variant, label) => row(
    item(ui.button({ label, variant }), 'default'),
    item(force(ui.button({ label, variant }), 'hover'), 'hover'),
    item(force(ui.button({ label, variant }), 'focus'), 'focus-visible'),
    item(force(ui.button({ label, variant }), 'active'), 'active'),
    item(ui.button({ label, variant, disabled: true }), 'disabled'),
  );
  block('01', 'Button', 'Rundock.ui.button({ label, variant, onClick, disabled }): primary, secondary, danger, danger-confirm. A fill carrying text or an icon uses --accent-action with white; a bare control shape uses --accent-control; the brand --accent is never a fill. Danger is an outline by form; only a destructive dialog\'s own confirm is solid.',
    title('Primary'), buttonStates('primary', 'Save'),
    title('Secondary'), buttonStates('secondary', 'Cancel'),
    title('Danger: starts a destructive action from a list or menu'), buttonStates('danger', 'Uninstall'),
    title('Danger confirm: the destructive dialog\'s own confirmation'), buttonStates('danger-confirm', 'Delete permanently'));

  const sendStates = [['empty', 'empty'], ['active', 'active'], ['active', 'active, hover', 'hover'], ['active', 'active, focus-visible', 'focus'], ['cancel', 'cancel'], ['cancel', 'cancel, hover', 'hover']];
  block('22', 'Icon button', 'Rundock.ui.iconButton({ label, icon, variant, state, onClick, disabled }): the app\'s 32px icon button, and the send variant, the chat composer\'s send button property for property. A label is required; the icon is decorative.',
    title('Default'),
    row(
      item(ui.iconButton({ label: 'More actions' }), 'default'),
      item(force(ui.iconButton({ label: 'More actions' }), 'hover'), 'hover'),
      item(force(ui.iconButton({ label: 'Add', icon: 'plus' }), 'focus'), 'focus-visible'),
      item(ui.iconButton({ label: 'Close', icon: 'close', disabled: true }), 'disabled'),
    ),
    title('Send'),
    row(
      ...sendStates.map(([state, label, forced]) => {
        const b = ui.iconButton({ label: 'Send message', variant: 'send', state });
        if (forced) b.classList.add(`rui-force-${forced}`);
        return item(b, label);
      }),
      item(ui.iconButton({ label: 'Send message', variant: 'send', disabled: true }), 'disabled'),
    ));
  document.body.lastChild.id = 'icon-buttons';

  block('02', 'Card', 'Rundock.ui.card({ title, subtitle, children, interactive, onClick })',
    row(
      item(ui.card({ title: 'Max sector concentration', subtitle: 'Limits any one sector to this share of invested value.' }), 'default', 'g-w220'),
      item(force(ui.card({ title: 'Max sector concentration', subtitle: 'Limits any one sector to this share of invested value.', interactive: true, onClick() {} }), 'hover'), 'hover (interactive card)', 'g-w220'),
      item(ui.card({ title: 'Cash', subtitle: 'Held across every account.', children: ui.stat({ label: 'Cash', value: '$43,900' }) }), 'with content: 16px under the header', 'g-w220'),
      item(ui.card({ title: 'Regime', children: ui.stat({ label: 'Strategy', value: 'Growth and income' }) }), 'title and content, no subtitle', 'g-w220'),
    ),
    title('Actions on the title line'),
    row(
      item(ui.card({ title: 'Allocation', subtitle: 'By share of invested value.', actions: ui.tabs({ label: 'Group allocation by', options: ['Asset', 'Sector'] }), children: ui.stat({ label: 'Largest', value: 'Equity, 62%' }) }), 'actions: tabs, centred on the title', 'g-w440'),
      item(ui.card({ title: 'Decision board', actions: make('span', 'g-state', 'Move a card with its menu.'), children: ui.stat({ label: 'Proposed', value: '2' }) }), 'actions: a hint', 'g-w440'),
    ));
  document.body.lastChild.id = 'cards';

  block('03', 'Field', 'Rundock.ui.field({ label, control, help, error }): wires the label, aria-invalid and aria-describedby.',
    row(
      item(ui.field({ label: 'Position size', control: ui.input({ placeholder: '0.00' }), help: 'Percentage of total portfolio value.' }), 'default, with help', 'g-w220'),
      item(ui.field({ label: 'Position size', control: ui.input({ value: '42' }), error: 'Exceeds the 8% single-position limit.' }), 'error', 'g-w220'),
      item(ui.field({ label: 'Position size', control: ui.input({ value: '8', disabled: true }), help: 'Locked while the regime is active.' }), 'disabled', 'g-w220'),
    ));

  block('04', 'Input', 'Rundock.ui.input({ type, value, placeholder, align, readOnly, invalid, onChange }): text, and number (right-aligned, tabular).',
    title('Text'),
    row(
      item(ui.input({ placeholder: 'Search tickers…' }), 'default', 'g-w220'),
      item(force(ui.input({ placeholder: 'Search tickers…' }), 'hover'), 'hover', 'g-w220'),
      item(force(ui.input({ value: 'CRWD' }), 'focus'), 'focus-visible', 'g-w220'),
      item(ui.input({ value: 'CRWD', disabled: true }), 'disabled', 'g-w220'),
      item(ui.input({ value: 'ZZZZ', invalid: true }), 'error', 'g-w220'),
      item(ui.input({ value: 'Roth IRA', readOnly: true }), 'read-only', 'g-w220'),
    ),
    title('Number'),
    row(
      item(ui.input({ type: 'number', value: '196,500.00' }), 'default', 'g-w220'),
      item(force(ui.input({ type: 'number', value: '8.00' }), 'focus'), 'focus-visible', 'g-w220'),
    ));

  const statuses = ['Researching', 'Building thesis', 'Position open'];
  block('05', 'Select', 'Rundock.ui.select({ options, value, onChange }): a native select; the wrapper draws the arrow and never takes a click.',
    row(
      item(ui.select({ options: statuses, label: 'Status' }), 'default', 'g-w220'),
      item(force(ui.select({ options: statuses, label: 'Status' }), 'hover'), 'hover', 'g-w220'),
      item(force(ui.select({ options: statuses, value: 'Position open', label: 'Status' }), 'focus'), 'focus-visible', 'g-w220'),
      item(ui.select({ options: ['Closed'], disabled: true, label: 'Status' }), 'disabled', 'g-w220'),
    ));

  block('06', 'Checkbox', 'Rundock.ui.checkbox({ label, checked, indeterminate, disabled, onChange }): a native checkbox, a 24px target, the tick a centred image.',
    row(
      item(ui.checkbox({ label: 'Unchecked' }), 'unchecked'),
      item(force(ui.checkbox({ label: 'Unchecked' }), 'focus'), 'focus-visible'),
      item(ui.checkbox({ label: 'Checked', checked: true }), 'checked'),
      item(force(ui.checkbox({ label: 'Checked', checked: true }), 'hover'), 'checked, hover'),
      item(ui.checkbox({ label: 'Some', indeterminate: true }), 'indeterminate'),
      item(ui.checkbox({ label: 'Disabled', disabled: true }), 'disabled'),
      item(ui.checkbox({ label: 'Disabled', checked: true, disabled: true }), 'disabled, checked'),
    ));

  block('07', 'Toggle', 'Rundock.ui.toggle({ label, checked, disabled, onChange }): a checkbox with the switch role.',
    row(
      item(ui.toggle({ label: 'Off' }), 'off'),
      item(force(ui.toggle({ label: 'Off' }), 'focus'), 'focus-visible'),
      item(ui.toggle({ label: 'On', checked: true }), 'on'),
      item(force(ui.toggle({ label: 'On', checked: true }), 'hover'), 'on, hover'),
      item(ui.toggle({ label: 'Off', disabled: true }), 'disabled'),
      item(ui.toggle({ label: 'On', checked: true, disabled: true }), 'disabled, on'),
    ));

  const pct = (v) => `${v}%`;
  block('08', 'Slider', 'Rundock.ui.slider({ label, value, min, max, step, format, onChange }): aria-valuetext follows every input.',
    row(
      item(ui.slider({ label: 'Max single position', value: 8, format: pct }), 'default', 'g-w200'),
      item(force(ui.slider({ label: 'Max sector concentration', value: 35, format: pct }), 'hover'), 'hover', 'g-w200'),
      item(force(ui.slider({ label: 'Max account exposure', value: 60, format: pct }), 'focus'), 'focus-visible', 'g-w200'),
      item(force(ui.slider({ label: 'Max illiquid assets', value: 15, format: pct }), 'active'), 'active (dragging)', 'g-w200'),
      item(ui.slider({ label: 'Min cash reserve', value: 5, format: pct, disabled: true }), 'disabled', 'g-w200'),
    ));

  const staticTabs = ui.tabs({ label: 'States', options: ['Asset class', 'Sector', 'Geography', 'Account type'], value: 'Geography' });
  const [, hoverTab, , focusTab] = staticTabs.querySelectorAll('[role=tab]');
  hoverTab.classList.add('rui-force-hover');
  focusTab.classList.add('rui-selected', 'rui-force-focus');
  staticTabs.removeAttribute('role');
  staticTabs.querySelectorAll('[role=tab]').forEach((t) => { t.removeAttribute('role'); t.removeAttribute('aria-selected'); t.tabIndex = -1; });
  const liveTabs = ui.tabs({ label: 'Portfolio views', options: ['Overview', 'Positions', 'Risk profile'] });
  liveTabs.id = 'live-tabs';
  const verticalTabs = ui.tabs({ label: 'Report sections', orientation: 'vertical', options: ['Summary', 'Holdings', 'Activity'] });
  verticalTabs.id = 'live-tabs-vertical';
  block('09', 'Tabs', 'Rundock.ui.tabs({ label, options, value, onChange, orientation }): the WAI-ARIA Tabs pattern, automatic activation, roving tabindex; arrows move and select, Home and End jump.',
    title('States (a static reference, not one tablist)'), row(item(staticTabs, 'inactive · inactive hover · active · active + focus-visible')),
    title('Live (arrow keys, Home, End)'), row(item(liveTabs, 'role=tablist/tab, aria-selected, roving tabindex'), item(verticalTabs, 'vertical: ArrowUp and ArrowDown')));

  const positions = ui.table({
    caption: 'Positions',
    columns: [{ key: 'ticker', label: 'Position' }, { key: 'account', label: 'Account' }, { key: 'value', label: 'Value', numeric: true },
      { key: 'status', label: 'Status', render: (v) => ui.chip({ tone: v === 'Stale' ? 'attention' : 'success', label: v }) }],
    rows: [
      { ticker: 'CRWD', account: 'Taxable brokerage', value: '120,000.00', status: 'Fresh' },
      { ticker: 'NVDA', account: 'Roth IRA', value: '50,350.00', status: 'Fresh' },
      { ticker: 'BTC', account: 'Crypto wallet', value: '81,290.00', status: 'Stale' },
    ],
  });
  positions.querySelectorAll('tbody tr')[1].classList.add('rui-force-hover');
  // Editable: default widths, with two explicit (Ticker at 72px, where an
  // overlong ticker ends in an ellipsis, and the row menu at 36px), text, select, number and checkbox columns, a refusal
  // (more than 10,000), a save that holds (price), and a row menu in a
  // fixed column. The last edit is recorded on the body for the e2e.
  const money = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const editable = ui.table({
    caption: 'Positions, editable',
    resizable: true,
    columns: [
      { key: 'ticker', label: 'Ticker', width: 72 }, { key: 'account', label: 'Account', grow: true, edit: { type: 'text' } },
      { key: 'kind', label: 'Kind', edit: { type: 'select', options: ['Equity', 'Fund', 'Crypto'] } },
      { key: 'quantity', label: 'Quantity', numeric: true, format: (v) => Number(v).toLocaleString('en-US'), edit: { type: 'number', min: 0 } },
      { key: 'price', label: 'Price (USD)', numeric: true, format: money, edit: { type: 'number', min: 0, label: (r) => `${r.ticker} in ${r.account}` } },
      { key: 'value', label: 'Market value', numeric: true, format: money },
      { key: 'watch', label: 'Watch', edit: { type: 'checkbox' } },
      { key: 'actions', label: '', width: 36, render: (v, r) => ui.menu({ label: `Actions for ${r.ticker}`, items: ['Move to Roth IRA', 'Move to Crypto wallet', { separator: true }, `Remove ${r.ticker}`] }) },
    ],
    rows: [
      { ticker: 'CRWD', account: 'Taxable', kind: 'Equity', quantity: 120, price: 412.3, value: 49476, watch: false },
      { ticker: 'NVDA', account: 'Roth IRA', kind: 'Equity', quantity: 640, price: 108.42, value: 69388.8, watch: true },
      { ticker: 'BTC', account: 'Wallet', kind: 'Crypto', quantity: 2, price: 81290, value: 162580, watch: false },
      { ticker: 'BRK.B CLASS B', account: 'Taxable', kind: 'Fund', quantity: 30, price: 452.1, value: 13563, watch: false },
    ],
    onEdit: ({ key, value, previous }) => {
      document.body.dataset.lastEdit = JSON.stringify({ key, value, previous });
      if (key === 'quantity' && value > 10000) return 'More than this account holds.';
      if (key === 'price') return new Promise((resolve) => setTimeout(() => resolve(true), 150));
      return true;
    },
  });
  editable.id = 'live-edit-table';
  block('10', 'Table', 'Rundock.ui.table({ columns, rows, caption, onEdit }): the header is --text-1, quieter through size and case. A column takes a fixed width, a format, and an editor (number, text, select, checkbox); the extension\'s onEdit decides every change.',
    row(item(positions, 'default row · hover row · status via chip', 'g-w280')),
    title('Editable, fixed widths (click, Enter or F2; Enter commits, Escape cancels, Tab moves on)'),
    row(item(editable, 'quantity over 10,000 is refused · price saves after a short hold', 'g-w280')));
  positions.parentNode.style.width = '100%';
  editable.parentNode.style.width = '100%';

  // Default widths: no column sets one. Each is measured at its natural
  // width (Status with "Not priced", which no row shows yet), and the main
  // column, the widest text column that is not fixed, takes all the spare
  // room while every other column keeps its natural width. A sparse table
  // fills its width with its text column, its pill column tight and its row
  // menu at the right edge; a dense one gives its room to its widest text
  // column; a table with no column that qualifies leaves the room to an
  // empty filler. A note longer than 280px is capped with an ellipsis and
  // its title, and the same table in a narrow box scrolls inside its own
  // wrapper.
  const defaults = () => ui.table({
    caption: 'Holdings, default widths',
    columns: [
      { key: 'holding', label: 'Holding' }, { key: 'note', label: 'Note' },
      { key: 'units', label: 'Units', numeric: true }, { key: 'value', label: 'Value', numeric: true },
      { key: 'status', label: 'Status', widest: 'Not priced' },
      { key: 'actions', label: make('span', 'rui-visually-hidden', 'Actions'), render: (v, r) => ui.menu({ label: `Actions for ${r.holding}`, items: ['Move', { separator: true }, 'Remove'] }) },
    ],
    rows: [
      { holding: 'CRWD', note: 'Core position', units: '120', value: '49,476.00', status: 'Fresh' },
      { holding: 'Vanguard Total World', note: 'Index', units: '640', value: '69,388.80', status: 'Stale' },
    ],
  });
  const wide = defaults();
  wide.id = 'default-widths';
  const narrow = defaults();
  narrow.id = 'default-widths-narrow';
  const narrowBox = make('div');
  narrowBox.style.width = '300px';
  // Against the frame's right edge: anything in the table that escaped its
  // wrapper would spill past the frame and scroll the page sideways.
  narrowBox.style.marginLeft = 'auto';
  narrowBox.appendChild(narrow);
  document.body.lastChild.appendChild(title('Default widths: natural, and the main column takes the spare room'));
  document.body.lastChild.appendChild(row(item(wide, 'no column sets a width: Holding, the widest text column, takes the room; the rest keep their natural widths', 'g-w440')));
  const narrowRow = row(item(narrowBox, 'narrower than its columns: it scrolls inside its wrapper'));
  narrowRow.style.justifyContent = 'flex-end';
  document.body.lastChild.appendChild(narrowRow);
  const menuColumn = (name) => ({ key: 'actions', label: make('span', 'rui-visually-hidden', 'Actions'), render: (v, r) => ui.menu({ label: `Actions for ${r[name]}`, items: ['Move', { separator: true }, 'Remove'] }) });
  // Sparse: a text column, a short pill column and a row menu.
  const tones = { Now: 'neutral', Next: 'neutral', Done: 'success' };
  const sparse = ui.table({
    caption: 'Tracker',
    columns: [{ key: 'item', label: 'Item' }, { key: 'section', label: 'Section', render: (v) => ui.chip({ tone: tones[v], label: v }) }, menuColumn('item')],
    rows: [
      { item: 'Write the launch post', section: 'Now' },
      { item: 'Add a changelog page', section: 'Next' },
      { item: 'Audit third-party scripts for privacy', section: 'Done' },
    ],
  });
  sparse.id = 'default-widths-sparse';
  // Dense: text, numeric columns and a row menu; Name is the widest text.
  const dense = ui.table({
    caption: 'Positions, dense',
    columns: [
      { key: 'ticker', label: 'Ticker' }, { key: 'name', label: 'Name' }, { key: 'account', label: 'Account' },
      { key: 'shares', label: 'Shares', numeric: true }, { key: 'price', label: 'Price', numeric: true },
      { key: 'value', label: 'Market value', numeric: true }, { key: 'weight', label: 'Weight %', numeric: true }, menuColumn('ticker'),
    ],
    rows: [
      { ticker: 'VWRL', name: 'Vanguard FTSE All-World', account: 'GIA', shares: '150', price: '108.45', value: '16,267.50', weight: '26.0%' },
      { ticker: 'CRWD', name: 'CrowdStrike', account: 'ISA', shares: '40', price: '412.30', value: '16,492.00', weight: '26.4%' },
    ],
  });
  dense.id = 'default-widths-dense';
  // No column qualifies: Ticker has a width, Units is numeric and the row
  // menu is a control, so the room they leave goes to the filler.
  const held = ui.table({
    caption: 'Fixed columns',
    columns: [{ key: 't', label: 'Ticker', width: 90 }, { key: 'u', label: 'Units', numeric: true }, menuColumn('t')],
    rows: [{ t: 'CRWD', u: '120' }, { t: 'BTC', u: '2' }],
  });
  held.id = 'default-widths-held';
  const capped = ui.table({
    caption: 'A long note',
    columns: [{ key: 't', label: 'Ticker', grow: true }, { key: 'n', label: 'Note' }, { key: 'u', label: 'Units', numeric: true },
      { key: 'r', label: 'Reason recorded at the time of purchase, in full' }],
    rows: [{ t: 'CRWD', n: 'Core position, trimmed after the March review to bring technology back under the sector limit', u: '120', r: 'Endpoint share gains continue as buyers consolidate their security vendors onto fewer platforms' }],
  });
  capped.id = 'default-widths-capped';
  document.body.lastChild.appendChild(row(item(capped, 'Note, longer than 280px, is capped with its title; a header wider than the cap sets the floor; Ticker is the grow column', 'g-w440')));
  capped.parentNode.style.width = '100%';
  document.body.lastChild.appendChild(row(item(sparse, 'sparse: Item takes the room, Section keeps its natural width, the row menu sits at the right edge', 'g-w440')));
  sparse.parentNode.style.width = '100%';
  document.body.lastChild.appendChild(row(item(dense, 'dense: Name, the widest text column, takes what room there is; the numeric columns keep their natural widths', 'g-w440')));
  dense.parentNode.style.width = '100%';
  document.body.lastChild.appendChild(row(item(held, 'no column qualifies (a fixed width, a numeric column, a row menu): an empty filler takes the rest', 'g-w440')));
  held.parentNode.style.width = '100%';
  wide.parentNode.style.width = '100%';

  // Resizable: drag a header's right edge, or focus it and use the arrow
  // keys (Shift for 32px); Enter or a double-click puts the column back to
  // the rule. Account comes in at 150px, as a saved width would; Units has a
  // floor of 90px; the row menu opts out. The last resize is kept on the
  // body for the e2e. It carries a stateKey, and the gallery has no view
  // state (a region frame gets none), so it must behave exactly as without.
  const resizableTable = ui.table({
    caption: 'Holdings, resizable',
    resizable: true,
    stateKey: 'gallery-holdings',
    onResize: ({ key, width }) => { document.body.dataset.lastResize = JSON.stringify({ key, width }); },
    columns: [
      { key: 'holding', label: 'Holding' }, { key: 'account', label: 'Account', width: 150 },
      { key: 'units', label: 'Units', numeric: true, minWidth: 90 }, { key: 'status', label: 'Status' },
      { key: 'actions', label: make('span', 'rui-visually-hidden', 'Actions'), resizable: false, render: (v, r) => ui.menu({ label: `Actions for ${r.holding}`, items: ['Move', { separator: true }, 'Remove'] }) },
    ],
    rows: [
      { holding: 'CRWD', account: 'Taxable', units: '120', status: 'Fresh' },
      { holding: 'Vanguard Total World', account: 'Roth IRA', units: '640', status: 'Stale' },
    ],
  });
  resizableTable.id = 'resizable-table';
  document.body.lastChild.appendChild(title('Resizable columns'));
  document.body.lastChild.appendChild(row(item(resizableTable, 'drag or arrow keys; Enter or double-click resets', 'g-w440')));
  resizableTable.parentNode.style.width = '100%';

  block('11', 'Chip', 'Rundock.ui.chip({ tone, label }): a solid fill, never a tint. The accent chip fills with --accent-action because it carries a label; the label is centred on its ink.',
    row(...['neutral', 'accent', 'attention', 'success', 'danger'].map((tone, i) => item(ui.chip({ tone, label: ['Draft', 'Active regime', 'Stale', 'Fresh', 'Breach'][i] }), tone))));

  block('12', 'Empty state and loading', 'Rundock.ui.emptyState({ icon, title, subtitle }) and Rundock.ui.loading({ label }).',
    row(
      item(ui.emptyState({ icon: 'inbox', title: 'No positions yet', subtitle: 'Connect a brokerage account to see holdings here.' }), 'empty state', 'g-w280'),
      item(ui.loading({ label: 'Loading positions' }), 'loading', 'g-w280'),
    ));

  const board = ui.board({
    columns: [
      { id: 'research', title: 'Researching', cards: [{ id: 'pltr', title: 'PLTR', meta: 'Govt AI contracts' }, { id: 'snow', title: 'SNOW', meta: 'Data cloud consolidation' }] },
      { id: 'thesis', title: 'Thesis built', cards: [{ id: 'crwd', title: 'CRWD', meta: 'Endpoint share gains' }] },
      { id: 'open', title: 'Position open', cards: [{ id: 'nvda', title: 'NVDA', meta: '30% of tech sleeve' }] },
    ],
    onCardMove: (card, to) => { document.body.dataset.lastMove = `${card}:${to}`; },
  });
  board.id = 'live-board';
  board.querySelector('[data-card="snow"]').classList.add('rui-force-hover');
  board.querySelector('[data-card="crwd"]').classList.add('rui-force-active');
  block('13', 'Board', 'Rundock.ui.board({ columns, onCardMove }): every card has a menu that moves it, so drag is an enhancement, not the only way.',
    board, make('div', 'g-state', 'column · card default · card hover · card active (dragging) · live: each card’s menu moves it'));

  const failing = ui.canvas({ render: () => { throw new Error('no data'); } });
  const pending = ui.canvas({ render: () => new Promise(() => {}) });
  const drawn = ui.canvas({ label: 'An extension-drawn chart', render: (el) => { el.appendChild(make('div', 'g-state', 'donut chart, extension-drawn')); el.style.minHeight = '100px'; el.style.display = 'flex'; el.style.alignItems = 'center'; el.style.justifyContent = 'center'; el.style.background = 'var(--surface)'; el.style.borderRadius = 'var(--radius-lg)'; } });
  block('14', 'Canvas', 'Rundock.ui.canvas({ render, label }): the one place an extension draws as it likes.',
    row(item(pending, 'loading', 'g-w280'), item(drawn, 'drawn', 'g-w280'), item(failing, 'failed', 'g-w280')));

  block('15', 'Meter', 'Rundock.ui.meter({ label, value, limit, isMinimum, marker }): value and limit are fractions.',
    row(
      item(ui.meter({ label: 'Largest sector', value: 0.21, limit: 0.3 }), 'under limit, with marker', 'g-w220'),
      item(ui.meter({ label: 'Largest single position', value: 0.18, limit: 0.15 }), 'over limit', 'g-w220'),
      item(ui.meter({ label: 'By sector, technology', value: 0.3 }), 'no limit (a plain share)', 'g-w220'),
    ));

  const alerts = make('div', 'g-col');
  alerts.appendChild(ui.alert({ tone: 'attention', message: 'One or more allocations exceed active risk constraints', action: { label: 'Review', onClick() {} } }));
  alerts.appendChild(ui.alert({ tone: 'danger', message: 'Someone else changed this since you loaded it. Reload and try again.' }));
  alerts.appendChild(ui.alert({ tone: 'success', message: 'Handed to Rundock to save.' }));
  // One line with two buttons, the shape Rundock's own request bar takes: the
  // icon, the text and the buttons share one centre line.
  const pair = document.createElement('span');
  pair.appendChild(ui.button({ label: 'Open', variant: 'primary', onClick() {} }));
  pair.appendChild(document.createTextNode(' '));
  pair.appendChild(ui.button({ label: 'Dismiss', onClick() {} }));
  const line = ui.alert({ tone: 'attention', message: 'Open Investment Dashboard.md?', action: pair });
  line.setAttribute('data-g', 'alert-line');
  alerts.appendChild(line);
  // A block of text: the icon and the action stay beside its first line.
  const list = document.createElement('div');
  list.appendChild(document.createTextNode('Two allocations exceed their limits:'));
  const ul = document.createElement('ul');
  for (const text of ['Equity at 62%, over its 55% limit', 'Crypto at 9%, over its 5% limit']) {
    const li = document.createElement('li');
    li.textContent = text;
    ul.appendChild(li);
  }
  list.appendChild(ul);
  const blockAlert = ui.alert({ tone: 'danger', message: list, action: { label: 'Review', onClick() {} } });
  blockAlert.setAttribute('data-g', 'alert-block');
  alerts.appendChild(blockAlert);
  block('16', 'Alert', 'Rundock.ui.alert({ tone, message, action, urgent }): the tone on the edge and the icon, never a tinted body.',
    alerts, make('div', 'g-state', 'attention, with action · danger · success · one line, two buttons · a block with its action on the first line'));

  block('17', 'Stat', 'Rundock.ui.stat({ label, value, delta, trend, negative })',
    row(
      item(ui.stat({ label: 'Day change', value: '−$2,140', negative: true, delta: '0.5% today', trend: 'down' }), 'negative value, delta down'),
      item(ui.stat({ label: 'Total cash', value: '11.0%', delta: '1.2pp this week', trend: 'up' }), 'delta up'),
      item(ui.stat({ label: 'Total value', value: '$399,920', delta: 'Across 4 accounts' }), 'plain secondary line, no trend'),
    ));

  const options = ui.optionList({ label: 'Strategy regime', options: ['Aggressive growth', 'Growth and income', 'Capital preservation', 'Value opportunities'], value: 'Growth and income' });
  options.id = 'live-options';
  block('18', 'Option list', 'Rundock.ui.optionList({ label, options, value, onChange }): the WAI-ARIA Radio Group pattern; arrows move and select.',
    row(item(options, 'live: arrow keys move and select, Space checks', 'g-w220')));

  const now = Date.parse('2026-09-23T12:00:00Z');
  block('19', 'Relative time', 'Rundock.ui.relativeTime({ iso, staleAfterMs, prefix }): a real <time>, stale said in words too.',
    row(
      item(ui.relativeTime({ iso: '2026-09-23T11:48:00Z', now, prefix: 'Updated' }), 'fresh'),
      item(ui.relativeTime({ iso: '2026-09-20T12:00:00Z', now, prefix: 'Priced', staleAfterMs: 86400000 }), 'stale'),
    ));

  block('20', 'Live chip', 'Rundock.ui.liveChip({ label }): the product\'s 2s pulse, still under reduced motion.',
    row(item(ui.liveChip({}), 'default, pulsing')));

  const staticMenu = ui.menu({ label: 'Change status', items: [{ value: 'r', label: 'Researching', checked: true }, { value: 't', label: 'Thesis built', checked: false }, { value: 'o', label: 'Position open', checked: false }] });
  staticMenu.querySelector('.rui-menu-list').classList.add('rui-open');
  staticMenu.querySelector('.rui-menu-btn').setAttribute('aria-expanded', 'true');
  staticMenu.querySelector('.rui-menu-btn').classList.add('rui-force-focus');
  staticMenu.querySelectorAll('.rui-menu-item')[1].classList.add('rui-force-hover');
  const liveMenu = ui.menu({ label: 'Change status', items: ['Researching', 'Thesis built', 'Position open'], onSelect: (v) => { document.body.dataset.lastSelect = v; } });
  liveMenu.id = 'live-menu';
  const openItem = item(staticMenu, 'open, current item marked');
  openItem.style.marginLeft = '150px';
  const rowMenu = ui.menu({ label: 'Actions for CRWD', items: ['Move to Roth IRA', 'Move to Crypto wallet', { separator: true }, 'Remove CRWD'] });
  rowMenu.querySelector('.rui-menu-list').classList.add('rui-open');
  rowMenu.querySelector('.rui-menu-btn').setAttribute('aria-expanded', 'true');
  const rowItem = item(rowMenu, 'open, a separator before Remove');
  rowItem.style.marginLeft = '150px';
  const menuRow = row(item(liveMenu, 'closed (live)'), openItem, rowItem);
  menuRow.style.minHeight = '150px';
  menuRow.style.alignItems = 'flex-start';
  block('21', 'Menu', 'Rundock.ui.menu({ trigger, label, items, onSelect }): the menu button pattern; Escape returns focus to the trigger. { separator: true } draws a rule between groups, which the keys pass over.',
    menuRow);

  const live = ui.slider({ label: 'Live slider', value: 50, format: (v) => `${v} percent` });
  live.id = 'live-slider';
  document.body.appendChild(make('div', 'g-title', 'Live controls for the keyboard'));
  document.body.appendChild(row(item(live, 'arrow keys', 'g-w200')));

  document.body.dataset.drawn = 'true';
  const report = () => parent.postMessage({ type: 'gallery-height', height: document.documentElement.scrollHeight }, '*');
  report();
  if (typeof ResizeObserver === 'function') new ResizeObserver(report).observe(document.body);
}

function frameFor(theme) {
  const body = document.body;
  const was = body.classList.contains('light');
  body.classList.toggle('light', theme === 'light');
  // The host reads the theme's token values off this page's body at build
  // time, which is exactly how a real mount gets them.
  const srcdoc = buildRegionSrcdoc({ entry: `(${drawGallery.toString()})();`, styles: [GALLERY_CSS] }, document);
  body.classList.toggle('light', was);
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', `Rundock UI gallery, ${theme} theme`);
  frame.dataset.theme = theme;
  frame.className = 'gallery-frame';
  frame.srcdoc = srcdoc;
  return frame;
}

const panes = document.getElementById('panes');
const frames = [frameFor('dark'), frameFor('light')];
for (const frame of frames) panes.appendChild(frame);
window.addEventListener('message', (event) => {
  const frame = frames.find((f) => f.contentWindow === event.source);
  if (!frame || !event.data || event.data.type !== 'gallery-height') return;
  const height = Math.max(200, Math.min(20000, Number(event.data.height) || 0));
  frame.style.height = `${height}px`;
});
