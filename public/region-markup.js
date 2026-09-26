'use strict';
/**
 * What a region extension returns, rebuilt into something safe to put in
 * Rundock's own page.
 *
 * THE HOST DRAWS, THE EXTENSION COMPUTES. A region extension runs headless
 * and hands back markup; the host puts the result in its own document, where
 * it can be selected, copied, found by the page's own search, and reflowed
 * with the prose around it. That is the whole reason the frame stopped being
 * a window and became a calculator, and it is recorded in
 * Decisions/What-Crosses-The-Extension-Frame-Boundary.md.
 *
 * IT IS REBUILT, NOT CLEANED, AND THAT IS THE DECISION THIS FILE EXISTS FOR.
 * markdown-render.js already ruled against sanitisers in this app, on grounds
 * that still hold: an allowlist to maintain and a mutation-XSS literature to
 * track, with no build step to carry a vendored bundle. It left one door
 * open, that a construct earning its place gets a tokenizer on the same terms
 * as callouts and wikilinks. This is that tokenizer, for SVG.
 *
 * So nothing here removes anything. A fresh tree is built out of the parts
 * that are understood, and every part that is not understood is simply never
 * built. Strip-then-reserialise is the exact shape mutation-XSS exploits,
 * because the parse that writes the output need not have seen what the parse
 * that cleaned it saw. There is no second parse here to disagree with the
 * first, and no string of untrusted markup is ever assigned to innerHTML.
 *
 * The failure modes are deliberately asymmetric. Forgetting to allow
 * something makes a diagram render wrong, visibly, and somebody reports it.
 * Forgetting to remove something would make a page unsafe, quietly. This
 * file can only make the first kind of mistake.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else root.RundockRegionMarkup = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // The elements a diagram is made of. No <script>, no <foreignObject>, no
  // <image>, no <use>, and their absence is not a removal: they are not here,
  // so they are never built. foreignObject is the sharpest of those, because
  // it is the documented way to put arbitrary HTML inside an SVG and would
  // reopen everything markdown-render.js closed by escaping.
  const ELEMENTS = new Set([
    'svg', 'g', 'defs', 'title', 'desc', 'style',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'textPath',
    'marker', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'pattern',
  ]);

  // Attributes, by name, for every element that may carry them. Presentation
  // and geometry only. Notably absent and deliberately so: href and xlink:href
  // in every form, which is how an external reference would get in; and
  // anything beginning with `on`, which is not enumerated as a special case
  // because an allowlist has no need to name what it does not contain.
  const ATTRIBUTES = new Set([
    'id', 'class', 'transform', 'viewBox', 'width', 'height', 'x', 'y', 'dx', 'dy',
    'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
    'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
    'opacity', 'color', 'display', 'visibility', 'overflow',
    'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
    'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'white-space',
    'marker-end', 'marker-start', 'marker-mid', 'orient', 'refX', 'refY',
    'markerWidth', 'markerHeight', 'markerUnits', 'gradientUnits', 'offset',
    'stop-color', 'stop-opacity', 'clip-path', 'preserveAspectRatio',
    'patternUnits', 'spreadMethod', 'xmlns',
  ]);

  // A value that reaches back out of the document. url(#local) is how a
  // marker or a gradient is referenced and is the whole reason these
  // attributes exist; url(http...) or a data: payload in the same position is
  // a fetch, and the frame's own policy forbids those for the frame but says
  // nothing about the host's page, which is where this markup is going.
  function valueIsLocal(value) {
    const text = String(value);
    if (!/url\(/i.test(text)) return true;
    return [...text.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)]
      .every((m) => m[2].startsWith('#'));
  }

  /**
   * Build a safe tree from what a region extension returned.
   *
   * @param {string} markup what the frame sent back
   * @param {Document} doc the host document to build in
   * @returns {{node: Element|null, reason: string|null}}
   *
   * The parse is the browser's own XML parse, which builds a tree and runs
   * nothing: a script element in the input becomes a node nobody executes,
   * and then is not copied because it is not in ELEMENTS. The output is
   * built node by node in the SVG namespace, so nothing carries a namespace
   * the input asked for.
   */
  function buildRegionTree(markup, doc) {
    const text = typeof markup === 'string' ? markup.trim() : '';
    if (!text) return { node: null, reason: 'the extension returned nothing to draw' };
    let parsed;
    try {
      parsed = new doc.defaultView.DOMParser().parseFromString(text, 'image/svg+xml');
    } catch (e) {
      return { node: null, reason: 'the extension returned markup that could not be read' };
    }
    // A parse error is reported as a document containing parsererror rather
    // than by throwing, which is the one case where reading the input's own
    // element names is the right thing to do.
    if (parsed.getElementsByTagName('parsererror').length) {
      return { node: null, reason: 'the extension returned markup that could not be read' };
    }
    const source = parsed.documentElement;
    if (!source || source.localName !== 'svg') {
      return { node: null, reason: 'the extension returned something that is not a drawing' };
    }
    return { node: copy(source, doc), reason: null };
  }

  // One node, and then its children. Returns null for anything not
  // understood, and a parent simply does not append a null.
  function copy(source, doc) {
    if (!ELEMENTS.has(source.localName)) return null;
    const built = doc.createElementNS(SVG_NS, source.localName);
    for (const attr of [...source.attributes]) {
      // MATCHED ON THE QUALIFIED NAME, WHICH IS WHAT MAKES A PREFIX
      // UNREACHABLE. A prefixed attribute's `name` carries its prefix, so
      // `xlink:href` is the string tested and no prefixed attribute can ever
      // equal an entry in this list. Reading `localName` here instead would
      // silently make every xlink attribute reachable under its bare name,
      // which is the one way back in this file has to worry about.
      //
      // A separate `if (attr.namespaceURI) continue;` stood here and was
      // removed on 2026-09-21 after its own harness row proved it inert:
      // nothing turned red when it went, because the line below had already
      // done the work. It was deleted rather than kept as reassurance, and
      // the row was rewritten to mutate THIS line, so the property is now
      // guarded where it actually lives.
      if (!ATTRIBUTES.has(attr.name)) continue;
      if (!valueIsLocal(attr.value)) continue;
      built.setAttribute(attr.name, attr.value);
    }
    for (const child of [...source.childNodes]) {
      if (child.nodeType === 3) { built.appendChild(doc.createTextNode(child.nodeValue)); continue; }
      if (child.nodeType !== 1) continue; // comments and the rest are not copied
      const kid = copy(child, doc);
      if (kid) built.appendChild(kid);
    }
    return built;
  }

  return { SVG_NS, ELEMENTS, ATTRIBUTES, valueIsLocal, buildRegionTree };
}));
