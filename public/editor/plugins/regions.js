// Regions in the editor: an extension draws a fenced block where it sits.
//
// A WIDGET DECORATION, FOR THE REASON code-copy.js ALREADY GIVES. This editor
// round-trips markdown byte-exactly and its serialiser is documented as
// fragile: maths exists as verbatim atoms because LaTeX backslashes were
// found DOUBLING on every save. Decorations never become document content, so
// nothing here can affect what is written back. A NodeView would have to
// reimplement code-block rendering and would sit directly in the path this
// editor is most careful about.
//
// The same conclusion was reached independently by prosemirror-mermaid, which
// also injects rendered SVG beside the block rather than replacing it. Two
// arrivals at one answer from opposite directions is worth recording.
//
// WHAT IS NOT BORROWED FROM THOSE PACKAGES, AND WHY. tiptap-extension-mermaid
// and prosemirror-mermaid both render mermaid directly in the host page, with
// no sandbox: the library, and whatever a diagram's text talks it into, run
// with the app's own privileges. Rundock computes the drawing in an
// opaque-origin frame with no network and rebuilds what comes back from an
// allowlist, so this file asks the region service and injects the rebuilt
// tree. It gains the editor's re-render safety from the mechanism and keeps
// the boundary.
//
// One of them also stamps an auto-generated `data-id` on each node for
// persistence. Anything that reaches the document reaches the FILE, and a
// fence carrying an id is no longer a fence Obsidian understands. The whole
// point of drawing ` ```mermaid ` rather than inventing a format is that the
// note works in both, so an attribute is exactly the thing that cannot be
// borrowed.
//
// EDITING. The block stays where it is and stays editable. While the caret is
// inside it you see your text; move away and the drawing returns. That is
// Decide 24, and it is also what both packages settled on, because a diagram
// you cannot edit in place is a diagram you edit somewhere else.

import { Extension, Plugin, PluginKey, Decoration, DecorationSet } from '../../vendor/tiptap-bundle.mjs';

const regionsPluginKey = new PluginKey('rundock-regions');

// Long enough that typing a word does not queue a render per keystroke, short
// enough that pausing feels like it redrew immediately. The same figure both
// mermaid packages arrived at, which is weak evidence but not none.
const REDRAW_AFTER_MS = 300;

// What draws this language, or null. Read through the live registry every
// time rather than captured: an extension can be installed, disabled or
// uninstalled while a document is open, and the answer has to follow.
function drawerFor(language) {
  const registry = window.rundockRendererRegistry;
  if (!registry || typeof registry.drawerFor !== 'function') return null;
  // The open document's path, so a note in a hidden folder is never sent to
  // a region frame (see isHiddenPath in the registry). `currentFilePath` is
  // the page's own record of what the editor is showing; typeof keeps a
  // missing global from throwing in a test harness.
  const documentPath = typeof currentFilePath === 'string' ? currentFilePath : null; // eslint-disable-line no-undef
  // A document the server refused for extensions (a linked or hard-linked
  // file) has no drawer: its blocks are shown as the plain code they are.
  const refusalFor = window.rundockExtensionRefusalFor;
  if (documentPath != null && (typeof refusalFor !== 'function' || refusalFor(documentPath))) return null;
  return registry.drawerFor(String(language || '').toLowerCase(), documentPath);
}

function regionModules() {
  return {
    mount: window.RundockRegionMount,
    markup: window.RundockRegionMarkup,
    service: window.RundockRegionService,
  };
}

/**
 * The element a region decoration puts in the document.
 *
 * Built empty and filled in when the drawing arrives, so the block does not
 * jump when it does. contentEditable false throughout: this is chrome, and a
 * caret inside a drawing would be editing something that is not in the file.
 */
function buildRegionHolder() {
  const holder = document.createElement('div');
  holder.className = 'region editor-region';
  holder.contentEditable = 'false';
  holder.appendChild(buildSkeleton());
  return holder;
}

function buildSkeleton() {
  const skeleton = document.createElement('div');
  skeleton.className = 'region-skeleton';
  skeleton.setAttribute('aria-label', 'Drawing');
  return skeleton;
}

