'use strict';
// Agent discovery + frontmatter parsing, extracted verbatim from server.js
// as part of the server decomposition. Owns the agent roster cache. The root's
// invalidateAgentCache() cascade calls invalidateAgentCache() here first,
// then clears its own dependent caches (skills, file list, file tree) which
// key off the same mutations.
//
// The workspace root is LIVE state: read getWorkspace() inside each
// operation, never capture it at require time.
//
// Routine state comes straight from lib/scheduler.js, which owns it and
// mutates it in place (never reassigns). The require happens at USE time
// inside discoverAgents: the scheduler top-requires the codex glue, which
// top-requires this module, so a top-level require here would close that
// cycle and hand one of the three a partially-built module.
const fs = require('fs');
const path = require('path');
const { getWorkspace, DEFAULT_MODEL } = require('../config.js');
const { parseRoutineBlocks, normalizeRoutine, migrateAgentRoutines } = require('./routines.js');

let _agentCache = null;
let _agentCacheTime = 0;
const AGENT_CACHE_TTL = 2000; // 2 seconds
// Cap on the instructions shown in the profile panel. Generous so a real agent
// file (or CLAUDE.md) is never silently cut off, which used to look like "my
// edit vanished"; the panel scrolls, so the length is not a layout problem.
const AGENT_INSTRUCTIONS_MAX = 20000;

function invalidateAgentCache() { _agentCache = null; _agentCacheTime = 0; }

// The glyph the platform guide wears, reserved for it. docs/AGENTS.md tells a
// user it is reserved, and scaffold/rundock-guide.md is what actually wears it.
// Named here because the rotation below has to be able to exclude it.
const GUIDE_RESERVED_ICON = '⬡';

// The avatar handed to an agent whose file declares no `icon`, in rotation.
//
// THE RESERVED GLYPH IS NOT IN IT, and that is the whole point of this array
// being a named constant rather than a literal inside the assignment. It used
// to carry the hexagon at index 6, so the seventh icon-less agent in a
// workspace was handed the guide's own glyph and the two became
// indistinguishable in the org chart and the sidebar. Seven glyphs that are
// always somebody else's beats eight that occasionally lie.
//
// Exported so a test can read the same array the assignment indexes into.
// Reading a copy, or the source text, is what would let the glyph return the
// next time somebody extends this.
const AUTO_ASSIGNED_ICONS = ['★', '✎', '◎', '▦', '◇', '✦', '△'];

