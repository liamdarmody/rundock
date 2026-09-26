// The renderer registry: which installed extension, if any, renders a given
// file target.
//
// A REGISTRY AND NOT A GUESS. The file view asks one question at its render
// seam: does anything claim this file? The answer is either a registration
// carrying everything a mount needs, or a reason there is none. There is no
// third state, because "no renderer" rendering a broken frame is the failure
// the criteria forbid: an unregistered target renders nothing and says why,
// and the plain surface carries on.
//
// FIRST CLAIM WINS, AND THE LOSER IS RECORDED. Two extensions claiming one
// target cannot both render it, and resolving by any quality judgement would
// put the registry in the business of ranking extensions. Registration order
// is the roster's order, which is stable and visible; the refused claim is
// kept with a reason so a person wondering why their renderer is silent can
// be told, rather than left to discover a quiet shadowing.

function normaliseTarget(target) {
  return String(target || '').toLowerCase();
}

// The target grammar, version one: a single dot-prefixed segment, such as
// ".csv" or ".dataview". A single final segment on purpose, because that is
// exactly what rendererFor can look up: it resolves a file's target with the
// last dot, so a multi-segment claim like ".tar.gz" would register, list,
// and never match anything, the quiet shadowing this module exists to
// prevent. No dots after the first, so the accepted grammar and the lookup
// agree. A grammar can grow later, but it can never shrink without breaking
// an extension, so it starts as small as the lookup can honour.
export function isValidTarget(target) {
  return /^\.[a-z0-9][a-z0-9-]*$/.test(normaliseTarget(target));
}

// The marker grammar, version one: a single frontmatter key, in the shape
// kanban's own `kanban-plugin` key already takes. A target names a whole
// file type, which is right for a type like ".csv" and wrong for a container
// like ".md" that holds many unrelated formats; a renderer that also
// declares a marker claims only the files whose frontmatter carries that
// key. Key presence and nothing else, because that is exactly how core
// detects a board, and an extension format that matches the ecosystem's
// existing convention is the whole point of the mechanism. One shape on
// purpose: a fenced-block marker would need a body scan and a region mount,
// and neither belongs in a registry lookup.
const MARKER_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isValidMarker(key) {
  return typeof key === 'string' && MARKER_KEY.test(key);
}

// The markers core renders itself, per target. Kanban detects a board by
// the `kanban-plugin` frontmatter key, so an extension declaring that key
// over ".md" would be claiming files the built-in board view already owns.
// Core wins, and it wins here at registration rather than emergently in the
// file view's dispatch order, so the refusal exists as a fact a person can
// be shown instead of a behavior they have to infer. The server's roster
// reader carries an identical table (it cannot import this browser module),
// and a test holds the two equal.
export const CORE_MARKERS = {
  '.md': { 'kanban-plugin': "Rundock's own board view" },
};

// The frontmatter keys a file carries, read the way kanban's isBoardFile
// reads them: the file must open with "---", the block must close, and a
// key is a "name:" line inside it. Deliberately a small local copy rather
// than a reuse: kanban's parser reaches this module only through a window
// global that Node tests do not have, and the agent-side frontmatter parser
// is server CommonJS entangled with agent semantics, while this module is
// browser ES with no build step. Same detection, spelled where the lookup
// can use it; the agreement is pinned by tests that feed both the same
// bytes.
function frontmatterKeys(content) {
  const src = String(content);
  if (!src.startsWith('---')) return [];
  const closing = src.slice(3).match(/\n---/);
  if (!closing) return [];
  const keys = [];
  for (const line of src.slice(3, 3 + closing.index).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const named = trimmed.match(/^([^:]+):/);
    if (named) keys.push(named[1].trim());
  }
  return keys;
}

// AN EMPTY REGISTRY CAN CARRY A REASON. When the roster could not be read,
// the client installs a registry with nothing in it and the server's reason
// on it, so every lookup answers "unregistered, because the roster failed"
// rather than the previous workspace's claims or a silent nothing.
/**
 * Is this a path an extension may never be handed?
 *
 * Any path with a segment beginning with a dot: `.claude/` holds the agents
 * and skills the person's runtime executes, `.rundock/` holds Rundock's own
 * state, and dotfiles such as `.mcp.json` and `.env` hold credentials. An
 * extension handed one of those, and able to write it, is no longer confined
 * to a view: it can change what an agent does the next time it runs.
 *
 * HERE, AT THE ONE PLACE EVERY CLAIM IS DECIDED, rather than at each caller,
 * because the failure it prevents is a caller forgetting. It holds however
 * the file was opened, by the person or by an extension's `open`, and agent
 * and skill files have their own surfaces, so nothing a person needs is lost.
 */
