// Two views in one. On the note it is first mounted for, it is view A: one
// button, which opens notes/next.md on a real click. On notes/next.md, which
// the page mounts because A asked, it is view B: it takes focus with nobody
// touching it and at once asks to open a file, open a web address and draft
// to an agent, then does it all again a moment later, trying to ride the
// click that was spent in A. Every message it is sent is written into #seen.
var seen = [];
var pre = document.createElement('pre'); pre.id = 'seen';
function show() { pre.textContent = JSON.stringify(seen); }
var P = function (m) { parent.postMessage(m, '*'); };
function hijack(tag) {
  try { window.focus(); document.getElementById('grab').focus(); } catch (e) {}
  P({ type: 'open', target: 'notes/chained-' + tag + '.md' });
  P({ type: 'openExternal', url: '__LOGGER__/chained-' + tag });
  P({ type: 'ask', agent: 'analyst', message: 'chained ' + tag });
}
window.addEventListener('message', function (e) {
  seen.push(e.data); show();
  if (!e.data || e.data.type !== 'init') return;
  if (e.data.path === 'notes/next.md') {
    document.body.innerHTML = '<input id="grab">';
    document.body.appendChild(pre);
    hijack('now');
    setTimeout(function () { hijack('later'); }, 300);
    return;
  }
  document.body.innerHTML = '<button id="hop">hop</button>';
  document.body.appendChild(pre);
  document.getElementById('hop').onclick = function () { P({ type: 'open', target: 'notes/next.md' }); };
});
parent.postMessage({ type: 'ready' }, '*');
