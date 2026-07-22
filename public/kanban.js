/**
 * kanban.js: parser/serializer for Obsidian Kanban plugin board files.
 *
 * Byte-compatibility target: obsidian-kanban v2.0.51. Every rule here was
 * extracted from the plugin's compiled main.js (functions W_/LB/U_/PB/vk on
 * the serialize side; R_/B_/gf/IB/AB and helpers Dg/Eg/qk/Cd/Sg/co/OB on the
 * parse side), so the minified names are cited to keep each rule re-verifiable
 * against the bundle.
 *
 * No dependencies. Works in Node and the browser (UMD-style export at bottom).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Kanban = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The plugin serializes continuation-line indentation from the Obsidian
  // workspace's "useTab" setting (default true), which this build assumes.
  const INDENT = '\t'; // Cd: '\n' -> '\n\t' when useTab, '\n    ' otherwise

  // ---------------------------------------------------------------------
  // Parse
  // ---------------------------------------------------------------------

  /**
   * Parse a board file into { frontmatter, lanes, archive, settings, dropped }.
   * - frontmatter: ordered [key, rawValueString] pairs (verbatim lines)
   * - lanes: [{ title, maxItems, shouldMarkItemsComplete, items }]
   * - archive: items
   * - settings: parsed settings JSON object (key order preserved)
   * - dropped: lines the plugin would silently drop on save (we surface them)
   * Item: { checkChar, checked, titleRaw, blockId }
   */
  // A brand-new board, byte-exact to the plugin's basicFrontmatter
  // (src/parsers/common.ts): frontmatter only. No lanes and NO settings
  // block: that appears on the first save, because parse hoists
  // kanban-plugin into settings (mirrored below).
  function newBoardContent() {
    // Rundock seeds a new board with three standard columns so it opens ready
    // to use rather than blank. (Obsidian's new board is frontmatter-only,
    // which in Rundock rendered as an empty board with no way to add the first
    // column.) Building it through parse + serialize yields the exact canonical
    // bytes the serialiser produces, so the very first save never reformats it.
    const template = [
      '---', '', 'kanban-plugin: board', '', '---', '',
      '## To Do', '', '',
      '## In Progress', '', '',
      '## Done', '', '',
    ].join('\n');
    return serialize(parse(template));
  }

  // Board detection, mirroring hasFrontmatterKeyRaw: any file whose
  // frontmatter carries the kanban-plugin key opens as a board.
  function isBoardFile(text) {
    try { return readFrontmatter(String(text)).keys.some(([k]) => k === 'kanban-plugin'); }
    catch (e) { return false; }
  }

  function parse(text) {
    // Normalise CRLF to LF: the structural parsing is LF-only, so a CRLF board
    // would otherwise drop every line and render empty. Save then emits LF.
    const src = String(text).replace(/\r\n/g, '\n');
    const fm = readFrontmatter(src); // { keys: [[k, v]], end: index-after-closing-delimiter }
    const settings = readSettingsBlock(src); // { json, start } or null

    // Body = between frontmatter and the settings block marker line.
    let bodyEnd = src.length;
    if (settings) bodyEnd = settings.start;
    const body = src.slice(fm.end, bodyEnd);
    const lines = body.split('\n');

    const lanes = [];
    const archive = [];
    const dropped = [];
    let lane = null; // current lane object
    let item = null; // current item: { checkChar, lines: [] }
    let pendingBreak = false; // saw a thematic break (potential archive marker)
    let inArchive = false;

    const flushItem = () => {
      if (!item) return;
      const parsed = finishItem(item);
      (inArchive ? archive : lane.items).push(parsed);
      item = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Heading at column 0 (any level; plugin normalises to '## ' on save)
      const h = line.match(/^(#{1,6}) (.*)$/);
      if (h) {
        flushItem();
        const rawTitle = h[2];
        if (pendingBreak && stripMd(rawTitle) === 'Archive') {
          inArchive = true;
          lane = null;
          pendingBreak = false;
          continue;
        }
        pendingBreak = false;
        inArchive = false;
        const { title, maxItems } = parseLaneTitle(rawTitle);
        lane = { title, maxItems, shouldMarkItemsComplete: false, items: [] };
        lanes.push(lane);
        continue;
      }

      // Thematic break at column 0 (potential archive marker; plugin drops it
      // and re-synthesises '***' before '## Archive' on save)
      if (/^ {0,3}(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
        flushItem();
        pendingBreak = true;
        continue;
      }

      // New top-level list item at column 0
      const li = line.match(/^- \[(.)\] (.*)$/) || line.match(/^- \[(.)\]$/);
      if (li && (lane || inArchive)) {
        flushItem();
        pendingBreak = false;
        item = { checkChar: li[1], lines: [li[2] || ''] };
        continue;
      }
      // Bare list item without checkbox: plugin parses it as an unchecked task
      // and rewrites it as '- [ ] ...' on save (churn).
      const bare = line.match(/^- (.*)$/);
      if (bare && (lane || inArchive) && !item) {
        pendingBreak = false;
        item = { checkChar: ' ', lines: [bare[1]] };
        continue;
      }

      // Continuation of the current item: indented content, blank lines
      // between indented content, or lazy continuation.
      if (item) {
        if (line === '' ) {
          // Blank line: belongs to the item only if more indented content follows
          // before the next structural line. Look ahead.
          let j = i + 1;
          while (j < lines.length && lines[j] === '') j++;
          if (j < lines.length && /^(\t| {2,})/.test(lines[j])) {
            item.lines.push('');
            continue;
          }
          flushItem();
          pendingBreak = false;
          continue;
        }
        if (/^(\t| {2,})/.test(line) || /^\S/.test(line) === false) {
          item.lines.push(line);
          continue;
        }
        // Lazy continuation (non-blank, column 0, not structural): CommonMark
        // attaches it to the item's paragraph; the plugin's mdast parse does too.
        if (!h && !li && !bare) {
          item.lines.push(line);
          continue;
        }
      }

      if (line === '') { continue; }

      // The '**Complete**' marker paragraph inside a lane
      if (lane && stripMd(line) === 'Complete') {
        lane.shouldMarkItemsComplete = true;
        continue;
      }

      // Anything else at top level: the plugin drops it on save.
      dropped.push({ line: i, text: line });
      pendingBreak = false;
    }
    flushItem();

    // Mirror the plugin's R_ key routing: kanban-plugin is hoisted from the
    // frontmatter into the settings object on EVERY parse ('basic' migrates
    // to 'board'), which is why even a fresh board gains its settings block
    // on the first save. Existing blocks keep their key order (assignment of
    // an existing key preserves position); a missing block starts as
    // {"kanban-plugin": ...} exactly like the plugin's first save.
    const fmKeys = fm.keys.map(([k, v]) => (k === 'kanban-plugin' && v === 'basic') ? [k, 'board'] : [k, v]);
    let settingsObj = settings ? settings.json : null;
    const kp = fmKeys.find(([k]) => k === 'kanban-plugin');
    if (kp) {
      if (!settingsObj) settingsObj = {};
      settingsObj['kanban-plugin'] = kp[1];
    }

    // Verbatim frontmatter body, with the legacy value migrated in place (the
    // only edit the plugin makes besides js-yaml reformatting, which we do not
    // replicate so nothing is lost).
    const frontmatterBody = fm.body.replace(/^(\s*kanban-plugin:\s*)basic(\s*)$/m, '$1board$2');

    return {
      frontmatter: fmKeys,
      frontmatterBody,
      lanes,
      archive,
      settings: settingsObj,
      settingsRaw: settings ? settings.raw : null,
      // Settings JSON was present but did not parse: keep the raw block verbatim
      // on serialize rather than resetting settings to a bare default.
      settingsParseFailed: !!(settings && settings.json === null && settings.raw),
      dropped,
    };
  }

  function readFrontmatter(src) {
    // Plugin's IB: file must start with '---'; find the closing '---'.
    if (!src.startsWith('---')) throw new Error('Error parsing frontmatter');
    const m = src.slice(3).match(/\n---/);
    if (!m) throw new Error('Error parsing frontmatter: no closing delimiter');
    const inner = src.slice(3, 3 + m.index);
    let end = 3 + m.index + 4; // after '\n---'
    // consume the rest of the delimiter line + one trailing newline
    while (end < src.length && src[end] !== '\n') end++;
    if (src[end] === '\n') end++;
    const keys = [];
    for (const line of inner.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const kv = t.match(/^([^:]+):\s*(.*)$/);
      if (kv) keys.push([kv[1].trim(), kv[2].trim()]);
    }
    // Capture the YAML body verbatim (framing blank lines stripped; internal
    // structure kept), so block-style YAML (multi-line tag/alias lists, nested
    // maps, comments) survives on save. A flat key/value re-emit would silently
    // destroy it. The plugin's canonical delimiter/blank template is re-applied
    // on serialize, so a canonical board stays byte-identical.
    const body = inner.replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
    return { keys, end, body };
  }

  function readSettingsBlock(src) {
    // Plugin's AB: scan from EOF for the last fenced code block, JSON.parse it.
    // Serialized form: '\n\n%% kanban:settings\n```\n{json}\n```\n%%' at EOF.
    // The real marker starts a line. Card text that merely contains the literal
    // '%% kanban:settings' must not be taken for it, or the board is truncated
    // (and the truncation is written to disk on the next save). Require a line
    // start; take the last such occurrence.
    let marker = -1;
    for (let i = src.lastIndexOf('%% kanban:settings'); i >= 0; i = src.lastIndexOf('%% kanban:settings', i - 1)) {
      if (i === 0 || src[i - 1] === '\n') { marker = i; break; }
    }
    if (marker < 0) return null;
    const fenceOpen = src.indexOf('```', marker);
    if (fenceOpen < 0) return null;
    const jsonStart = src.indexOf('\n', fenceOpen) + 1;
    const fenceClose = src.indexOf('```', jsonStart);
    if (fenceClose < 0) return null;
    const raw = src.slice(jsonStart, fenceClose).trim();
    let json = null;
    try { json = JSON.parse(raw); } catch (e) { /* invalid settings JSON */ }
    // start = beginning of the blank padding before the marker line
    let start = marker;
    while (start > 0 && (src[start - 1] === '\n' || src[start - 1] === '\r')) start--;
    return { json, raw, start };
  }

  function finishItem(item) {
    // Mirror of gf: titleRaw = qk(Eg(Dg(sourceSlice)))
    let raw = item.lines.join('\n');
    // Dg: <br> -> \n happens on lane titles; on items the plugin operates on
    // the source slice directly. Trim (Dg/Eg both trim).
    raw = raw.trim();
    // Eg: dedent exactly one level: '\n' + (4 spaces | tab) -> '\n'
    raw = raw.replace(/(?:\r\n|\n)(?: {4}|\t)/g, '\n');
    // qk: strip ' ^blockid' from first line
    let blockId;
    const nl = raw.indexOf('\n');
    const first = nl < 0 ? raw : raw.slice(0, nl);
    const bid = first.match(/\s+\^([a-zA-Z0-9-]+)$/);
    if (bid) {
      blockId = bid[1];
      const stripped = first.replace(/\s+\^([a-zA-Z0-9-]+)$/, '');
      raw = nl < 0 ? stripped : stripped + raw.slice(nl);
    }
    return {
      checkChar: item.checkChar === ' ' ? ' ' : item.checkChar,
      checked: item.checkChar !== ' ',
      titleRaw: raw,
      blockId,
    };
  }

  function parseLaneTitle(raw) {
    // co: <br> -> \n + trim (Dg), then 'Title (N)' -> maxItems
    const t = raw.replace(/<br>/g, '\n').trim();
    const m = t.match(/^(.*?)\s*\((\d+)\)$/);
    if (m) return { title: m[1], maxItems: Number(m[2]) };
    return { title: t, maxItems: 0 };
  }

  function stripMd(s) {
    // crude equivalent of the plugin's _s(node) text extraction for the
    // 'Complete' / 'Archive' comparisons: strip emphasis markers + trim
    return s.replace(/[*_`]/g, '').trim();
  }

  // ---------------------------------------------------------------------
  // Serialize (byte-exact mirror of W_/LB/U_/PB/vk)
  // ---------------------------------------------------------------------

  function serialize(board) {
    // Re-emit the verbatim YAML body (preserving block-style YAML) inside the
    // plugin's canonical delimiter/blank template. A board built without going
    // through parse (no frontmatterBody) falls back to the flat key/value emit.
    const fmInner = board.frontmatterBody != null ? board.frontmatterBody : stringifyFrontmatter(board.frontmatter);
    let out = ['---', '', fmInner, '---', '', ''].join('\n');
    for (const lane of board.lanes) out += serializeLane(lane);
    out += serializeArchive(board.archive || []);
    out += serializeSettings(board.settings, board.settingsRaw, board.settingsParseFailed);
    return out;
  }

  function stringifyFrontmatter(keys) {
    // Obsidian's stringifyYaml for flat scalar values: 'key: value\n' per key.
    return keys.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n';
  }

  function serializeLane(lane) {
    // LB
    const t = [];
    const title = cd(lane.title, lane.maxItems);
    t.push(`## ${title.trim().replace(/(?:\r\n|\n)/g, '<br>')}`); // jk
    t.push('');
    if (lane.shouldMarkItemsComplete) t.push('**Complete**');
    for (const it of lane.items) t.push(serializeItem(it));
    t.push('');
    t.push('');
    t.push('');
    return t.join('\n');
  }

  function cd(title, maxItems) {
    return maxItems ? `${title} (${maxItems})` : title;
  }

  function serializeItem(it) {
    // U_ + Cd + Sg
    let content = it.titleRaw.trim().replace(/(?:\r\n|\n)/g, '\n' + INDENT); // Cd
    if (it.blockId) {
      const lines = content.split('\n');
      lines[0] += ' ^' + it.blockId;
      content = lines.join('\n');
    }
    return `- [${it.checkChar}] ${content}`;
  }

  function serializeArchive(items) {
    // PB: only when non-empty
    if (!items.length) return '';
    const t = ['***', '', '## Archive', ''];
    for (const it of items) t.push(serializeItem(it));
    return t.join('\n');
  }

  function serializeSettings(settings, raw, parseFailed) {
    // vk: file ends '%%' with NO trailing newline
    if (!settings) return '';
    // If the original settings JSON did not parse, re-emit it verbatim rather
    // than silently discarding the user's settings for a bare default.
    const payload = (parseFailed && raw != null) ? raw : JSON.stringify(settings);
    return ['', '', '%% kanban:settings', '```', payload, '```', '%%'].join('\n');
  }

  // ---------------------------------------------------------------------
  // Board operations (what the board UI needs)
  // ---------------------------------------------------------------------

  /** Move an item between/within lanes. Indexes are pre-removal positions. */
  function moveItem(board, fromLane, fromIndex, toLane, toIndex) {
    const src = board.lanes[fromLane];
    const dst = board.lanes[toLane];
    if (!src || !dst) throw new Error('bad lane index');
    const [it] = src.items.splice(fromIndex, 1);
    if (!it) throw new Error('bad item index');
    dst.items.splice(toIndex, 0, it);
    return board;
  }

  function addItem(board, laneIndex, titleRaw) {
    const lane = board.lanes[laneIndex];
    if (!lane) throw new Error('bad lane index');
    lane.items.push({ checkChar: ' ', checked: false, titleRaw: String(titleRaw).trim(), blockId: undefined });
    return board;
  }

  /** Archive an item (plain variant: no archive-with-date settings in play). */
  function archiveItem(board, laneIndex, itemIndex) {
    const lane = board.lanes[laneIndex];
    if (!lane) throw new Error('bad lane index');
    const [it] = lane.items.splice(itemIndex, 1);
    if (!it) throw new Error('bad item index');
    board.archive.push(it); // archiveEntity uses $push (end of archive)
    return board;
  }

  /**
   * Replace a card's raw markdown. Mirrors the plugin's updateItemContent:
   * the text is stored verbatim (trimmed at serialize by Cd); checkChar and
   * blockId are separate fields and survive the edit untouched.
   */
  function updateItem(board, laneIndex, itemIndex, titleRaw) {
    const it = (board.lanes[laneIndex] || { items: [] }).items[itemIndex];
    if (!it) throw new Error('bad item index');
    it.titleRaw = String(titleRaw).trim();
    return board;
  }

  /** Delete a card outright (the plugin's deleteEntity). */
  function deleteItem(board, laneIndex, itemIndex) {
    const lane = board.lanes[laneIndex];
    if (!lane) throw new Error('bad lane index');
    const [it] = lane.items.splice(itemIndex, 1);
    if (!it) throw new Error('bad item index');
    return board;
  }

  /**
   * Toggle a card's checkbox. v2.0.51 semantics without the Tasks plugin:
   * flip between ' ' and 'x' in place; no move, no date stamp. A custom
   * checked char (e.g. '-') unchecks to ' ' and re-checks as 'x'.
   */
  function toggleItem(board, laneIndex, itemIndex) {
    const it = (board.lanes[laneIndex] || { items: [] }).items[itemIndex];
    if (!it) throw new Error('bad item index');
    it.checked = !it.checked;
    it.checkChar = it.checked ? 'x' : ' ';
    return board;
  }

  // ---------------------------------------------------------------------
  // Lane operations (column parity with the Obsidian Kanban plugin)
  // ---------------------------------------------------------------------
  // THE syntax trap for every structural lane operation: 'list-collapse' in
  // the settings JSON is POSITIONAL (one boolean per lane, lane order), so
  // reorder/insert/delete must splice it in lockstep or collapse states
  // silently attach to the wrong columns. The plugin's own boardModifiers
  // do exactly this (insertLane splices false; deleteEntity/drag reorder).

  function collapseArray(board) {
    if (!board.settings) board.settings = { 'kanban-plugin': 'board' };
    let lc = board.settings['list-collapse'];
    if (!Array.isArray(lc)) lc = [];
    // Pad to lane count with false (expanded). Both live boards carry
    // full-length arrays, so this is byte-neutral on canonical files.
    while (lc.length < board.lanes.length) lc.push(false);
    if (lc.length > board.lanes.length) lc = lc.slice(0, board.lanes.length);
    board.settings['list-collapse'] = lc;
    return lc;
  }

  /** Reorder columns. Indexes are pre-removal positions. */
  function moveLane(board, fromIndex, toIndex) {
    const lc = collapseArray(board);
    const [lane] = board.lanes.splice(fromIndex, 1);
    if (!lane) throw new Error('bad lane index');
    board.lanes.splice(toIndex, 0, lane);
    const [flag] = lc.splice(fromIndex, 1);
    lc.splice(toIndex, 0, flag);
    return board;
  }

  /** Toggle a column's collapsed state (settings JSON only; body untouched). */
  function toggleCollapse(board, laneIndex) {
    const lc = collapseArray(board);
    if (laneIndex < 0 || laneIndex >= lc.length) throw new Error('bad lane index');
    lc[laneIndex] = !lc[laneIndex];
    return board;
  }

  /**
   * Rename a column ("Edit list"). rawTitle may carry the plugin's ' (N)'
   * WIP-limit suffix and <br> newlines, exactly as the heading line stores it.
   */
  function renameLane(board, laneIndex, rawTitle) {
    const lane = board.lanes[laneIndex];
    if (!lane) throw new Error('bad lane index');
    const { title, maxItems } = parseLaneTitle(String(rawTitle));
    if (!title) throw new Error('empty lane title');
    lane.title = title;
    lane.maxItems = maxItems;
    return board;
  }

  /** Insert a new empty column at laneIndex (before/after = caller's index). */
  function insertLane(board, laneIndex, title) {
    const lc = collapseArray(board);
    const { title: t, maxItems } = parseLaneTitle(String(title || 'New list'));
    board.lanes.splice(laneIndex, 0, { title: t || 'New list', maxItems, shouldMarkItemsComplete: false, items: [] });
    lc.splice(laneIndex, 0, false); // plugin's insertLane splices false
    return board;
  }

  /**
   * "Archive cards": empty the lane into the archive. The plugin's
   * archiveLaneItems $unshifts, so the lane's cards land at the FRONT of the
   * archive in their existing order (single-card archive appends instead).
   */
  function archiveLaneCards(board, laneIndex) {
    const lane = board.lanes[laneIndex];
    if (!lane) throw new Error('bad lane index');
    board.archive = lane.items.concat(board.archive);
    lane.items = [];
    return board;
  }

  /** "Archive list": archive its cards, then remove the column. */
  function archiveLane(board, laneIndex) {
    archiveLaneCards(board, laneIndex);
    return deleteLane(board, laneIndex);
  }

  /** "Delete list": remove the column and its cards outright. */
  function deleteLane(board, laneIndex) {
    const lc = collapseArray(board);
    const [lane] = board.lanes.splice(laneIndex, 1);
    if (!lane) throw new Error('bad lane index');
    lc.splice(laneIndex, 1);
    return board;
  }

  /**
   * Sort a lane's cards in place. by = 'text' (display text, natural
   * case-insensitive) or 'tags' (first #tag alphabetically, untagged last).
   * Byte-safe by construction (any permutation of card blocks is valid);
   * ORDER parity with the plugin's comparator is approximate, noted in the
   * format spec.
   */
  function sortLane(board, laneIndex, by) {
    const lane = board.lanes[laneIndex];
    if (!lane) throw new Error('bad lane index');
    const text = (it) => it.titleRaw.replace(/[*_`#\[\]]/g, '').trim().toLowerCase();
    const firstTag = (it) => {
      const m = it.titleRaw.match(/(?:^|\s)#([\w/][\w/-]*)/);
      return m ? m[1].toLowerCase() : '￿'; // untagged sorts last
    };
    if (by === 'tags') lane.items.sort((a, b) => firstTag(a).localeCompare(firstTag(b)) || text(a).localeCompare(text(b)));
    else lane.items.sort((a, b) => text(a).localeCompare(text(b), undefined, { numeric: true }));
    return board;
  }

  return { parse, serialize, moveItem, addItem, archiveItem, updateItem, deleteItem, toggleItem,
    moveLane, toggleCollapse, renameLane, insertLane, archiveLaneCards, archiveLane, deleteLane, sortLane,
    newBoardContent, isBoardFile };
});
