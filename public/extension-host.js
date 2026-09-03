// The sandboxed extension host: one mount, one opaque-origin frame, one
// mediator, and a teardown that cannot be forgotten.
//
// THE CONTRACT IS THE DOCUMENT, NOT THIS FILE. docs/EXTENSION-HOST.md states
// what a mounted extension can reach and what it cannot; the message table
// below is checked against that document by a test, so the two cannot drift.
// Anything this file allows that the document does not name is a defect by
// definition, whatever it enables.
//
// WHY THE SANDBOX POSTURE IS THE OPPOSITE OF THE ARTIFACT VIEWER'S. The
// artifact preview is allow-same-origin with NO allow-scripts: an inert
// document the host can read into. An extension view is the inverse: it must
// run its own code and the host must be unable to be read by it, so it is
// allow-scripts with NO allow-same-origin, which makes its origin opaque.
// The two grants must never be combined anywhere in this codebase: together
// they hand the framed code the app's own origin. mount() refuses to build
// any other posture rather than trusting callers not to ask.
//
// EVERY MESSAGE PASSES THE MEDIATOR, and the mediator's table is closed. A
// message whose type is not in the table, or whose fields are not the shape
// the table declares, is refused with a reason posted back to the frame, so
// a misbehaving extension can see what it did wrong and an audited transcript
// shows every refusal. Silence would be kinder to the extension author and
// worse for everyone else.

// The closed message table: everything an extension may say to the host.
// Field checks are functions so the table carries the whole shape, not just
// the name. Kept as data so the contract test can read it.
export const EXTENSION_MESSAGES = {
  ready: {},
  resize: { height: (v) => typeof v === 'number' && Number.isFinite(v) },
  error: { message: (v) => typeof v === 'string' },
  open: { target: (v) => typeof v === 'string' && v.length > 0 },
  read: { resource: (v) => typeof v === 'string' && v.length > 0 },
  write: {
    resource: (v) => typeof v === 'string' && v.length > 0,
    content: (v) => typeof v === 'string',
  },
};

// Messages the host may say to a frame. Listed for the contract test; the
// host never accepts these directions in reverse.
export const HOST_MESSAGES = ['init', 'resource', 'refused'];

// The frame height is a request, not a command. Clamped so a hostile or
// broken view cannot stretch the page into uselessness.
export const MIN_FRAME_HEIGHT = 40;
export const MAX_FRAME_HEIGHT = 4000;

// How long a view gets to say `ready` before it is judged hung. Injectable
// so the test does not wait it out in real time.
export const READY_TIMEOUT_MS = 5000;

// The frame document's own policy: no network of any kind, inline code and
// styles only (the payload is inlined by the host), data: images so a view
// can draw without fetching.
const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; "
  + "style-src 'unsafe-inline'; img-src data:;";

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The frame's document, composed by the host so nothing arrives from
// anywhere but the installed payload: the extension's styles, a bootstrap
// that forwards uncaught failures as `error` messages (a cross-origin frame
// cannot be observed from outside, so the frame reports on itself), and the
// entry script.
function buildSrcdoc(payload) {
  const styles = (payload.styles || []).map((css) => `<style>${css}</style>`).join('');
  const bootstrap = 'window.onerror=function(m){parent.postMessage({type:"error",message:String(m)},"*");};';
  return '<!doctype html><html><head>'
    + `<meta http-equiv="Content-Security-Policy" content="${esc(FRAME_CSP)}">`
    + styles
    + '</head><body>'
    + `<script>${bootstrap}</scr` + 'ipt>'
    + `<script>${payload.entry || ''}</scr` + 'ipt>'
    + '</body></html>';
}

/**
 * Validate one arriving message against the closed table.
 *
 * @returns {{ ok: true, type: string } | { ok: false, of: string, reason: string }}
 */
export function validateMessage(data) {
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
    return { ok: false, of: 'unknown', reason: 'a message must be an object with a string type' };
  }
  const shape = EXTENSION_MESSAGES[data.type];
  if (!shape) {
    return { ok: false, of: data.type, reason: `the contract names no message of type "${data.type}"` };
  }
  for (const [field, check] of Object.entries(shape)) {
    if (!check(data[field])) {
      return { ok: false, of: data.type, reason: `the contract requires "${field}" of a different shape on "${data.type}"` };
    }
  }
  return { ok: true, type: data.type };
}