/**
 * Ask for a drawing and fill the holder with whatever comes back.
 *
 * Every outcome is visible. A region that quietly stays a skeleton is the
 * defect the plain rendering exists to prevent, so this ends in a drawing, a
 * reason, or nothing at all only when the holder has already been replaced by
 * a newer render of the same block.
 */
async function draw(holder, language, source, services, starts) {
  const { markup, service, mount } = regionModules();
  const extensionId = drawerFor(language);
  if (!markup || !service || !extensionId) return;

  // The token the holder carried when this draw began. A block edited twice
  // in quick succession has two draws in flight, and the older one must not
  // repaint over the newer.
  const token = holder.dataset.drawToken;

  let svc = services.get(extensionId);
  if (!svc) {
    // ONE START PER EXTENSION, EVEN WHEN THREE REGIONS ASK AT ONCE.
    //
    // Starting a service is asynchronous: it fetches the extension's payload
    // and imports the host module. Three regions in a document all reach this
    // in the same tick, all see an empty map because nothing has resolved
    // yet, and all three start one. Decide 22 exists to have ONE frame per
    // extension for the session precisely because mermaid is 2.83 MB, and
    // this quietly loaded it three times: three frames competing for the same
    // main thread, each slower than it should be, which is how a render that
    // takes well under a second reaches a ten second timeout and reports the
    // extension as not answering.
    //
    // The in-flight start is shared rather than the finished service, because
    // the gap being closed is the one before there is a service to share.
    let starting = starts.get(extensionId);
    if (!starting) {
      starting = startService(extensionId, service);
      starts.set(extensionId, starting);
    }
    const started = await starting;
    if (!started) {
      // Cleared so a later region can try again rather than inheriting this
      // answer for the rest of the session.
      starts.delete(extensionId);
      fail(holder, token, extensionId, null);
      return;
    }
    svc = services.get(extensionId) || started;
    services.set(extensionId, svc);
  }
  const answer = await svc.render(source);
  if (holder.dataset.drawToken !== token) return;
  if (!answer.ok) {
    // A service failure is the extension, not this block: say so plainly and
    // offer the retry, because rebuilding the frame is the thing that fixes it.
    const serviceFailed = !!answer.serviceFailed;
    fail(holder, token, extensionId, serviceFailed ? null : answer.reason,
      serviceFailed ? () => {
        holder.dataset.drawToken = String(Number(holder.dataset.drawToken || 0) + 1);
        replace(holder, buildSkeleton());
        draw(holder, language, source, services, starts);
      } : null);
    return;
  }
  const built = markup.buildRegionTree(answer.svg, document);
  if (!built.node) { fail(holder, token, extensionId, built.reason); return; }

  if (mount && typeof mount.attachInternalLinks === 'function') {
    // Resolved by the host, through the app's own opener, exactly as a
    // wikilink is. The convention is the counterpart's: a node carrying
    // `internal-link` opens the note its own text names.
    mount.attachInternalLinks(built.node, document, (target) => {
      if (typeof window.openWikilink === 'function') window.openWikilink(target);
    });
  }
  const drawn = document.createElement('div');
  drawn.className = 'region-drawn';
  // Back to the size the diagram was drawn at. Without this it arrives as
  // width="100%" with its real size in an inline style the allowlist drops,
  // and a 190-wide diagram fills the pane at 1454.
  if (mount && typeof mount.sizeToNatural === 'function') mount.sizeToNatural(built.node);
  drawn.appendChild(built.node);
  replace(holder, drawn);
  // A drawing taller than the reader is capped rather than left to push the
  // next paragraph off the screen. Measured after it is in the document,
  // because a diagram's height is whatever its content turned out to be, and
  // against the viewport rather than a fixed number so the rule means the
  // same thing on every screen.
  capIfTall(holder, drawn);
  const mark = document.createElement('span');
  mark.className = 'region-mark';
  mark.textContent = extensionId;
  mark.setAttribute('aria-label', `Drawn by ${extensionId}`);
  holder.appendChild(mark);
}

