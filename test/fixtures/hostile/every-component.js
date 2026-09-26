// Builds every Rundock UI component and works each one the way a person
// would (clicks, keys, a menu choice, a board move, typing, a failing and a
// succeeding canvas), before and after `init`. The only message it sends of
// its own is `ready`: the run proves the library, used fully, adds nothing to
// what reaches the host.
var ui = window.Rundock.ui;
var key = function (el, k) { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); };
function work() {
  var root = document.createElement('div');
  document.body.appendChild(root);
  var add = function (el) { root.appendChild(el); return el; };
  add(ui.button({ label: 'Save', variant: 'primary', onClick: function () {} })).click();
  var send = add(ui.iconButton({ label: 'Send', variant: 'send' }));
  send.setState('active'); send.click(); send.setState('cancel'); send.click();
  add(ui.iconButton({ label: 'More' })).click();
  add(ui.card({ title: 'Card', interactive: true, onClick: function () {} })).click();
  var input = ui.input({ type: 'number', onChange: function () {} });
  var field = add(ui.field({ label: 'Size', control: input, help: 'Help' }));
  input.value = '4'; input.dispatchEvent(new Event('input', { bubbles: true })); field.setError('Too big'); field.setError(null);
  var sel = add(ui.select({ options: ['a', 'b'], label: 'S', onChange: function () {} })).querySelector('select');
  sel.value = 'b'; sel.dispatchEvent(new Event('change', { bubbles: true }));
  add(ui.checkbox({ label: 'C', indeterminate: true, onChange: function () {} })).click();
  add(ui.toggle({ label: 'T', onChange: function () {} })).click();
  var range = add(ui.slider({ label: 'R', value: 5, format: function (v) { return v + '%'; }, onChange: function () {} })).querySelector('input');
  range.value = '9'; range.dispatchEvent(new Event('input', { bubbles: true }));
  var tabs = add(ui.tabs({ label: 'Tabs', options: ['a', 'b', 'c'], onChange: function () {} }));
  var tab = tabs.querySelector('[role=tab]'); tab.focus(); key(tab, 'ArrowRight'); key(document.activeElement, 'End'); key(document.activeElement, 'Home');
  var opts = add(ui.optionList({ label: 'Opts', options: ['a', 'b'], onChange: function () {} }));
  var radio = opts.querySelector('[role=radio]'); radio.focus(); key(radio, 'ArrowDown'); key(document.activeElement, ' ');
  add(ui.table({ columns: [{ key: 'k', numeric: true }], rows: [{ k: 1 }, { k: 2 }] }));
  ['neutral', 'accent', 'attention', 'success', 'danger'].forEach(function (t) { add(ui.chip({ tone: t, label: t })); });
  add(ui.emptyState({ icon: 'inbox', title: 'E' })); add(ui.loading({}));
  var board = add(ui.board({ columns: [{ id: 'a', cards: [{ id: 'x', title: 'X' }] }, { id: 'b' }], onCardMove: function () {} }));
  board.querySelector('.rui-menu-btn').click(); board.querySelectorAll('[role=menuitemradio]')[1].click();
  add(ui.canvas({ label: 'drawn', render: function (el) { el.textContent = 'ok'; } }));
  var failing = add(ui.canvas({ render: function () { throw new Error('nothing to draw'); } }));
  failing.querySelector('button').click();
  add(ui.meter({ label: 'M', value: 0.4, limit: 0.3 })); add(ui.alert({ tone: 'danger', message: 'A', action: { label: 'Go', onClick: function () {} } })).querySelector('button').click();
  add(ui.stat({ label: 'S', value: -2, delta: '1%', trend: 'down' }));
  add(ui.relativeTime({ iso: '2026-01-01T00:00:00Z', staleAfterMs: 1 })); add(ui.liveChip({}));
  var menu = add(ui.menu({ label: 'Menu', items: ['a', 'b'], onSelect: function () {} }));
  var trigger = menu.querySelector('.rui-menu-btn'); trigger.focus(); key(trigger, 'ArrowDown'); key(document.activeElement, 'ArrowDown'); key(document.activeElement, 'Escape');
  trigger.click(); menu.querySelectorAll('[role=menuitem]')[0].click();
}
work();
window.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'init') { work(); document.body.setAttribute('data-worked', 'twice'); }
});
parent.postMessage({ type: 'ready' }, '*');