/**
 * Mount one extension view into a pane.
 *
 * @param {{
 *   paneElement: Element,
 *   payload: { entry: string, styles?: string[], resources?: Array<{id: string, maximumBytes?: number}> },
 *   onOpen?: (target: string) => void,
 *   onDegrade: (reason: string) => void,
 *   readResource?: (id: string) => Promise<string>,
 *   writeResource?: (id: string, content: string) => Promise<void>,
 *   readyTimeoutMs?: number,
 *   now?: () => number,
 * }} opts
 *
 * `onDegrade` is not optional, deliberately: a host mounted with nowhere to
 * fall back to is a host that can lose the surface it was given, which the
 * contract forbids. The caller owns the plain rendering; the host only ever
 * promises to hand control back with the failure named.
 */
export function mountExtension(opts) {
  const {
    paneElement, payload, onOpen, onDegrade,
    readResource, writeResource,
    readyTimeoutMs = READY_TIMEOUT_MS,
  } = opts;
  if (typeof onDegrade !== 'function') {
    throw new Error('mountExtension requires onDegrade: the plain rendering is the contract\'s floor');
  }
  const doc = paneElement.ownerDocument;
  const win = doc.defaultView;

  // Declared resources, by id. The mediator refuses anything else before the
  // server is ever asked, so an undeclared id is refused on the wire.
  const declared = new Map();
  for (const r of (payload.resources || [])) declared.set(r.id, r);

  let frame = null;
  let alive = false;
  let readyTimer = null;

  function send(message) {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage(message, '*');
  }

  function teardown() {
    if (readyTimer) { win.clearTimeout(readyTimer); readyTimer = null; }
    if (frame) {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
      frame = null;
    }
    alive = false;
    win.removeEventListener('message', onMessage);
  }

  function degrade(reason) {
    teardown();
    onDegrade(reason);
  }

  // The one entry for arriving messages. Exposed on the handle as
  // `dispatch` so the wire can be driven by a test; the DOM listener below
  // is one line over it. Messages from any window that is not the live
  // frame are ignored entirely, including a frame this mount has since torn
  // down: replying to the dead would only teach it to keep talking.
  function dispatch(event) {
    if (!alive || !frame || event.source !== frame.contentWindow) return;
    const verdict = validateMessage(event.data);
    if (!verdict.ok) {
      send({ type: 'refused', of: verdict.of, reason: verdict.reason });
      return;
    }
    const data = event.data;
    if (data.type === 'ready') {
      if (readyTimer) { win.clearTimeout(readyTimer); readyTimer = null; }
      send({ type: 'init' });
      return;
    }
    if (data.type === 'error') {
      degrade(`the extension reported a failure: ${data.message}`);
      return;
    }
    if (data.type === 'resize') {
      const h = Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, data.height));
      if (frame) frame.style.height = `${h}px`;
      return;
    }
    if (data.type === 'open') {
      if (typeof onOpen === 'function') onOpen(data.target);
      return;
    }
    if (data.type === 'read' || data.type === 'write') {
      const resource = declared.get(data.resource);
      if (!resource) {
        send({ type: 'refused', of: data.type, reason: `the manifest declares no resource "${data.resource}"` });
        return;
      }
      if (data.type === 'write') {
        const cap = resource.maximumBytes || 65536;
        if (data.content.length > cap) {
          send({ type: 'refused', of: 'write', reason: `"${data.resource}" is capped at ${cap} bytes` });
          return;
        }
        if (typeof writeResource === 'function') writeResource(data.resource, data.content);
        return;
      }
      if (typeof readResource === 'function') {
        Promise.resolve(readResource(data.resource)).then(
          (content) => send({ type: 'resource', resource: data.resource, content }),
          (e) => send({ type: 'refused', of: 'read', reason: String(e && e.message || e) }),
        );
      }
      return;
    }
  }

  function onMessage(event) { dispatch(event); }

  try {
    frame = doc.createElement('iframe');
    frame.className = 'extension-frame';
    // The whole posture in one attribute, set before anything else so a
    // failure between here and the append can never leave a wider frame.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', 'Extension view');
    frame.srcdoc = buildSrcdoc(payload);
    paneElement.appendChild(frame);
    alive = true;
    win.addEventListener('message', onMessage);
    readyTimer = win.setTimeout(() => {
      degrade(`the extension did not start within ${readyTimeoutMs}ms`);
    }, readyTimeoutMs);
  } catch (e) {
    degrade(`the extension could not be mounted: ${String(e && e.message || e)}`);
    return { alive: () => false, teardown() {}, swap() {}, dispatch() {}, frame: null };
  }

  const handle = {
    alive: () => alive,
    frame: () => frame,
    dispatch,
    teardown,
    // An update or uninstall under a live mount: the old frame leaves
    // cleanly and, for an update, the new payload mounts fresh. The old
    // frame's window stops matching the live source the moment teardown
    // runs, so a late message from it is ignored by construction.
    swap(newPayload) {
      teardown();
      if (newPayload) {
        return mountExtension({ ...opts, payload: newPayload });
      }
      return null;
    },
  };
  return handle;
}
