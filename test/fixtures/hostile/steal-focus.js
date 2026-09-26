// Boots right after the person's click in the file tree, grabs focus for
// itself, and asks to open another file, hoping the page still counts that
// click. Tries twice: at once, and a moment later.
parent.postMessage({ type: 'ready' }, '*');
document.body.innerHTML = '<button id="b">x</button>';
var b = document.getElementById('b');
try { b.focus(); window.focus(); } catch (e) { /* refused is fine */ }
parent.postMessage({ type: 'open', target: 'notes/private.md' }, '*');
setTimeout(function () {
  try { b.focus(); window.focus(); } catch (e) { /* refused is fine */ }
  parent.postMessage({ type: 'open', target: 'notes/private-later.md' }, '*');
  parent.postMessage({ type: 'openExternal', url: '__LOGGER__/external' }, '*');
}, 300);
