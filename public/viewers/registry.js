// File-type registry: decides which view surface owns a workspace path and
// mounts it. Design of record: FV2 (file-type registry + sandboxed HTML
// artifact viewer). Ordered; first match wins; 'unsupported' is the terminal
// fallback so no path ever renders as raw corrupted bytes.
//
// Pre-sync-point shape: app.js keeps its markdown (Tiptap) and text (legacy
// preview/edit pane) branches and consults this registry for everything else.
// At the stage-2 sync point loadFileContent collapses to a registry lookup
// and markdown/text become entries here (see the SEAM comment in app.js).
//
// Viewer mount contract (mirrors the editor module's boundary):
//   mount({ paneElement, path, content }) -> { getContentForSave|null, destroy() }
// A null getContentForSave marks the viewer read-only: it never participates
// in autosave or Cmd+S.

// ---------- classification (pure; unit-tested without a DOM) ----------

export const FILE_KINDS = [
  { kind: 'markdown', match: (p) => /\.(md|mdx)$/i.test(p) },
  { kind: 'artifact', match: (p) => /\.(html?|svg)$/i.test(p) },
  { kind: 'image', match: (p) => /\.(png|jpe?g|gif|webp)$/i.test(p) },
  { kind: 'pdf', match: (p) => /\.pdf$/i.test(p) },
  { kind: 'text', match: (p) => /\.(txt|json)$/i.test(p) },
  { kind: 'unsupported', match: () => true },
];

export function classify(path) {
  if (typeof path !== 'string' || !path) return 'unsupported';
  return FILE_KINDS.find((e) => e.match(path)).kind;
}

// URL for the server's binary transport (image/pdf bytes cannot ride the
// utf-8 WS read_file path). The server allowlists extensions and enforces
// the workspace boundary; the client just builds the URL.
export function workspaceFileUrl(path) {
  return '/workspace-file?path=' + encodeURIComponent(path);
}

// The artifact preview renders the file's real DOM in a sandboxed iframe
// (sandbox="allow-same-origin", NO allow-scripts: see mountArtifactPreview
// for why the host needs same-origin and why scripts stay off). Script
// execution is off regardless of CSP; the injected CSP additionally blocks
// external fetches (the app's CSP discipline): a reviewed artifact must not
// phone home via <img src="https://..."> or @import. Inline styles and
// data:/blob: images keep self-contained artifacts (design-export) faithful.
export const ARTIFACT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;

// Inject the CSP meta so it is honoured for EVERY resource the artifact
// references. A meta CSP only applies to fetches that come after it in
// document order, and only when it parses into the head. Injecting after the
// artifact's own <head> is defeatable: any resource-loading element placed
// before that head (e.g. a leading <img src="https://...">) both fires its
// fetch first AND displaces the meta out of the real head, voiding the whole
// policy. So the meta must be the FIRST thing the parser sees: it lands in
// the implied head and commits the policy before any element is processed.
// A leading <!doctype> is preserved (the meta goes right after it, still
// ahead of every element, avoiding quirks mode).
export function buildSrcdoc(content) {
  const src = String(content == null ? '' : content);
  const doctypeMatch = src.match(/^\s*<!doctype[^>]*>/i);
  if (doctypeMatch) {
    const at = doctypeMatch[0].length;
    return src.slice(0, at) + CSP_META + src.slice(at);
  }
  return CSP_META + src;
}

// ---------- styles (self-injected, editor-module precedent) ----------

let stylesInjected = false;
function ensureStyles(doc) {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = doc.createElement('style');
  style.dataset.rundockViewers = '';
  style.textContent = `
    .viewer-host { padding: 0 !important; display: flex; flex-direction: column; position: relative; }
    .viewer-frame { flex: 1; width: 100%; border: none; background: #fff; }
    /* Review sidebar layout for the artifact pane (mirrors the editor
       pane's review-active grid in editor/styles.js). */
    .editor-content.viewer-host.review-active {
      display: grid;
      grid-template-columns: minmax(0, 1fr) var(--review-sidebar-width, 260px);
      grid-template-rows: minmax(0, 1fr); /* the frame fills the pane; auto rows collapse an iframe to its 150px default */
      column-gap: 20px;
    }
    .editor-content.viewer-host.review-active > .viewer-frame { grid-column: 1; height: 100%; }
    .editor-content.viewer-host.review-active > .review-sidebar { align-self: start; }
    .artifact-comment-btn {
      display: none;
      position: absolute;
      z-index: 6;
      transform: translateX(-50%);
      padding: 4px 12px;
      border-radius: 100px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text-1);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    }
    .artifact-comment-btn.visible { display: block; }
    .artifact-review-readonly { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 6; max-width: 70%; padding: 6px 14px; border-radius: 8px; background: rgba(232,168,76,0.14); border: 1px solid rgba(232,168,76,0.35); color: var(--text-1); font-size: 12px; text-align: center; }
    .viewer-image-wrap { flex: 1; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 24px; }
    .viewer-image-wrap img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .viewer-unsupported { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--text-2); }
    .viewer-unsupported .viewer-unsupported-title { font-weight: 600; color: var(--text-1); }
  `;
  doc.head.appendChild(style);
}

