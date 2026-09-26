'use strict';
/**
 * Turn the fenced blocks a rendered document already contains into drawn
 * regions, and put them back when asked.
 *
 * A PASS OVER THE RENDERED DOM, NOT A CHANGE TO THE RENDERER. A fenced block
 * arrives here as the markdown renderer's own output: a wrapper carrying the
 * language and a <code> element carrying the source as text. So the renderer
 * keeps escaping everything, exactly as it decided to, the document's bytes
 * are never touched, and a note with three diagrams round-trips byte for byte
 * whether or not anything is installed to draw them. The region is a
 * presentation of the block, and the block is still there underneath.
 *
 * WHAT IS BUILT IS NEVER WHAT WAS RETURNED. The service hands back markup;
 * region-markup.js builds a fresh tree out of the parts it understands and
 * this file appends that. No string from an extension is ever assigned to
 * innerHTML here or anywhere downstream of here.
 *
 * FAILURE HAS TWO RADII (Decide 29). A block that will not parse fails alone,
 * in its own place, with the other regions and all the prose around it
 * untouched, because they are separate nodes that never depended on it. A
 * service that cannot run takes its own regions with it, and the card it
 * leaves offers the restart that makes a session-long frame recoverable.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else root.RundockRegionMount = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const WRAPPER = 'code-block-wrapper';
  const LANG = 'code-lang';

  /**
   * The blocks in a rendered document that something has claimed.
   *
   * @param {Element} scope the rendered document
   * @param {(lang: string) => boolean} claims
   * @returns {{wrapper: Element, language: string, source: string}[]}
   *
   * The source is read as TEXT, from the code element, which is the one
   * reading that gives back what the author wrote rather than what the
   * renderer escaped: `A --> B` and not `A --&gt; B`. Getting this wrong is
   * invisible until a diagram contains an ampersand.
   */
  function claimedBlocks(scope, claims) {
    const found = [];
    for (const wrapper of scope.querySelectorAll('.' + WRAPPER)) {
      const label = wrapper.querySelector('.' + LANG);
      const code = wrapper.querySelector('pre code');
      if (!label || !code) continue;
      const language = String(label.textContent || '').trim().toLowerCase();
      if (!language || !claims(language)) continue;
      found.push({ wrapper, language, source: code.textContent });
    }
    return found;
  }

  /**
   * Put a region where a block is, in the state it is in now.
   *
   * The block is not removed. It is hidden beside the region, so that
   * click-to-source is a toggle of two nodes that both already exist rather
   * than a re-render, and so that nothing is lost if a draw never arrives.
   */
  function placeRegion(block, doc) {
    const { wrapper } = block;
    const region = doc.createElement('div');
    region.className = 'region';
    region.setAttribute('data-region-language', block.language);
    wrapper.parentNode.insertBefore(region, wrapper);
    wrapper.hidden = true;
    return {
      region,
      wrapper,
      // Show the source instead of the drawing, and the other way round.
      // Two nodes, one hidden: the source a person edits is the block the
      // document actually contains, which is what makes the edit real.
      showSource() { region.hidden = true; wrapper.hidden = false; },
      showRegion() { wrapper.hidden = true; region.hidden = false; },
      // Put the document back exactly as it was handed over, which a
      // caller needs when an extension is disabled or a document closes.
      release() {
        wrapper.hidden = false;
        if (region.parentNode) region.parentNode.removeChild(region);
      },
    };
  }

  // The state of one region, rendered. Each replaces the last: a region is
  // never two of these at once, and every one of them is visible, because a
  // region that is silently nothing is the defect the plain rendering exists
  // to prevent.
  function drawWaiting(placed, doc) {
    const skeleton = doc.createElement('div');
    skeleton.className = 'region-skeleton';
    skeleton.setAttribute('aria-label', 'Drawing');
    replace(placed.region, skeleton);
  }

  function drawResult(placed, tree, doc) {
    const holder = doc.createElement('div');
    holder.className = 'region-drawn';
    sizeToNatural(tree);
    holder.appendChild(tree);
    replace(placed.region, holder);
  }

  /**
   * A region that could not be drawn says so where it would have been, and
   * offers the way back to the thing that is actually in the document.
   *
   * `onRetry` is given only where retrying means something: a service-level
   * failure, where the whole frame is rebuilt. A syntax error retried against
   * the same bytes fails the same way, and a button that does nothing twice
   * is worse than no button.
   */
  /**
   * What a reader is told when a region cannot be drawn.
   *
   * TWO FAILURES, TWO SENTENCES. An extension that will not load is the
   * product's problem and there is nothing in the document to fix, so it is
   * named plainly and offers the one thing that might help. A diagram that
   * will not parse is the author's to fix, and the drawer's own message names
   * the line, so it is passed through: replacing it with something friendlier
   * would send somebody back to a diagram with no idea which part of it to
   * look at.
   *
   * Nothing here says "10000ms". A duration is a fact about the
   * implementation, and a reader told one learns nothing they can act on.
   *
   * HERE RATHER THAN IN EITHER CALLER, because there are two surfaces that
   * draw regions and one failure. Written in the editor alone, the preview
   * went on reporting the same timeout in the old words, and which sentence a
   * reader saw depended on which surface they happened to be looking at.
   */
  function failureText(extensionId, reason) {
    if (!reason) return `${displayName(extensionId)} is not loading`;
    return reason;
  }

  // "mermaid" is how an extension is addressed; "Mermaid" is how it is spoken
  // about. Only the first letter, because the rest of the name is the author's
  // and title-casing it would rename something like "gantt-pro" for them.
  function displayName(extensionId) {
    const id = String(extensionId || '').trim();
    if (!id) return 'The extension';
    return id.charAt(0).toUpperCase() + id.slice(1);
  }

  function drawFailure(placed, reason, doc, onRetry) {
    const card = doc.createElement('div');
    card.className = 'region-failed';
    const said = doc.createElement('p');
    said.className = 'region-failed-reason';
    said.textContent = reason;
    card.appendChild(said);
    const source = doc.createElement('button');
    source.type = 'button';
    source.className = 'region-failed-action';
    source.textContent = 'Show the source';
    source.addEventListener('click', () => placed.showSource());
    card.appendChild(source);
    if (typeof onRetry === 'function') {
      const retry = doc.createElement('button');
      retry.type = 'button';
      retry.className = 'region-failed-action';
      retry.textContent = 'Try again';
      retry.addEventListener('click', onRetry);
      card.appendChild(retry);
    }
    replace(placed.region, card);
  }

  function replace(region, child) {
    while (region.firstChild) region.removeChild(region.firstChild);
    region.appendChild(child);
  }

  /**
   * Give a rebuilt drawing back its natural size.
   *
   * THIS IS A CONSEQUENCE OF THE REBUILD, AND HAS TO BE. A drawing generally
   * arrives as `width="100%"` with its real size carried in an inline
   * `style="max-width: 190px"`, and `style` is not on the allowlist: it is a
   * whole second language to validate, and letting it through would undo most
   * of what building from an allowlist buys. So the constraint is dropped and
   * the stretch is kept, and a diagram whose natural size is 190 by 405
   * renders at 1454 by 3098, filling a screen and a half.
   *
   * The viewBox is on the allowlist, carries exactly the same information,
   * and is not a language. So the size comes from there: width and height
   * attributes, which the stylesheet then holds to the pane with max-width.
   * A drawing with no viewBox is left alone rather than guessed at.
   */
  function sizeToNatural(tree) {
    if (!tree || typeof tree.getAttribute !== 'function') return null;
    const box = String(tree.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) return null;
    const width = box[2];
    const height = box[3];
    if (!(width > 0) || !(height > 0)) return null;
    tree.setAttribute('width', String(Math.round(width)));
    tree.setAttribute('height', String(Math.round(height)));
    return { width, height };
  }

  /**
   * Make the links inside a drawing work, in the app the reader clicked in.
   *
   * THE HOST RESOLVES, ALWAYS (Decide 28). The frame returned inert markup
   * and has no viewport to attach a handler to, so this is forced rather than
   * chosen: only the host can do it, and only because the drawing is now in
   * the host's own document.
   *
   * THE CONVENTION IS THE COUNTERPART'S, NOT OURS. A node is a link when it
   * carries the `internal-link` class, and its destination is its own text.
   * That is how the same file behaves in Obsidian, and the whole point is
   * that one document works in both: a wikilink written inside a fence would
   * render as literal brackets there, so matching the class is what makes the
   * file portable rather than what makes it convenient here.
   *
   * The class survives the rebuild because `class` is on the allowlist. The
   * handler is attached to a node the host built, never to returned markup.
   */
  function attachInternalLinks(tree, doc, onOpen) {
    if (!tree || typeof onOpen !== 'function') return 0;
    let wired = 0;
    for (const node of tree.querySelectorAll('.internal-link')) {
      // The destination is the node's own text, exactly as the counterpart
      // reads it. Trimmed, because a diagram's label carries the whitespace
      // its author laid out with.
      const target = String(node.textContent || '').trim();
      if (!target) continue;
      node.classList.add('region-link');
      node.setAttribute('role', 'link');
      node.setAttribute('tabindex', '0');
      node.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen(target);
      });
      node.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen(target);
      });
      wired += 1;
    }
    return wired;
  }

  /**
   * The quiet mark that says a region is somebody else's work (Decide 27).
   *
   * Provenance, not permission: it answers "why does this look different"
   * and does not ask for anything. Shown on hover rather than always, because
   * a document with three diagrams would otherwise carry three permanent
   * badges, which is the noise that ruling exists to avoid.
   */
  function markProvenance(placed, extensionName, doc) {
    const mark = doc.createElement('span');
    mark.className = 'region-mark';
    mark.textContent = extensionName;
    mark.setAttribute('aria-label', `Drawn by ${extensionName}`);
    placed.region.appendChild(mark);
    return mark;
  }

  /**
   * A diagram taller than the reader (Decide 26).
   *
   * Capped with a fade and a way to see it whole, matching how a tall
   * embedded image already behaves rather than inventing a pattern. The cap
   * is a class, not a measurement, so the height lives in the stylesheet
   * where every other dimension in this product lives.
   */
  function capTallRegion(placed, doc, onExpand) {
    placed.region.classList.add('region-capped');
    const expand = doc.createElement('button');
    expand.type = 'button';
    expand.className = 'region-expand';
    expand.textContent = 'View full size';
    expand.addEventListener('click', () => onExpand(placed));
    placed.region.appendChild(expand);
    return expand;
  }

  return {
    claimedBlocks, placeRegion, drawWaiting, drawResult, drawFailure,
    attachInternalLinks, markProvenance, capTallRegion, sizeToNatural, failureText, displayName, WRAPPER, LANG,
  };
}));