export function isHiddenPath(path) {
  return String(path == null ? '' : path)
    .split(/[\\/]+/)
    .some((segment) => segment.length > 1 && segment.startsWith('.') && segment !== '..');
}

export const HIDDEN_PATH_REASON = 'a file in a hidden folder, or a hidden file, is never handed to an extension';

export function createRendererRegistry(opts = {}) {
  const byTarget = new Map();
  const refusals = [];
  const versions = new Map();
  // Which extension draws a fenced language. Kept apart from byTarget because
  // the two answer different questions: a target is a claim on a FILE, and a
  // drawn language is a claim on a BLOCK inside somebody else's file. An
  // extension may hold one, the other, or both, and conflating them would let
  // a region claim shadow a file claim or the reverse.
  const byLanguage = new Map();
  const languageRefusals = [];
  const unavailable = opts && typeof opts.unavailable === 'string' && opts.unavailable
    ? opts.unavailable : null;

  return {
    /**
     * Register every renderer an installed-extension roster declares.
     * @param {Array<{id: string, enabled?: boolean, renderers?: Array<{id: string, target: string, declares?: string}>}>} extensions
     */
    registerFromRoster(extensions) {
      for (const ext of (extensions || [])) {
        if (ext.enabled === false) continue;
        // The build when the roster names one (version and commit), so a
        // mounted view can tell new code under the same version number.
        versions.set(ext.id, typeof ext.build === 'string' ? ext.build : typeof ext.version === 'string' ? ext.version : null);
        // The region claim, when one is declared. First claim wins and the
        // loser is recorded, exactly as a file target is: two extensions
        // drawing `mermaid` cannot both draw it, and the one that does not
        // must be able to say why it is doing nothing.
        if (typeof ext.draws === 'string' && ext.draws) {
          // Judged AS WRITTEN, not normalised. normaliseTarget lowercases,
          // which would quietly turn a manifest's `Mermaid` into a claim on
          // `mermaid` and leave the two disagreeing about what was declared.
          // The records file is plain JSON anything can have edited, so a
          // malformed claim becomes a named refusal here rather than a
          // shape-fix, the same rule the marker claim above follows.
          const language = ext.draws;
          if (!isValidMarker(language)) {
            languageRefusals.push({ extension: ext.id, language: ext.draws,
              reason: 'The drawn language is not a fenced language of lowercase letters, digits and dashes.' });
          } else if (byLanguage.has(language)) {
            languageRefusals.push({ extension: ext.id, language,
              reason: `The "${language}" language is already drawn by ${byLanguage.get(language)}.` });
          } else {
            byLanguage.set(language, ext.id);
          }
        }
        for (const renderer of (ext.renderers || [])) {
          const target = normaliseTarget(renderer.target);
          if (!isValidTarget(target)) {
            refusals.push({ extension: ext.id, target: renderer.target,
              reason: 'The target is not a file extension of the form ".name".' });
            continue;
          }
          // The marker, when one is declared. A declared marker outside the
          // grammar is refused rather than dropped to a bare claim, because
          // silently widening "some .md files" into "every .md file" is the
          // exact overreach the marker exists to prevent.
          const declares = renderer.declares === undefined || renderer.declares === null
            ? null : renderer.declares;
          if (declares !== null && !isValidMarker(declares)) {
            refusals.push({ extension: ext.id, target, declares,
              reason: 'The declared marker is not a frontmatter key of lowercase letters, digits and dashes.' });
            continue;
          }
          const coreOwner = declares !== null && CORE_MARKERS[target]
            ? CORE_MARKERS[target][declares] : null;
          if (coreOwner) {
            refusals.push({ extension: ext.id, target, declares,
              reason: `Files marked "${declares}" are rendered by ${coreOwner}; the marker is Rundock's and cannot be claimed.` });
            continue;
          }
          // One slot per target, holding at most one bare claim and one
          // claim per marker. A marker claim and a bare claim on the same
          // target are different claims and coexist; two claims on the same
          // thing keep first-claim-wins with the loser recorded, exactly as
          // bare targets always have.
          const slot = byTarget.get(target) || { bare: null, marked: new Map() };
          if (declares === null) {
            if (slot.bare) {
              refusals.push({ extension: ext.id, target,
                reason: `Files ending "${target}" are already rendered by ${slot.bare.extension}.` });
              continue;
            }
            slot.bare = { extension: ext.id, renderer: renderer.id, target };
          } else {
            if (slot.marked.has(declares)) {
              refusals.push({ extension: ext.id, target, declares,
                reason: `Files ending "${target}" and marked "${declares}" are already rendered by ${slot.marked.get(declares).extension}.` });
              continue;
            }
            slot.marked.set(declares, { extension: ext.id, renderer: renderer.id, target, declares });
          }
          byTarget.set(target, slot);
        }
      }
    },

    /**
     * The one question the file view asks. The caller passes the file's
     * content alongside its path, because a marker claim can only be judged
     * by looking at the file; no IO happens here, the seam already holds
     * the text it is about to render. A marker claim beats a bare claim on
     * the same target because it is more specific: the marked file is the
     * declaring extension's own format, and the bare claim keeps everything
     * else.
     * @returns {{ registered: true, extension: string, renderer: string }
     *   | { registered: false, reason: string }}
     */
    rendererFor(path, content) {
      if (unavailable) return { registered: false, reason: unavailable };
      if (isHiddenPath(path)) return { registered: false, reason: HIDDEN_PATH_REASON };
      const name = String(path || '');
      const dot = name.lastIndexOf('.');
      if (dot < 0 || dot === name.length - 1) {
        return { registered: false, reason: 'the file has no extension for a renderer to claim' };
      }
      const target = normaliseTarget(name.slice(dot));
      const slot = byTarget.get(target);
      if (!slot) {
        return { registered: false, reason: `no installed extension renders "${target}"` };
      }
      if (slot.marked.size && typeof content === 'string') {
        for (const key of frontmatterKeys(content)) {
          const marked = slot.marked.get(key);
          // The marker rides on the claim: a view is handed a note's named
          // sources only when it claimed the note by its marker.
          if (marked) return { registered: true, extension: marked.extension, renderer: marked.renderer, marker: marked.declares };
        }
      }
      if (slot.bare) {
        return { registered: true, extension: slot.bare.extension, renderer: slot.bare.renderer };
      }
      // Only marker claims exist for this target and none matched, which is
      // the ordinary fate of an unmarked file in a claimed container. The
      // reason names the markers so a person who expected their renderer to
      // fire can see what the file would need to carry.
      const markers = [...slot.marked.keys()].sort().map((k) => `"${k}"`).join(' or ');
      return { registered: false,
        reason: `the installed renderers for "${target}" claim only files marked ${markers} in their frontmatter, and this file carries no such marker` };
    },

    /**
     * Which extension draws this fenced language, if any.
     *
     * Answers an id or null, and never throws: a document full of fenced
     * blocks asks this once per block, and a language nothing claims is the
     * ordinary case rather than an error.
     */
    drawerFor(language, path) {
      // A document in a hidden folder keeps its fenced blocks as text: a
      // region frame would otherwise be sent that document's source.
      if (path != null && isHiddenPath(path)) return null;
      const key = normaliseTarget(language);
      return byLanguage.has(key) ? byLanguage.get(key) : null;
    },
    // Every language something draws, for a caller that wants to ask once
    // per document rather than once per block.
    languages: () => [...byLanguage.keys()].sort(),

    // Refused claims, kept so silence is explicable.
    refusals: () => refusals.concat(languageRefusals),
    targets: () => [...byTarget.keys()].sort(),
    // The roster failure this registry stands in for, or null when it was
    // built from a roster.
    unavailable: () => unavailable,
    // The version the roster carried for an extension, so a live mount can
    // be compared against the next roster without a second copy of it.
    versionOf: (extensionId) => (versions.has(extensionId) ? versions.get(extensionId) : null),
  };
}
