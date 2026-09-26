'use strict';
// The one rule for what a package may call itself (rundock.json's optional
// `displayName`): plain text, trimmed, at most DISPLAY_NAME_MAX characters,
// with no markup, no line break and no control character. A leaf module, so
// the manifest reader, the receipt writer and every reader of either can
// hold a name to the same rule without depending on one another.

const DISPLAY_NAME_MAX = 60;

function isDisplayName(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= DISPLAY_NAME_MAX
    && !/[<>\x00-\x1f\x7f]/.test(value);
}

module.exports = { isDisplayName, DISPLAY_NAME_MAX };