async function startService(extensionId, service) {
  try {
    const fetcher = window.rundockExtensionUiFetcher;
    if (typeof fetcher !== 'function') return null;
    const payload = await Promise.resolve(fetcher(extensionId, null));
    if (!payload || typeof payload.entry !== 'string') return null;
    const host = await import('/extension-host.js');
    return service.startRegionService({
      doc: document,
      win: window,
      // A function, so a theme change rebuilds the frame with the new tokens.
      srcdoc: () => host.buildRegionSrcdoc(payload, document),
      onUnusable: () => { /* each holder reports its own failure when it asks */ },
    });
  } catch (e) {
    return null;
  }
}

// The sentence comes from region-mount, so this surface and the preview say
// the same thing about the same failure. See failureText there.
function fail(holder, token, extensionId, reason, onRetry) {
  if (holder.dataset.drawToken !== token) return;
  const card = document.createElement('div');
  card.className = 'region-failed';
  const said = document.createElement('p');
  said.className = 'region-failed-reason';
  const mount = window.RundockRegionMount;
  said.textContent = mount && typeof mount.failureText === 'function'
    ? mount.failureText(extensionId, reason)
    : (reason || 'The extension is not loading');
  card.appendChild(said);
  // Offered only where it means something. A diagram that will not parse
  // fails the same way against the same bytes, and a button that does nothing
  // twice is worse than no button. There is no "Show the source" here the way
  // there is in the preview, because clicking the region already does that.
  if (typeof onRetry === 'function') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'region-failed-action';
    retry.textContent = 'Try again';
    retry.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onRetry(); });
    card.appendChild(retry);
  }
  replace(holder, card);
}

function capIfTall(holder, drawn) {
  const limit = (window.innerHeight || 800) * 1.5;
  const height = drawn.getBoundingClientRect ? drawn.getBoundingClientRect().height : 0;
  if (!height || height <= limit) return;
  holder.classList.add('region-capped');
  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'region-expand';
  expand.contentEditable = 'false';
  expand.textContent = 'View full size';
  expand.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Uncapping is the whole of it: the document scrolls through the drawing
    // as it would through any tall thing, rather than trapping it in a second
    // scroller nobody asked for.
    holder.classList.remove('region-capped');
    expand.remove();
  });
  holder.appendChild(expand);
}

function replace(holder, child) {
  while (holder.firstChild) holder.removeChild(holder.firstChild);
  holder.appendChild(child);
}

/**
 * One theme watcher for the whole module, and a registry of what to tell.
 *
 * NOT ONE PER PLUGIN INSTANCE, which is what this was first and why a theme
 * flip appeared to do nothing. The editor view is rebuilt often: opening a
 * file, toggling a mode, anything that recreates it. Each rebuild made a new
 * plugin instance with its own holders, its own services and its own
 * observer, and the instance whose observer happened to still be attached was
 * a spent one holding an empty map. It dutifully rethemed nothing, while the
 * instance actually showing the diagrams was never told the palette had
 * changed and kept drawing in the colours of the theme before it.
 *
 * So the watcher is attached once and outlives every instance, and instances
 * register and deregister. That also means two editors open at once both
 * redraw, which the per-instance version could never have managed.
 */
const holderState = new WeakMap();
let themeWatcher = null;

/**
 * ONE SERVICE PER EXTENSION, FOR THE SESSION. Decide 22, and it has to live at
 * module scope to mean that.
 *
 * These were per plugin instance, which quietly broke the decision they exist
 * to implement. The editor view is rebuilt on every file open, so a document
 * with mermaid in it loaded 2.83 MB again each time, and a region left on
 * screen from an earlier instance held a service whose frame had already been
 * torn down: asking it to redraw waited ten seconds and reported the
 * extension as not answering.
 *
 * At module scope there is exactly one frame per extension however many times
 * the editor is rebuilt, which is both what the decision says and the only
 * arrangement in which a drawing and the service that made it cannot drift
 * apart. They are stopped when the workspace goes, not when a view does.
 */
const services = new Map();
// Starts in flight, so N regions asking at once share one frame rather than
// each building its own.
const starts = new Map();

function stopRegionServices() {
  for (const svc of services.values()) {
    try { svc.stop(); } catch (e) { /* going away anyway */ }
  }
  services.clear();
  starts.clear();
}

