// Editor test harness: boots the real Tiptap editor (public/editor/) inside
// jsdom so round-trip tests exercise the exact code the browser runs, not a
// reimplementation. Byte-for-byte round-trip is the hard acceptance bar for
// the editor surface (Obsidian parity), so tests must go through the real
// parse -> ProseMirror -> serialize pipeline.
//
// Usage:
//   const { createEditor, getMarkdown, destroyEditor, window } = await bootEditorEnv();
//   const { editor } = createEditor({ element, rawMarkdown });
//   const out = getMarkdown(editor);
//
// The jsdom globals are installed once per process (node --test runs each
// test file in its own process, so files stay isolated). The editor module
// and vendor bundle are ESM and import cleanly under Node once DOM globals
// exist.

import { JSDOM } from 'jsdom';

let _envPromise = null;

function installGlobals() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // ProseMirror touches these at import time and at Editor construction.
  const globalsToCopy = [
    'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement',
    'Document', 'DocumentFragment', 'Text', 'Comment', 'DOMParser',
    'MutationObserver', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'InputEvent', 'KeyboardEvent', 'MouseEvent',
    'CustomEvent', 'Event', 'Range', 'NodeFilter', 'XMLSerializer',
    'ClipboardEvent', 'DragEvent', 'ResizeObserver',
  ];

  // jsdom lacks a few APIs ProseMirror probes for; provide minimal stubs.
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  if (!window.ClipboardEvent) window.ClipboardEvent = window.Event;
  if (!window.DragEvent) window.DragEvent = window.Event;

  globalThis.window = window;
  for (const key of globalsToCopy) {
    if (window[key] !== undefined && globalThis[key] === undefined) {
      globalThis[key] = window[key];
    }
  }
  // Range.getClientRects / getBoundingClientRect are missing on jsdom Ranges;
  // ProseMirror's view layer calls them during selection reads.
  const rectList = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });
  if (window.Range && !window.Range.prototype.getClientRects) {
    window.Range.prototype.getClientRects = rectList;
    window.Range.prototype.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
  }
  if (window.Element && !window.Element.prototype.scrollIntoView) {
    window.Element.prototype.scrollIntoView = () => {};
  }
  return window;
}

export async function bootEditorEnv() {
  if (!_envPromise) {
    _envPromise = (async () => {
      const window = installGlobals();
      // Import AFTER globals exist: the vendor bundle reads DOM constructors
      // at module-evaluation time.
      const mod = await import('../../public/editor/index.js');
      const pipeline = await import('../../public/editor/markdown/pipeline.js');
      return { ...mod, pipeline, window };
    })();
  }
  return _envPromise;
}

// Round-trips a raw markdown string through the real editor and returns the
// serialized output. Callers assert byte equality themselves so failures
// show the exact drift.
export async function roundTrip(rawMarkdown) {
  const env = await bootEditorEnv();
  const element = env.window.document.createElement('div');
  env.window.document.body.appendChild(element);
  const { editor } = env.createEditor({ element, rawMarkdown });
  try {
    return env.getMarkdown(editor);
  } finally {
    env.destroyEditor(editor);
    element.remove();
  }
}
