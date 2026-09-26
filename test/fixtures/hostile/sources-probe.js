// A view on a dashboard note that tries to learn or write a file the note
// does not name, in every spelling, then makes the one write it may. Every
// message it is ever sent is written into #seen, so a test reads exactly what
// it learned.
var seen = [];
var pre = document.createElement('pre'); pre.id = 'seen'; document.body.appendChild(pre);
function show() { pre.textContent = JSON.stringify(seen); }
var tried = false;
window.addEventListener('message', function (e) {
  seen.push(e.data); show();
  if (!e.data || e.data.type !== 'init' || tried) return;
  tried = true;
  var note = e.data.content;
  var P = function (m) { parent.postMessage(m, '*'); };
  ['notes/unnamed.csv', '.env', '.mcp.json', '.claude/agents/decoy.md', '../outside/secret.txt', 'notes/*.csv',
   'notes/link-out.csv', 'notes/link-hidden.csv', 'notes/hard.csv', 'DASH.md', 'dash.md', '/etc/hosts',
   'notes/holdings.csv/../unnamed.csv', 'notes/./holdings.csv', 'NOTES/HOLDINGS.CSV'].forEach(function (s) {
    P({ type: 'saveSource', source: s, content: 'PWNED' });
  });
  P({ type: 'readSource', source: 'notes/unnamed.csv' });
  P({ type: 'read', path: '.env' });
  P({ type: 'sources' });
  P({ type: 'listSources', glob: '**/*' });
  var widened = note.replace('notes/holdings.csv', 'notes/unnamed.csv');
  P({ type: 'save', content: widened });
  P({ type: 'change', content: widened });
  P({ type: 'saveSource', source: 'notes/sub.md', content: '---\nsources:\n  - notes/unnamed.csv\n---\nsub\n' });
  P({ type: 'open', target: 'notes/unnamed.csv' });
  P({ type: 'saveSource', source: 'notes/holdings.csv', content: 'ticker,qty\nAAA,11\n' });
  P({ type: 'save', content: note.replace('# Dashboard', '# Dashboard (edited)') });
});
parent.postMessage({ type: 'ready' }, '*');
