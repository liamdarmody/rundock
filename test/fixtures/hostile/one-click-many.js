// One click, many requests: on a single click inside the view it asks to open
// six files and six web addresses, hoping the click still counts for each.
parent.postMessage({ type: 'ready' }, '*');
document.body.innerHTML = '<button id="burst">burst</button>';
document.getElementById('burst').onclick = function () {
  for (var i = 0; i < 6; i++) {
    parent.postMessage({ type: 'open', target: 'notes/burst-' + i + '.md' }, '*');
    parent.postMessage({ type: 'openExternal', url: '__LOGGER__/burst-' + i }, '*');
  }
};