/**
 * Redraw every region that is ON SCREEN, in the palette that is now true.
 *
 * KEYED OFF THE DOCUMENT, NOT OFF A PLUGIN INSTANCE, and that is the whole
 * point. This editor's view is rebuilt often, and every rebuild makes a fresh
 * plugin instance with its own holders and services. Both earlier attempts
 * tracked those instances: one observer per instance, then one observer and a
 * registry of instances. Both fired correctly and both redrew nothing,
 * because the instance still registered was not the instance whose diagrams
 * were on the page. The registry reported one live set holding zero holders
 * while three diagrams sat there in the wrong colours.
 *
 * The elements themselves are never ambiguous: what is in the document is
 * what the reader is looking at. So each holder carries what is needed to
 * redraw it, and a theme change asks the document rather than asking a
 * bookkeeping structure that has to be kept honest across a lifecycle nobody
 * owns.
 */
function rethemeVisibleRegions(root) {
  const holders = (root || document).querySelectorAll('.region.editor-region');
  const rethemed = new Set();
  for (const holder of holders) {
    const state = holderState.get(holder);
    if (!state || !state.language || state.source === null || state.source === undefined) continue;
    // Each service once, however many of its regions are on the page.
    const svc = services.get(drawerFor(state.language));
    if (svc && !rethemed.has(svc)) {
      rethemed.add(svc);
      try { svc.retheme(); } catch (e) { /* it rebuilds on next use */ }
    }
    // The old drawing stays up until the new one lands. A skeleton here would
    // flash every diagram in the document on a theme flip, which is worse
    // than a few hundred milliseconds of the previous palette.
    holder.dataset.drawToken = String(Number(holder.dataset.drawToken || 0) + 1);
    draw(holder, state.language, state.source, services, starts);
  }
}

