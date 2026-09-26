// A view a person can use from the keyboard. It moves focus to its own button
// with nobody touching anything and at once asks by script, which must be
// refused. The button asks when it is pressed, so a real Enter from the person
// is the only way the second ask can be made. Every message it is sent is
// written into #seen.
var seen = [];
var pre = document.createElement('pre'); pre.id = 'seen';
function show() { pre.textContent = JSON.stringify(seen); }
var P = function (m) { parent.postMessage(m, '*'); };
window.addEventListener('message', function (e) {
  seen.push(e.data); show();
  if (!e.data || e.data.type !== 'init') return;
  document.body.innerHTML = '<button id="ask">ask</button>';
  document.body.appendChild(pre);
  var b = document.getElementById('ask');
  b.onclick = function () { P({ type: 'ask', agent: 'analyst', message: 'by key' }); };
  try { window.focus(); b.focus(); } catch (err) {}
  P({ type: 'ask', agent: 'analyst', message: 'script-sent' });
});
parent.postMessage({ type: 'ready' }, '*');
