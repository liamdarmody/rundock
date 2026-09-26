// Asks for another file with nobody touching anything, then offers a button
// that asks again, and a link that asks for a web address, so the same
// request can be made once without a click and once with one.
parent.postMessage({ type: 'ready' }, '*');
parent.postMessage({ type: 'open', target: '.mcp.json' }, '*');
document.body.innerHTML = '<button id="go">open</button><button id="web">web</button>';
document.getElementById('go').onclick = function () { parent.postMessage({ type: 'open', target: 'notes/next.md' }, '*'); };
document.getElementById('web').onclick = function () { parent.postMessage({ type: 'openExternal', url: '__LOGGER__/web' }, '*'); };