// One watcher for the module, created on first use and never replaced. It
// outlives every plugin instance, which is the only lifetime that matches
// what it watches.
function watchTheme() {
  if (themeWatcher || typeof window.MutationObserver !== 'function' || !document.body) return;
  let shown = document.body.classList.contains('light') ? 'light' : 'dark';
  themeWatcher = new window.MutationObserver(() => {
    const now = document.body.classList.contains('light') ? 'light' : 'dark';
    if (now === shown) return;
    shown = now;
    rethemeVisibleRegions(document);
  });
  themeWatcher.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

/**
 * Clicking a drawing puts the caret in the block that produced it.
 *
 * WITHOUT THIS THERE IS NO WAY IN. The drawing is a widget that is
 * contentEditable false and returns true from stopEvent, which is what keeps
 * it out of the document and out of the editor's event handling. It also
 * makes it inert: a click lands on nothing, the browser cannot place a caret
 * inside a contentEditable false element, and the source it is standing in
 * front of is display none. So click-to-source has no click, and the only way
 * to reach a diagram's text is to arrow into it from the paragraph beside it,
 * which nobody will guess.
 *
 * Hiding the source is what makes the drawing feel native; this is the half
 * that makes it feel editable. It is the same gesture Obsidian's Live Preview
 * uses, so a note behaves the same way in both.
 *
 * TipTap's own setTextSelection rather than a ProseMirror TextSelection: the
 * vendored bundle does not export the selection classes, and reaching around
 * a public command to build one by hand would be inventing a private API to
 * avoid using the one that is already there.
 */
function wireClickToEdit(entry, editor, getPos) {
  // THE LISTENER IS WIRED ONCE; THE POSITION IS REFRESHED EVERY TIME.
  //
  // getPos belongs to the decoration that supplied it, and decorations are
  // rebuilt constantly: every selection change makes a new set. Capturing it
  // in the listener's closure meant each region kept the getPos from the
  // first decoration it ever had. Clicking one region rebuilds the set, and
  // from then on every OTHER region is holding a getPos whose decoration no
  // longer exists. It returns nothing, the guard below bails, and the click
  // does nothing at all: the first diagram clicked is editable and the rest
  // quietly stop responding, which is exactly as confusing as it sounds.
  //
  // So the current one is kept on the entry, which outlives the decorations,
  // and the listener reads it at click time instead of closing over it.
  entry.getPos = getPos;
  // Attached once even so: wiring per decoration would stack a listener on
  // every region for every keystroke typed in the paragraph beside it.
  if (entry.wiredClick) return;
  entry.wiredClick = true;
  entry.holder.addEventListener('mousedown', (event) => {
    // A link inside a diagram navigates, and the control that uncaps a tall
    // one uncaps it. Neither is a request to edit the text, and swallowing
    // them here would make the two things this region already does stop
    // working the moment it became editable.
    if (event.target && typeof event.target.closest === 'function') {
      if (event.target.closest('.region-link') || event.target.closest('.region-expand')) return;
    }
    if (!editor || !editor.view) return;
    // THE BLOCK IS FOUND THROUGH THE DOM, for the reason the theme watcher
    // reads the document too: anything scoped to a decoration or a plugin
    // instance goes stale here, and does it silently.
    //
    // The widget is inserted at side -1, so it is the element immediately
    // before the block it draws. posAtDOM turns that element back into a
    // position, and unlike getPos it is answered by the CURRENT view rather
    // than by whichever decoration happened to supply the closure first.
    // getPos is kept as a fallback, and entry.pos behind it.
    let at;
    const pre = entry.holder.nextElementSibling;
    if (pre && pre.tagName === 'PRE') {
      try { at = editor.view.posAtDOM(pre, 0); } catch (e) { /* fall through */ }
    }
    if (typeof at !== 'number' && typeof entry.getPos === 'function') {
      const from = entry.getPos();
      // getPos returns the block's own position, so the caret needs to go one
      // inside it: selecting at the block puts it in the paragraph above,
      // which looks exactly like the click did nothing.
      if (typeof from === 'number') at = from + 1;
    }
    if (typeof at !== 'number' && typeof entry.pos === 'number') at = entry.pos + 1;
    if (typeof at !== 'number') return;
    event.preventDefault();
    editor.chain().focus().setTextSelection(at).run();
  });
}

/**
 * One decoration per claimed block: the drawing, and a class on the block.
 *
 * The block keeps its place and its content. It is hidden by a class while a
 * drawing stands in front of it, and shown again when the caret is inside it,
 * which is the whole of Decide 24 and needs no document change to express.
 */
function buildDecorations(doc, selection, holders, services, starts, editor) {
  const decorations = [];
  const focused = !!(editor && editor.isFocused);
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return false;
    const language = node.attrs && node.attrs.language;
    if (!drawerFor(language)) return false;

    const source = node.textContent;
    // The caret is inside this block AND the editor has focus: the author is
    // editing it, so the source is what they need to see.
    //
    // THE FOCUS HALF IS NOT BELT AND BRACES. An editor with no focus still has
    // a selection, and on load that selection sits at the end of the document.
    // A note whose last line is a fenced block therefore opens with the caret
    // inside it, and the last diagram in the file is source every time,
    // looking for all the world like the one block that failed to draw. It is
    // the most likely shape for a note to have, because a document that ends
    // with a diagram is a perfectly ordinary document.
    //
    // Nobody is editing anything when the editor is not focused, so nothing
    // shows source. The moment focus arrives the real selection applies.
    const editing = focused && selection && selection.from >= pos && selection.to <= pos + node.nodeSize;

    // One holder per position, reused across rebuilds. Rebuilding the element
    // every transaction would restart the drawing on every keystroke and make
    // the region flicker while somebody types beside it.
    let entry = holders.get(pos);
    if (!entry) { entry = { holder: buildRegionHolder(), source: null, timer: null }; holders.set(pos, entry); }

    // Kept current so a click can still find its block if the decoration
    // that supplied getPos has since been replaced.
    entry.pos = pos;
    // Everything a theme change needs to redraw this region, on the element
    // that will still be on the page when it happens.
    holderState.set(entry.holder, { language, source });
    if (entry.source !== source) {
      entry.source = source;
      // Kept so a theme change can redraw this block without a transaction.
      entry.language = language;
      // The token is bumped now rather than when the draw starts, so an
      // answer for text that has since changed is discarded on arrival.
      entry.holder.dataset.drawToken = String(Number(entry.holder.dataset.drawToken || 0) + 1);
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      if (!entry.drawnOnce) {
        // THE FIRST PAINT IS NOT DEBOUNCED. Debouncing exists so that typing a
        // word queues one draw instead of one per keystroke; opening a
        // document is not typing, and making somebody wait 300ms to see a
        // diagram that is not changing buys nothing. It also means the first
        // draw cannot be lost by a rebuild that arrives inside the window,
        // which is precisely what happened when this was debounced from cold.
        entry.drawnOnce = true;
        draw(entry.holder, language, source, services, starts);
      } else {
        entry.timer = setTimeout(() => {
          entry.timer = null;
          draw(entry.holder, language, source, services, starts);
        }, REDRAW_AFTER_MS);
      }
    }

    if (!editing) {
      decorations.push(Decoration.widget(pos, (view, getPos) => {
        wireClickToEdit(entry, editor, getPos);
        return entry.holder;
      }, {
        // Before the block, so the drawing reads as standing in for it.
        side: -1,
        // Chrome, not content: never part of a selection, never copied.
        ignoreSelection: true,
        stopEvent: () => true,
      }));
    }
    decorations.push(Decoration.node(pos, pos + node.nodeSize, {
      class: editing ? 'region-source-open' : 'region-source-hidden',
    }));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function regionsPlugin(editor) {
  // Services and starts are module-level: see the note on them for why the
  // life of an editor view is the wrong lifetime for a session-long frame.
  const holders = new Map();
  return new Plugin({
    key: regionsPluginKey,
    state: {
      init(_, { doc, selection }) { return buildDecorations(doc, selection, holders, services, starts, editor); },
      apply(tr, old, oldState, newState) {
        // Rebuilt on selection changes too, unlike code-copy: moving the caret
        // into a block is what shows its source, so selection IS the state
        // this renders from. And on focus, which changes what is drawn without
        // changing the document or the selection, so it arrives as a meta
        // rather than as either.
        const refocused = tr.getMeta(regionsPluginKey) === 'focus-changed';
        if (!refocused && !tr.docChanged && tr.selection.eq(oldState.selection)) return old;
        if (tr.docChanged) {
          // Positions move when the document does; a holder keyed by an old
          // position would be orphaned and its drawing lost.
          const moved = new Map();
          for (const [pos, entry] of holders) moved.set(tr.mapping.map(pos), entry);
          holders.clear();
          for (const [pos, entry] of moved) holders.set(pos, entry);
        }
        return buildDecorations(newState.doc, newState.selection, holders, services, starts, editor);
      },
    },
    props: {
      decorations(state) { return this.getState(state); },
    },
    view(view) {
      // Focus and blur are DOM events, not transactions, so the decorations
      // would otherwise keep whatever focus state they were last built with:
      // the drawing would not come back when the editor was clicked away from,
      // and the source would not appear when it was clicked into.
      const refresh = () => {
        try { view.dispatch(view.state.tr.setMeta(regionsPluginKey, 'focus-changed')); } catch (e) { /* view is going */ }
      };
      if (editor && typeof editor.on === 'function') {
        editor.on('focus', refresh);
        editor.on('blur', refresh);
      }

      // The palette changed, so every drawing made in the old one is wrong.
      // Nothing is registered here: the watcher reads the document. See
      // rethemeVisibleRegions for why that is the only thing that holds.
      watchTheme();

      return {
        destroy() {
          if (editor && typeof editor.off === 'function') {
            editor.off('focus', refresh);
            editor.off('blur', refresh);
          }
          for (const entry of holders.values()) if (entry.timer) clearTimeout(entry.timer);
          holders.clear();
          // The services are deliberately NOT stopped. This view is going
          // away and another is very likely about to replace it, on the same
          // workspace, wanting the same 2.83 MB frame that is already warm.
          // They are the session's, and stopRegionServices ends them when the
          // session's workspace does.
        },
      };
    },
  });
}

const RegionsExtension = Extension.create({
  name: 'rundockRegions',
  addProseMirrorPlugins() { return [regionsPlugin(this.editor)]; },
});

export {
  regionsPluginKey, REDRAW_AFTER_MS, drawerFor, regionModules, buildRegionHolder, draw, wireClickToEdit, rethemeVisibleRegions, watchTheme, holderState, services, starts, stopRegionServices,
  buildDecorations, regionsPlugin, RegionsExtension,
};
