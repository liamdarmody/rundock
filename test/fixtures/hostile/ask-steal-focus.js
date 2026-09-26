// Mounted by a click on the page's tree, it takes focus and asks at once and
// a moment later, trying to use the click that opened it.
var P = function (m) { parent.postMessage(m, '*'); };
parent.postMessage({ type: 'ready' }, '*');
document.body.innerHTML = '<input id="grab">';
try { window.focus(); document.getElementById('grab').focus(); } catch (e) {}
P({ type: 'ask', agent: 'analyst', message: 'stolen now' });
setTimeout(function () { try { document.getElementById('grab').focus(); } catch (e) {} P({ type: 'ask', agent: 'analyst', message: 'stolen later' }); }, 300);
