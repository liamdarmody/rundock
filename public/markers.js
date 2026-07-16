'use strict';
// RUNDOCK response-marker scanning. Pure decision logic, extracted from
// handleResult in app.js so it is unit-testable under node --test (the same
// UMD pattern as code-language.js: loads as a classic script in the browser,
// requires directly in Node).
//
// Agents drive real orchestration from their response text: HTML-comment
// markers request agent/skill saves and deletes, delegation handoffs, and
// delegation returns. This module turns raw response text into typed
// actions; the caller (app.js) owns the WebSocket sends and DOM effects.
//
// Behaviour contract (pinned by test/unit/markers.test.js):
//   - SAVE and legacy CREATE agent markers both upsert.
//   - Code fences directly inside a save block are cosmetic formatting and
//     are stripped; inner fences in the body are preserved (fences are NOT
//     parsing delimiters, so frontmatter templates with fenced examples
//     survive intact).
//   - Action order matches the historical scan order: agent saves, skill
//     saves, skill deletes, agent deletes, in text order within each kind.
//   - DELEGATE honours the FIRST marker only; RETURN is a boolean.
//   - The frontmatter fallback (fenced, then raw) applies only when the
//     marker scan produced zero save/delete actions; delegation and return
//     markers do not suppress it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockMarkers = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // Strip a single cosmetic code fence wrapping a save block's content.
  function stripCosmeticFence(content) {
    return content.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '').trim();
  }

  // Scan response text for RUNDOCK markers. Returns:
  //   {
  //     actions: [{ kind: 'save_agent'|'save_skill'|'delete_skill'|'delete_agent',
  //                 name, content? }],   // content on saves only
  //     delegation: { targetAgent, context } | null,
  //     hasReturn: boolean,
  //   }
  function scanMarkers(text) {
    const actions = [];
    const t = typeof text === 'string' ? text : '';

    // SAVE_AGENT and CREATE_AGENT markers (both upsert).
    const agentMarkerPattern = /<!-- RUNDOCK:(?:SAVE|CREATE)_AGENT name=([\w-]+) -->\n([\s\S]*?)<!-- \/RUNDOCK:(?:SAVE|CREATE)_AGENT -->/g;
    let match;
    while ((match = agentMarkerPattern.exec(t)) !== null) {
      actions.push({ kind: 'save_agent', name: match[1], content: stripCosmeticFence(match[2]) });
    }

    // SAVE_SKILL markers (same fence handling).
    const skillMarkerPattern = /<!-- RUNDOCK:SAVE_SKILL name=([\w-]+) -->\n([\s\S]*?)<!-- \/RUNDOCK:SAVE_SKILL -->/g;
    while ((match = skillMarkerPattern.exec(t)) !== null) {
      actions.push({ kind: 'save_skill', name: match[1], content: stripCosmeticFence(match[2]) });
    }

    // DELETE markers (name only).
    const deleteSkillPattern = /<!-- RUNDOCK:DELETE_SKILL name=([\w-]+) -->/g;
    while ((match = deleteSkillPattern.exec(t)) !== null) {
      actions.push({ kind: 'delete_skill', name: match[1] });
    }
    const deleteAgentPattern = /<!-- RUNDOCK:DELETE_AGENT name=([\w-]+) -->/g;
    while ((match = deleteAgentPattern.exec(t)) !== null) {
      actions.push({ kind: 'delete_agent', name: match[1] });
    }

    // DELEGATE: orchestrator hands off to another agent. First marker wins.
    const delegateMatch = t.match(/<!-- RUNDOCK:DELEGATE agent=([\w-]+) -->\n?([\s\S]*?)<!-- \/RUNDOCK:DELEGATE -->/);
    const delegation = delegateMatch
      ? { targetAgent: delegateMatch[1], context: delegateMatch[2].trim() }
      : null;

    // RETURN: delegate signals task complete.
    const hasReturn = /<!-- RUNDOCK:RETURN -->/.test(t);

    return { actions, delegation, hasReturn };
  }

  // Fallback extraction for responses that carry agent definitions as raw
  // YAML frontmatter without the marker wrapper. Fenced blocks are tried
  // first; raw frontmatter blocks only when fenced extraction found nothing.
  // Returns [{ name, content }].
  function extractFrontmatterAgents(text) {
    const t = typeof text === 'string' ? text : '';
    const found = [];

    const fmPattern = /```[^\n]*\n(---\n[\s\S]*?\n---[\s\S]*?)```/g;
    let fmMatch;
    while ((fmMatch = fmPattern.exec(t)) !== null) {
      const block = fmMatch[1].trim();
      const nameMatch = block.match(/^name:\s*(.+)$/m);
      const typeMatch = block.match(/^type:\s*(orchestrator|specialist)$/m);
      if (nameMatch && typeMatch) {
        found.push({ name: nameMatch[1].trim(), content: block });
      }
    }
    if (found.length) return found;

    const rawBlocks = t.split(/\n(?=---\nname:\s)/).filter(b => b.trim().startsWith('---'));
    for (const block of rawBlocks) {
      const nameMatch = block.match(/^name:\s*(.+)$/m);
      const typeMatch = block.match(/^type:\s*(orchestrator|specialist)$/m);
      if (nameMatch && typeMatch) {
        found.push({ name: nameMatch[1].trim(), content: block.trim() });
      }
    }
    return found;
  }

  // Remove marker syntax from display text: RETURN markers, whole
  // SAVE_AGENT/SAVE_SKILL blocks, and DELETE lines.
  function stripMarkers(t) {
    return t
      .replace(/<!-- RUNDOCK:RETURN -->/g, '')
      .replace(/<!-- RUNDOCK:(?:SAVE|CREATE)_AGENT name=[\w-]+ -->[\s\S]*?<!-- \/RUNDOCK:(?:SAVE|CREATE)_AGENT -->/g, '')
      .replace(/<!-- RUNDOCK:SAVE_SKILL name=[\w-]+ -->[\s\S]*?<!-- \/RUNDOCK:SAVE_SKILL -->/g, '')
      .replace(/<!-- RUNDOCK:DELETE_(?:SKILL|AGENT) name=[\w-]+ -->/g, '');
  }

  // Remove a DELEGATE marker AND everything after it: once an orchestrator
  // delegates, any trailing text belongs to the handoff, not the user.
  function stripDelegateTail(t) {
    return t.replace(/<!-- RUNDOCK:DELEGATE agent=[\w-]+ -->\n?[\s\S]*/g, '');
  }

  return { scanMarkers, extractFrontmatterAgents, stripMarkers, stripDelegateTail };
}));
