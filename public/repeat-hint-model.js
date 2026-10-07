'use strict';
// THE SETTING THAT WOULD STOP REPEATED CARDS, named where the cards happen.
//
// Someone meeting card after card in one conversation is standing in front of
// a problem a setting already solves, and nothing on screen says so. This
// module decides, for each permission card, whether a setting could have
// answered it and which one, counts those cards per conversation, and says
// when a one-line hint goes under the latest card and what it says. The chat
// view draws what this returns; Settings opens with the control ringed and
// nothing changed.
//
// Pure, with no DOM and no socket, so every rule below is tested without a
// page. Same UMD pattern as permissions.js, which it reads for the one
// definition of a card that can't be undone.
//
// WHAT NEVER COUNTS. A card for a command that can't be undone always asks, in
// every mode, and no setting should silence it, so it neither counts nor gets
// the hint. Nor does a card no setting would stop: a secret, an answer file,
// an instruction file, a hidden folder under home, a persistence surface, a
// Code-mode verdict, or a crossing whose places share no one folder.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./permissions.js'));
  else root.RundockRepeatHint = factory(root.RundockPermissions);
}(typeof self !== 'undefined' ? self : this, function (RundockPermissions) {

  // The hint is shown on the 3rd card a setting could fix, then only again at
  // the 6th and the 12th, each counted over a rolling ten minutes.
  const THRESHOLDS = [3, 6, 12];
  const WINDOW_MS = 10 * 60 * 1000;

  const SHELL = new Set(['Bash', 'PowerShell']);

  function isUnder(child, parent) {
    if (typeof child !== 'string' || typeof parent !== 'string' || !parent) return false;
    const p = parent.replace(/[\\/]+$/, '');
    return child === p || child.startsWith(p + '/') || child.startsWith(p + '\\');
  }

  // The fix for one card, or null when no setting would stop it.
  //   { kind: 'folder', folder }  add this folder as a Working folder
  //   { kind: 'code' }            switch to Code mode (only from Notes mode)
  //   { kind: 'sandbox' }         Keep agents inside this workspace, off
  // `mode` is the workspace's mode: 'code', or anything else for Notes (an older
  // workspace stores Notes as 'knowledge').
  function fixFor(request, mode) {
    const r = request || {};
    const tool = r.tool_name || '';
    const input = r.input || {};
    if (r.put_back || r.answer_file === true) return null;
    // Any Code-mode verdict on a card means Code mode has already judged it
    // worth a person's decision: it can't be undone, or it asks once by rule.
    if (r.code_mode_verdict && r.code_mode_verdict.verdict) return null;
    // A command that can't be undone always asks. It never counts.
    if (RundockPermissions.classifyRisk(tool, input) === 'high') return null;
    if (r.boundary === true) {
      const crossings = Array.isArray(r.crossings) ? r.crossings : [];
      if (crossings.some(c => c && (c.secret || c.answerFile || c.instructionFile || c.hiddenHome || c.persistenceSurface))) return null;
      // Established by the operating system rather than by a path: the
      // sandbox refused a command and it was retried past it. Only the switch
      // stops this card, and there is no one folder to name.
      if (crossings.length === 0 && !r.resolved_path) return SHELL.has(tool) ? { kind: 'sandbox' } : null;
      // A folder only when every place the card reaches is inside it.
      const folder = typeof r.grant_dir === 'string' ? r.grant_dir : '';
      if (!folder) return null;
      const places = crossings.length ? crossings.map(c => c && c.path) : [r.resolved_path];
      return places.every(p => isUnder(p, folder)) ? { kind: 'folder', folder } : null;
    }
    // An ordinary command, asked about because the workspace is in Notes mode.
    if (SHELL.has(tool) && mode !== 'code') return { kind: 'code' };
    return null;
  }

  function fixKey(fix) {
    return fix.kind === 'folder' ? `folder:${fix.folder}` : fix.kind;
  }

  // ── Counting, per conversation ─────────────────────────────────────────
  function createTracker() { return new Map(); }

  function convoState(tracker, convoId) {
    let s = tracker.get(convoId);
    if (!s) {
      s = { seen: new Set(), cards: [], next: 0, hint: null };
      tracker.set(convoId, s);
    }
    return s;
  }

  // One card arrived in a conversation. Returns the hint to show under it, or
  // null. A request seen before (a reconnect re-sends every pending one) is
  // not counted twice.
  function recordCard(tracker, convoId, requestId, fix, now) {
    if (!convoId || !requestId) return null;
    const s = convoState(tracker, convoId);
    if (s.seen.has(requestId)) return null;
    s.seen.add(requestId);
    if (!fix) return null;
    s.cards = s.cards.filter(c => now - c.at < WINDOW_MS);
    s.cards.push({ at: now, key: fixKey(fix) });
    const count = s.cards.length;
    if (s.next >= THRESHOLDS.length || count < THRESHOLDS[s.next]) return null;
    s.next += 1;
    const key = fixKey(fix);
    s.hint = { requestId, fix, count, sameFix: s.cards.every(c => c.key === key), dismissed: false };
    return s.hint;
  }

  // The hint drawn under this card, if it is the conversation's current one.
  function hintFor(tracker, convoId, requestId) {
    const s = tracker.get(convoId);
    const h = s && s.hint;
    return h && !h.dismissed && h.requestId === requestId ? h : null;
  }

  function dismiss(tracker, convoId) {
    const s = tracker.get(convoId);
    if (s && s.hint) s.hint.dismissed = true;
  }

  // ── The words ──────────────────────────────────────────────────────────
  const ORDINALS = { 3: 'third', 6: 'sixth', 12: 'twelfth' };
  function ordinal(n) { return ORDINALS[n] || `${n}th`; }

  // The hint's words as parts the view draws as text: { text }, { strong },
  // or { link }. Settings are named exactly as the app names them.
  // opts: { agent, folderLabel }, the folder as the person reads it (with ~).
  function hintCopy(hint, opts) {
    const o = opts || {};
    const agent = o.agent || 'your agent';
    const nth = ordinal(hint.count);
    const fix = hint.fix;
    const general = `This is the ${nth} time ${agent} has had to ask in the last few minutes. `;
    if (fix.kind === 'folder') {
      const folder = o.folderLabel || fix.folder;
      const lead = hint.sameFix
        ? [{ text: `This is the ${nth} time ${agent} has asked about ` }, { strong: folder }, { text: '. ' }]
        : [{ text: general + 'This one is about ' }, { strong: folder }, { text: '. ' }];
      return { kind: 'folder', caution: false,
        parts: lead.concat([{ text: 'Add it as a ' }, { link: 'Working folder' }, { text: ' and this stops asking.' }]) };
    }
    if (fix.kind === 'code') {
      const lead = hint.sameFix ? `This is the ${nth} command ${agent} has needed to ask about. ` : general;
      return { kind: 'code', caution: false,
        parts: [{ text: `${lead}You're in Notes mode: switch to ` }, { link: 'Code mode' },
          { text: ' and everyday commands like this run without asking.' }] };
    }
    const lead = hint.sameFix
      ? `This is the ${nth} time ${agent} has been stopped outside your workspace, with no single folder to name. `
      : `${general}This one was stopped outside your workspace, with no single folder to name. `;
    return { kind: 'sandbox', caution: true,
      parts: [{ text: `${lead}Turning off ` }, { link: 'Keep agents inside this workspace' },
        { text: ' would stop this, but agents could then change or delete files anywhere your account allows.' }] };
  }

  return { THRESHOLDS, WINDOW_MS, fixFor, createTracker, recordCard, hintFor, dismiss, hintCopy };
}));
