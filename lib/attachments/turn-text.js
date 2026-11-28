'use strict';
// The text of a person's turn as a session file keeps it. A turn sent as
// text is its string. A turn sent with images or PDFs is an array: its text
// blocks, then a block for each file, and its text is those text blocks
// joined. A block's data is never part of the text. Any other array, one of
// text alone or one holding a tool result, is not a turn the person sent.

const ATTACHED = new Set(['image', 'document']);

/** A user line's content as the person's text, or null when it is not theirs. */
function userTurnText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  let attached = false;
  for (const block of content) {
    const type = block && typeof block === 'object' ? block.type : undefined;
    if (type === 'tool_result') return null;
    if (ATTACHED.has(type)) attached = true;
  }
  if (!attached) return null;
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
}

module.exports = { userTurnText };
