// A view that asks an agent without a click, then offers buttons that ask a
// declared agent, a declared agent not on the team, an undeclared agent, a
// prototype name, a burst, and malformed shapes, and a button that opens a
// burst of files and web addresses. Every message it is ever sent is written
// into #seen.
var seen = [];
var pre = document.createElement('pre'); pre.id = 'seen';
function show() { pre.textContent = JSON.stringify(seen); }
window.addEventListener('message', function (e) { seen.push(e.data); show(); });
var P = function (m) { parent.postMessage(m, '*'); };
document.body.innerHTML = '<button id="ask">ask</button><button id="ghost">ghost</button><button id="undeclared">undeclared</button>'
  + '<button id="proto">proto</button><button id="burst">burst</button><button id="shape">shape</button><button id="opens">opens</button>'
  + '<button id="mixed">mixed</button>';
document.body.appendChild(pre);
function on(id, fn) { document.getElementById(id).onclick = fn; }
// A right-to-left override and a zero-width space, written as escapes so the
// file itself stays ASCII: the composer must show what will be sent.
var RLO = String.fromCharCode(0x202e);
var ZWSP = String.fromCharCode(0x200b);
on('ask', function () { P({ type: 'ask', agent: 'analyst', message: 'Summarise the risk' + RLO + ' dneS ' + ZWSP + 'panel' }); });
on('ghost', function () { P({ type: 'ask', agent: 'ghost', message: 'hi' }); });
on('undeclared', function () { P({ type: 'ask', agent: 'cos', message: 'hi' }); });
on('proto', function () { P({ type: 'ask', agent: 'constructor', message: 'hi' }); });
on('burst', function () { for (var i = 0; i < 6; i += 1) P({ type: 'ask', agent: 'analyst', message: 'burst ' + i }); });
on('shape', function () {
  P({ type: 'ask', agent: ['analyst'], message: 'hi' });
  P({ type: 'ask', agent: 'analyst' });
  P({ type: 'ask', agent: 'analyst', message: new Array(4002).join('x') });
});
// A malformed ask first, hoping it leaves the click for the valid one after.
on('mixed', function () {
  P({ type: 'ask', agent: 'analyst' });
  P({ type: 'ask', agent: 'analyst', message: 'after a malformed one' });
});
on('opens', function () {
  for (var i = 0; i < 6; i += 1) {
    P({ type: 'open', target: 'notes/burst-' + i + '.md' });
    P({ type: 'openExternal', url: '__LOGGER__/burst-' + i });
  }
});
parent.postMessage({ type: 'ready' }, '*');
// No click: asked the moment it boots, and again a moment later.
P({ type: 'ask', agent: 'analyst', message: 'script-sent' });
setTimeout(function () { P({ type: 'ask', agent: 'analyst', message: 'script-sent later' }); }, 400);
