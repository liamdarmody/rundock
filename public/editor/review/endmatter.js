// YAML endmatter: the file-native store for review metadata (Roughdraft wire
// format). A final `---` line introduces a YAML block that runs to the end
// of the file:
//
//   ---
//   comments:
//     c1: { body?, by, at, re?, resolved? }
//   suggestions:
//     s1: { by, at, verdict? }
//   review:
//     status: in-review | done
//     at: <ISO timestamp>
//     verdicts: <compact summary written by Done-Reviewing>
//
// Only blocks whose top-level keys are all review keys count as endmatter;
// a closing thematic break or any other trailing YAML-ish text stays body.
// The block is stripped before markdown parsing and re-emitted verbatim on
// save unless review data actually changed (byte-for-byte otherwise).
//
// DOM-free: imported by Node tests directly. js-yaml comes from the vendor
// bundle, which imports cleanly without a DOM.

import { yaml } from '../../vendor/tiptap-bundle.mjs';

const REVIEW_KEYS = new Set(['comments', 'suggestions', 'review']);

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Minimal CommonMark fence tracker: is the end of `text` inside an open
// fenced code block? Openers/closers may be indented up to three spaces;
// a closer must use the opener's marker character, be at least as long,
// and carry no info string. Lines inside an open fence never open or close
// anything else.
function insideUnclosedFence(text) {
  let open = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/);
    if (!m) continue;
    const marker = m[1][0];
    const length = m[1].length;
    const rest = m[2];
    if (!open) {
      open = { marker, length };
    } else if (marker === open.marker && length >= open.length && rest.trim() === '') {
      open = null;
    }
  }
  return open !== null;
}

export function hasReviewData(data) {
  if (!isPlainObject(data)) return false;
  return ['comments', 'suggestions', 'review'].some(
    (k) => isPlainObject(data[k]) && Object.keys(data[k]).length > 0
  );
}

// extractEndmatter(text) -> { body, raw, data }
//   body: text with the endmatter removed (body + raw === text, byte-exact)
//   raw:  the endmatter block including its introducing '---' line, or ''
//   data: the parsed YAML object, or null
export function extractEndmatter(text) {
  const none = { body: text, raw: '', data: null };
  if (typeof text !== 'string' || !text) return none;

  // The introducing '---' must sit at the start of a line. Find the LAST
  // candidate so review blocks after horizontal rules still resolve.
  let idx = -1;
  if (text.startsWith('---\n')) idx = 0;
  const fromNewline = text.lastIndexOf('\n---\n');
  if (fromNewline !== -1) idx = fromNewline + 1;
  if (idx === -1) return none;

  // A '---' inside an unclosed code fence is fence content, not endmatter.
  // Fences pair by marker character and length (a fence closes only on the
  // same character, at least the opening length, with nothing after it),
  // and may be indented up to three spaces — parity counting cannot model
  // that (a 4-backtick fence documenting ``` lines would miscount).
  if (insideUnclosedFence(text.slice(0, idx))) return none;

  const raw = text.slice(idx);
  const yamlText = raw.slice(4); // past '---\n'
  let data = null;
  try {
    data = yaml.load(yamlText);
  } catch {
    return none;
  }
  if (!isPlainObject(data)) return none;
  const keys = Object.keys(data);
  if (!keys.length || !keys.every((k) => REVIEW_KEYS.has(k))) return none;
  if (!hasReviewData(data)) return none;

  return { body: text.slice(0, idx), raw, data };
}

// buildEndmatter(data) -> the serialized block ('---\n' + YAML), or '' when
// there is nothing to store. Sections without entries are pruned so a fully
// resolved-and-cleared review leaves no endmatter behind.
//
// The block carries NO trailing newline: the pipeline's `trailing` field is
// the single owner of end-of-file newlines. (yaml.dump always appends one;
// leaving it in grew the file's newline run by one per review-op save.)
export function buildEndmatter(data) {
  if (!hasReviewData(data)) return '';
  const pruned = {};
  for (const key of ['comments', 'suggestions', 'review']) {
    if (isPlainObject(data[key]) && Object.keys(data[key]).length > 0) {
      pruned[key] = data[key];
    }
  }
  return ('---\n' + yaml.dump(pruned, { lineWidth: -1, quotingType: '"' })).replace(/\n$/, '');
}
