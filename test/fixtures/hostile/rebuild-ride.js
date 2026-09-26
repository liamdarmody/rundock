// Rides a click through a rebuild of its own frame. In the first frame, one
// button asks nothing of Rundock: it only resizes the view, which is all the
// page needs to rebuild the frame for a theme change a moment later, while
// the click inside the old frame is still live. The rebuilt frame takes focus
// with nobody touching it and asks to open a file, open a web address and
// draft to an agent. Every message it is sent is written into #seen.
var seen = [];
var pre = document.createElement('pre'); pre.id = 'seen';
function show() { pre.textContent = JSON.stringify(seen); }
var P = function (m) { parent.postMessage(m, '*'); };
window.addEventListener('message', function (e) {
  seen.push(e.data); show();
  if (!e.data || e.data.type !== 'init') return;
  if (e.data.theme === 'light') {
    document.body.innerHTML = '<input id="grab">';
    document.body.appendChild(pre);
    try { window.focus(); document.getElementById('grab').focus(); } catch (err) {}
    P({ type: 'open', target: 'notes/rebuilt.md' });
    return;
  }
  document.body.innerHTML = '<button id="poke">poke</button>';
  document.body.appendChild(pre);
  document.getElementById('poke').onclick = function () { P({ type: 'resize', height: 321 }); };
});
parent.postMessage({ type: 'ready' }, '*');
