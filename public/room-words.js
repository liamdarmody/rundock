'use strict';
// The words of the panel under a lead's message while its teammates and
// helpers work: the title, the line saying how fast the plan's allowance
// goes, each row's step and state, a helper's label, the note under the
// composer, the Codex notice and the Allow card's title. Pure: names arrive as
// strings and words leave as strings, and the views draw them as text. Same
// UMD pattern as markers.js: a classic script in the browser, required in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockRoomWords = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const TIMES = { 2: 'twice', 3: 'three times', 4: 'four times', 5: 'five times', 6: 'six times' };
  // A helper outside the team is named only from this map, so a type an
  // agent makes up reads "Helper".
  const LABELS = new Map([['Explore', 'Search helper'], ['Plan', 'Planning helper'], ['web-fetch', 'Web helper']]);
  const EDITS = ['Edit', 'MultiEdit', 'NotebookEdit', 'fileChange'];

  // "A", "A and B", "A, B and C".
  function list(names) {
    return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  // Members in the order they started, each { name } for a teammate or
  // { name: null } for a helper outside the team: teammates by name, the rest
  // counted as the lead's, where the first of them started.
  function names(lead, members) {
    const others = members.filter((m) => !m.name).length;
    const out = [];
    let counted = false;
    for (const m of members) {
      if (m.name) out.push(m.name);
      else if (!counted) { out.push(others === 1 ? `${lead}'s helper` : `${lead}'s ${others} helpers`); counted = true; }
    }
    return out;
  }

  function title(lead, teammates, helpers) {
    const parts = [];
    if (teammates.length === 1) parts.push(teammates[0]);
    else if (teammates.length > 1) parts.push(`${teammates.length} teammates`);
    if (helpers === 1) parts.push('a helper');
    else if (helpers > 1) parts.push(`${helpers} helpers`);
    return `${lead} started ${parts.join(' and ')}`;
  }

  function allowTitle(lead, teammates) {
    return `${lead} wants to start ${teammates.length === 1 ? teammates[0] : `${teammates.length} teammates`}`;
  }

  // `n` counts everyone working at once, the lead included; `others` names
  // whoever else ran in the conversation beside a batch of one.
  function rateLine(lead, members, n, others) {
    if (!members.length) return '';
    const fast = `so your plan's allowance is used up to ${TIMES[Math.min(Math.max(n, 2), 6)]} as fast while`;
    if (members.length > 5) {
      return `Up to five of these ${members.every((m) => m.name) ? 'teammates' : 'helpers'} work at the same time, ${fast} they work.`;
    }
    if (members.length === 1) {
      const who = members[0].name || `${lead}'s helper`;
      if (others.length) return `${who} works at the same time as ${list([lead, ...others])}, ${fast} they work.`;
      if (members[0].name) return `${who} works while ${lead} carries on, ${fast} ${who} works.`;
      return `${who} works at the same time as ${lead}, ${fast} it works.`;
    }
    return `${list(names(lead, members))} work at the same time, ${fast} they work.`;
  }

  function fileName(file) {
    return String(file || '').split(/[\\/]/).pop();
  }

  // What a running row is doing, or null for "Working" alone.
  function stepWords(step) {
    const type = step && typeof step.type === 'string' ? step.type : '';
    const name = step && typeof step.detail === 'string' && step.detail ? fileName(step.detail) : '';
    if (type === 'Read') return name ? `reading ${name}` : null;
    if (type === 'Write') return name ? `writing ${name}` : null;
    if (EDITS.includes(type)) return name ? `editing ${name}` : null;
    if (type === 'Bash' || type === 'commandExecution') return 'running a command';
    if (type === 'Grep' || type === 'Glob') return 'searching the workspace';
    if (type === 'WebFetch') return 'reading a web page';
    if (type === 'WebSearch' || type === 'webSearch') return 'searching the web';
    if (type.startsWith('mcp__') || type === 'mcpToolCall') return 'using a connector';
    return null;
  }

  // A row's state. A completed row with a file is drawn "Done: <name>", its
  // name linked by the view.
  function stateWords(row) {
    if (row.capped) return 'Stopped. At most five helpers run at once.';
    if (row.state === 'running') {
      const step = stepWords(row.step);
      return step ? `Working: ${step}` : 'Working';
    }
    if (row.state === 'waiting') return 'Waiting. Starts when one finishes';
    if (row.state === 'completed') return 'Done';
    return 'Stopped before finishing';
  }

  function helperLabel(type) {
    return LABELS.get(type) || 'Helper';
  }

  // Labels in a panel's order; a repeat takes its number: "Helper 2".
  function numbered(labels) {
    const seen = new Map();
    return labels.map((label) => {
      seen.set(label, (seen.get(label) || 0) + 1);
      return seen.get(label) > 1 ? `${label} ${seen.get(label)}` : label;
    });
  }

  function noteWords(lead, recipient, members) {
    if (!members.length) return '';
    return `${list(names(lead, members))} ${members.length === 1 ? 'is' : 'are'} still working. Your message goes to ${recipient}.`;
  }

  function codexNotice(lead, count) {
    return `${lead} started ${count === 1 ? 'a helper' : `${count} helpers`}. Codex starts helpers straight away, so this wasn't asked first. Stop any you don't want.`;
  }

  function askedBy(helper, lead) {
    return `Asked by ${helper}, helping ${lead}`;
  }

  function stopLabel(name) {
    return `Stop ${name}`;
  }

  return { list, names, title, allowTitle, rateLine, fileName, stepWords, stateWords, helperLabel, numbered, noteWords, codexNotice, askedBy, stopLabel };
}));