function discoverAgents() {
  // No workspace selected yet: nothing to discover. Guards path.join(null,…),
  // which otherwise throws and crashes GET /api/agents before a workspace is
  // picked (latent crash otherwise).
  const ws = getWorkspace();
  if (!ws) return [];
  const now = Date.now();
  if (_agentCache && (now - _agentCacheTime) < AGENT_CACHE_TTL) return _agentCache;
  const agents = [];
  const agentsDir = path.join(ws, '.claude', 'agents');
  const claudeMdPath = path.join(ws, 'CLAUDE.md');
  const colours = ['#E87A5A', '#6B9EF0', '#6BC67E', '#E8A84C', '#A07AE8', '#E87AAC', '#5BCFC4', '#E8A07A'];
  let colourIdx = 0;

  if (fs.existsSync(agentsDir)) {
    let files = [];
    try { files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')); } catch (e) { console.warn('  Cannot read agents dir:', e.message); }

    for (const file of files) {
      try {
        const content = readNormalisedFile(path.join(agentsDir, file));
        const fmText = extractFrontmatterText(content);
        const meta = parseAgentFrontmatter(content);
        const id = file.replace('.md', '');
        const isDefault = meta.isDefault === 'true' || meta.isDefault === true || (meta.order && parseInt(meta.order) === 0);

        const fmName = meta.name || id;
        const displayName = meta.displayName || meta.name || titleCase(id);
        const role = meta.role || titleCase(id);
        const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)/);
        let instructions = bodyMatch ? bodyMatch[1].trim() : '';

        // Default agent: CLAUDE.md fills in ONLY when the agent file has no
        // body of its own. The old code REPLACED the authored body outright,
        // so every scaffolded order-0 orchestrator showed workspace
        // boilerplate as its instructions and none of the file Doc wrote
        // (found in 0.11.6 pre-publish testing: the profile appeared "cut
        // off" exactly at CLAUDE.md's last line). The runtime is unaffected
        // either way: it loads the agent file and CLAUDE.md separately; this
        // field feeds the profile and the roster self-descriptions.
        if (isDefault && !instructions.trim() && fs.existsSync(claudeMdPath)) {
          instructions = readNormalisedFile(claudeMdPath).substring(0, AGENT_INSTRUCTIONS_MAX);
        }

        const caps = parseCapabilities(fmText);
        const owner = isDefault ? 'default' : id;
        // Routines migrate lazily on read, like the conversation store: the
        // returned content carries the new representation whether or not the
        // file could be rewritten to match.
        const migrated = migrateAgentRoutines(path.join(agentsDir, file), content, { owner });
        const routines = parseRoutines(migrated === content ? fmText : extractFrontmatterText(migrated), { owner });

        const prompts = parsePrompts(fmText);
        const skills = parseSkills(fmText);

        const agentType = meta.type || null; // orchestrator, specialist, platform, or null
        const hasOrder = meta.order !== undefined && meta.order !== '';
        const orderNum = hasOrder ? parseFloat(meta.order) : null;

        // Three-state detection:
        // onTeam: has order (with or without type - backward compat)
        // available: has type but no order (marketplace install, not placed)
        // raw: no type AND no order (bare Claude Code agent, needs onboarding)
        let status = 'raw';
        if (hasOrder) status = 'onTeam';
        else if (agentType) status = 'available';

        agents.push({
          id: isDefault ? 'default' : id,
          name: fmName,
          displayName,
          role,
          description: meta.description || '',
          type: agentType,
          status,
          capabilities: caps,
          routines: routines,
          prompts: prompts.length > 0 ? prompts : null,
          skills: skills.length > 0 ? skills : null,
          // Runtime is a strict two-value field: unknown values fall back to
          // claude so a frontmatter typo can never strand an agent. Codex
          // agents get no default model injected: the Codex CLI applies its
          // own default, and Rundock only passes --model when the agent file
          // sets one explicitly.
          // Case-insensitive: `runtime: Codex` must not silently run on
          // Claude (a silent runtime override, the same class of problem the
          // off-roster delegation guard exists for). Anything that is not
          // codex (any case) is claude, the default.
          // Orchestrators and platform agents ALWAYS run on Claude Code,
          // whatever their frontmatter says: delegation works through the
          // Agent tool in Claude Code's stream, which Codex exec does not
          // have, so a Codex orchestrator would be told to route with a tool
          // that does not exist for it. The docs state the rule; this line
          // makes it true. (Revisit with the app-server protocol work.)
          runtime: (meta.type === 'orchestrator' || meta.type === 'platform') ? 'claude'
            : (String(meta.runtime || '').toLowerCase() === 'codex' ? 'codex' : 'claude'),
          model: ((meta.type !== 'orchestrator' && meta.type !== 'platform') && String(meta.runtime || '').toLowerCase() === 'codex') ? (meta.model || null) : (meta.model || DEFAULT_MODEL),
          order: orderNum,
          reportsTo: meta.reportsTo || null,
          instructions: instructions.substring(0, AGENT_INSTRUCTIONS_MAX),
          isDefault,
          colour: meta.colour || colours[colourIdx % colours.length],
          icon: meta.icon || AUTO_ASSIGNED_ICONS[colourIdx % AUTO_ASSIGNED_ICONS.length],
          fileName: file
        });
        colourIdx++;
      } catch (e) {
        console.error(`Error reading agent ${file}:`, e.message);
      }
    }
  }

  // If no default agent was found in agent files, create one from CLAUDE.md
  if (!agents.find(a => a.isDefault)) {
    if (fs.existsSync(claudeMdPath)) {
      const content = readNormalisedFile(claudeMdPath);
      const nameMatch = content.match(/^#\s+(.+)/m);
      const defaultName = nameMatch ? nameMatch[1].split(/\s*[-]/)[0].trim() : 'Assistant';
      agents.unshift({
        id: 'default',
        name: 'default',
        displayName: defaultName,
        role: 'Default Agent',
        description: '',
        capabilities: null,
        routines: [],
        prompts: null,
        runtime: 'claude',
        model: DEFAULT_MODEL,
        order: 0,
        instructions: content.substring(0, 2000),
        isDefault: true,
        colour: '#E87A5A',
        icon: '★',
        fileName: null
      });
    }
  }

  // Sort: onTeam first (by order), then available, then raw
  agents.sort((a, b) => {
    const statusOrder = { onTeam: 0, available: 1, raw: 2 };
    const sa = statusOrder[a.status] ?? 2;
    const sb = statusOrder[b.status] ?? 2;
    if (sa !== sb) return sa - sb;
    // Within onTeam: orchestrator first, then by order
    if (a.type === 'orchestrator' && b.type !== 'orchestrator') return -1;
    if (b.type === 'orchestrator' && a.type !== 'orchestrator') return 1;
    if (a.type === 'platform' && b.type !== 'platform') return 1;
    if (b.type === 'platform' && a.type !== 'platform') return -1;
    return (a.order ?? 99) - (b.order ?? 99);
  });

  // Inject built-in Doc if no platform agent exists AND no rundock-guide
  // file was discovered. The id check is defence in depth: if a
  // rundock-guide.md exists on disk but its frontmatter failed to parse
  // (so type is null instead of 'platform'), the file-parsed agent is
  // already in the array under id 'rundock-guide', and pushing the
  // built-in fallback alongside it would produce two entries with the
  // same id and break lookups. Better to surface a degraded-but-singular
  // Doc than a phantom duplicate.
  if (!agents.find(a => a.type === 'platform') && !agents.find(a => a.id === 'rundock-guide')) {
    agents.push({
      id: 'rundock-guide',
      name: 'rundock-guide',
      displayName: 'Doc',
      role: 'Platform Guide',
      description: 'Helps you set up and navigate your Rundock workspace',
      type: 'platform',
      status: 'onTeam',
      capabilities: null,
      routines: [],
      prompts: ['Help me set up this workspace', 'Create an agent for my team', 'What makes a workspace Rundock-ready?'],
      runtime: 'claude',
      model: DEFAULT_MODEL,
      order: 99,
      instructions: '',
      isDefault: false,
      colour: '#6B8A9E',
      icon: GUIDE_RESERVED_ICON,
      fileName: null
    });
  }

  // Attach routine state, required at USE time to stay off the require
  // cycle (see the module header).
  const { routineState, routineDisplayFacts } = require('../scheduler.js');
  for (const agent of agents) {
    if (agent.routines) {
      for (const r of agent.routines) {
        const key = `${agent.id}:${r.name}`;
        r.state = routineState[key] || null;
        // What the routines list needs and neither the file nor the run state
        // carries: when it runs next, the slot its last run served, and the
        // most recent slot that passed with nobody watching. All three are
        // READ out of the scheduler's two stores; nothing is written back, and
        // the slot store in particular is read here and nowhere near the
        // double-fire suppression.
        const facts = routineDisplayFacts(key, r.schedule);
        r.nextRun = facts.nextRun;
        // The moment the last run BEGAN, which is not what r.state.lastRun
        // holds once a run has finished. See lastRunStartedAt.
        r.lastStart = facts.lastStart;
        r.lastSlot = facts.lastSlot;
        r.missedSlot = facts.missedSlot;
      }
    }
  }

  _agentCache = agents;
  _agentCacheTime = Date.now();
  return agents;
}

