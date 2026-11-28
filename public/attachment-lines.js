'use strict';
// THE ATTACHED-FILE LINES IN A MESSAGE'S TEXT. The server writes a line for
// each file a person attaches (lib/attachments/receive.js storedText), and
// writes one of two forms in its place when the file is no longer as it was
// sent (lib/attachments/turn.js). The page draws each line as the file's
// chip, and the history says which of the files it names are there. One
// function finds them for both, so the two can never disagree about which
// lines are files. Same UMD pattern as attachment-wording.js.
//
// A LINE IS FOUND ONLY WHEN IT IS THE WHOLE LINE. Anything near one of the
// three forms (inside a sentence, with text after it, an id or name the
// store would never write, details holding a bracket or a break) stays text,
// so a person who quotes a line in passing sees what they typed.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockAttachmentLines = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // Copies of lib/attachments/store.js's patterns, which the page can't
  // require. A test holds them equal.
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
  const STORED_NAME = /^[1-9][0-9]{0,8}-[A-Za-z0-9_-]{1,60}\.(png|jpg|gif|webp|pdf|txt|md|csv)$/;

  const body = (pattern) => pattern.source.slice(1, -1);
  const whole = (core) => new RegExp(`^${core}$`);
  const NAME = `(${body(STORED_NAME)})`;
  // STORED_NAME holds a group of its own (the extension), so the attached
  // form's groups are the id, the name and then the extension.
  const ATTACHED = whole(`\\[Attached: \\.rundock/attachments/(${body(ID_PATTERN)})/${NAME} \\([^)\\]\\r\\n\\u2028\\u2029]*\\)\\]`);
  const NOT_AVAILABLE = whole(`\\[Attached file not available: ${NAME}\\]`);
  const CHANGED = whole(`\\[Attached file changed since it was attached, so it isn't shown: ${NAME}\\]`);

  function lineFile(line) {
    let found = ATTACHED.exec(line);
    if (found) return { kind: 'attached', id: found[1], file: found[2] };
    found = NOT_AVAILABLE.exec(line);
    if (found) return { kind: 'not-available', file: found[1] };
    found = CHANGED.exec(line);
    if (found) return { kind: 'changed', file: found[1] };
    return null;
  }

  // `{ text, files }`: the text with each found line taken out together with
  // one line break beside it (the one before it, or the one after it for a
  // first line), and the found lines in order, a repeated one each time.
  // Reading the lines in order and joining the kept ones does exactly that.
  function splitAttachmentLines(text) {
    if (typeof text !== 'string') return { text, files: [] };
    const files = [];
    let kept = '';
    let first = true;
    for (const line of text.split('\n')) {
      const file = lineFile(line);
      if (file) { files.push(file); continue; }
      kept += (first ? '' : '\n') + line;
      first = false;
    }
    return { text: kept, files };
  }

  return { splitAttachmentLines, ID_PATTERN, STORED_NAME };
}));
