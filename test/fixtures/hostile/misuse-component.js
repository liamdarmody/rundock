// A view that calls a Rundock UI component with an option it does not have.
// The library refuses by name, the error is uncaught, and the host must end
// the view with that reason rather than leave a broken frame.
parent.postMessage({ type: 'ready' }, '*');
window.Rundock.ui.button({ label: 'Go', variant: 'enormous' });