/**
 * Read a file as UTF-8 with line endings normalised to LF.
 * Some platforms (notably Windows with default Git config) check files out
 * with CRLF line endings. Several parsers in this codebase use \n-only
 * regexes; normalising at the read boundary keeps those parsers correct
 * without needing every regex to be CRLF-aware.
 */
function readNormalisedFile(filePath) {
  return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
}

function extractFrontmatterText(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : '';
}

function titleCase(str) {
  return str.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function parseAgentFrontmatter(content) {
  const fmText = extractFrontmatterText(content);
  if (!fmText) return {};

  const meta = {};
  const lines = fmText.split('\n');
  let currentKey = null;
  let currentValue = '';

  for (const line of lines) {
    // Skip nested blocks (capabilities, routines, prompts) - parsed separately
    if (line.match(/^(capabilities|routines|prompts):$/)) {
      if (currentKey) { meta[currentKey] = currentValue.trim(); }
      currentKey = null; continue;
    }
    if (line.match(/^\s+-?\s*\w+:/) && line.startsWith('  ')) { continue; }

    const keyMatch = line.match(/^(\w+):\s*(.*)/);
    if (keyMatch) {
      if (currentKey) meta[currentKey] = currentValue.trim();
      currentKey = keyMatch[1];
      currentValue = keyMatch[2];
    } else if (currentKey && line.startsWith('  ')) {
      currentValue += ' ' + line.trim();
    }
  }
  if (currentKey) meta[currentKey] = currentValue.trim();

  if (meta.description) meta.description = meta.description.replace(/^>\s*/, '').trim();
  // Strip surrounding quotes from values (YAML-style "value" or 'value')
  for (const key of Object.keys(meta)) {
    if (typeof meta[key] === 'string') {
      meta[key] = meta[key].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }
  }
  return meta;
}

function parseCapabilities(fmText) {
  const match = fmText.match(/capabilities:\n((?:  \w+:.*\n?)+)/);
  if (!match) return null;
  const caps = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^\s+(\w+):\s*(.*)/);
    if (kv) caps[kv[1]] = kv[2].trim();
  }
  return Object.keys(caps).length > 0 ? caps : null;
}