function makeHandle(paneElement, cleanup) {
  let destroyed = false;
  return {
    getContentForSave: null, // read-only: never participates in save
    destroy() {
      if (destroyed) return;
      destroyed = true;
      paneElement.classList.remove('viewer-host');
      paneElement.innerHTML = '';
      if (cleanup) cleanup();
    },
  };
}

// ---------- viewers ----------

// Sandboxed HTML/SVG artifact preview. Read-only; the code view (raw source
// in the legacy textarea) stays the editing surface.
//
// Sandbox posture: allow-same-origin and NOTHING else. No allow-scripts
// means the document cannot execute any code, so the same-origin grant
// exposes nothing to the artifact itself; it exists so the HOST can read
// contentDocument for the review loop (selection capture, comment marks).
// The injected CSP additionally blocks external fetches. Adding
// allow-scripts alongside allow-same-origin would give artifact code the
// app's origin: never combine them.
export function mountArtifactPreview({ paneElement, content }) {
  const doc = paneElement.ownerDocument;
  ensureStyles(doc);
  paneElement.innerHTML = '';
  paneElement.classList.add('viewer-host');
  const iframe = doc.createElement('iframe');
  iframe.className = 'viewer-frame';
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('title', 'Artifact preview');
  iframe.srcdoc = buildSrcdoc(content);
  paneElement.appendChild(iframe);
  const handle = makeHandle(paneElement);
  handle.iframe = iframe; // the review loop attaches to the loaded frame
  return handle;
}

export function mountImageViewer({ paneElement, path }) {
  const doc = paneElement.ownerDocument;
  ensureStyles(doc);
  paneElement.innerHTML = '';
  paneElement.classList.add('viewer-host');
  const wrap = doc.createElement('div');
  wrap.className = 'viewer-image-wrap';
  const img = doc.createElement('img');
  img.src = workspaceFileUrl(path);
  img.alt = path;
  wrap.appendChild(img);
  paneElement.appendChild(wrap);
  return makeHandle(paneElement);
}

// The browser's native PDF viewer over the binary endpoint. Deliberately no
// sandbox attribute: a sandboxed iframe disables Chromium's PDF plugin, and
// the src is our own allowlisted same-origin endpoint (content-type pinned
// to application/pdf, nosniff), not arbitrary document content.
export function mountPdfViewer({ paneElement, path }) {
  const doc = paneElement.ownerDocument;
  ensureStyles(doc);
  paneElement.innerHTML = '';
  paneElement.classList.add('viewer-host');
  const iframe = doc.createElement('iframe');
  iframe.className = 'viewer-frame';
  iframe.setAttribute('title', 'PDF viewer');
  iframe.src = workspaceFileUrl(path);
  paneElement.appendChild(iframe);
  return makeHandle(paneElement);
}

export function mountUnsupportedViewer({ paneElement, path }) {
  const doc = paneElement.ownerDocument;
  ensureStyles(doc);
  paneElement.innerHTML = '';
  paneElement.classList.add('viewer-host');
  const box = doc.createElement('div');
  box.className = 'viewer-unsupported';
  const ext = (String(path).match(/\.[\w]+$/) || ['file'])[0];
  const title = doc.createElement('div');
  title.className = 'viewer-unsupported-title';
  title.textContent = 'Cannot preview this file';
  const detail = doc.createElement('div');
  detail.textContent = `${ext} files cannot be previewed in Rundock yet.`;
  box.appendChild(title);
  box.appendChild(detail);
  paneElement.appendChild(box);
  return makeHandle(paneElement);
}

// Kind -> mount, for the app.js shim's non-artifact branch (artifact preview
// mounts from the Preview/Code toggle path instead, so code view keeps
// working for HTML files).
export function mountViewer(kind, opts) {
  if (kind === 'image') return mountImageViewer(opts);
  if (kind === 'pdf') return mountPdfViewer(opts);
  return mountUnsupportedViewer(opts);
}
