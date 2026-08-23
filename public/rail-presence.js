'use strict';
/**
 * Progressive disclosure for the nav rail: a section appears with the first
 * thing it holds, and not before.
 *
 * WHY THIS IS A MODULE AND NOT TWO COPIES OF FOUR LINES. The Skills rail has
 * gated itself on "are there any skills" since it shipped, inside its own
 * render. The routines rail needs exactly the same rule, and the obvious way
 * to give it one is to write the same query and the same style assignment
 * again in another view. Two copies of a rule drift: one gets a class instead
 * of a style, one forgets that a hidden entry has to come BACK, and the rail
 * ends up behaving differently depending on which section you emptied. So the
 * rule lives here once and both views call it.
 *
 * IT DOES ONE THING. It decides whether a rail entry is on the page. What a
 * view renders when its section is empty is the view's own business: Skills
 * renders nothing, Routines renders an empty state that says what to do next,
 * and neither of those decisions belongs in a shared helper.
 *
 * A shell with no rail to gate reports the section present, so a view rendered
 * into a page without a nav rail behaves as it did before this existed.
 */
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockRailPresence = factory();
    Object.assign(root, root.RundockRailPresence);
  }
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Show or withdraw a rail entry.
   *
   * @param {string} nav the section's data-nav value
   * @param {boolean} present whether the section holds anything
   * @returns {boolean} whether the section is on the rail afterwards
   */
  function railPresence(nav, present) {
    const entry = document.querySelector(`.nav-item[data-nav="${nav}"]`);
    if (!entry) return true;
    entry.style.display = present ? '' : 'none';
    return present;
  }

  return { railPresence };
}));