// Routines parse to the typed representation in lib/agents/routines.js. The
// block scan itself lives there too, because the writer needs the same idea of
// where a block starts and stops and two copies of that would drift.
// `opts.owner` is the id of the agent whose file declares the routine, which
// is what an undeclared owner has always meant.
function parseRoutines(fmText, opts = {}) {
  return parseRoutineBlocks(fmText).map(raw => normalizeRoutine(raw, opts));
}

function parsePrompts(fmText) {
  const match = fmText.match(/prompts:\n((?:  - [^\n]*(?:\n|$))+)/);
  if (!match) return [];
  const prompts = [];
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s*"?(.*?)"?\s*$/);
    if (item && item[1].trim()) prompts.push(item[1].trim());
  }
  return prompts;
}

// Reads the `skills:` list from frontmatter text. Accepts both YAML list
// forms authors actually write: the block sequence at any indent (two-space,
// four-space, tabs) and the inline flow form `skills: [a, b]`. The inline
// form silently parsed to [] for as long as this function existed, masked by
// the body-text fallback scan, so an agent could look correctly configured
// while Rundock saw no skills at all. Anchored to the top-level key so
// `other-skills:` and nested `skills:` keys never match.
function parseSkills(fmText) {
  const inline = fmText.match(/^skills:[ \t]*\[([^\]]*)\][ \t]*$/m);
  if (inline) {
    return inline[1].split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, '').trim())
      .filter(Boolean);
  }
  const match = fmText.match(/^skills:[ \t]*\n((?:[ \t]+-[ \t]*[^\n]*(?:\n|$))+)/m);
  if (!match) return [];
  const skills = [];
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const item = line.match(/^[ \t]+-[ \t]*["']?(.*?)["']?[ \t]*$/);
    if (item && item[1].trim()) skills.push(item[1].trim());
  }
  return skills;
}

module.exports = {
  discoverAgents, invalidateAgentCache,
  readNormalisedFile, extractFrontmatterText, titleCase,
  parseAgentFrontmatter, parseCapabilities, parseRoutines, parsePrompts, parseSkills,
  AGENT_CACHE_TTL, AGENT_INSTRUCTIONS_MAX,
  AUTO_ASSIGNED_ICONS, GUIDE_RESERVED_ICON,
};
