#!/usr/bin/env node
'use strict';
// Break each of the extension host's wiring rules in turn and report which
// tests notice.
//
// The joins between the host and the client are each one line that can be
// deleted with the product still drawing SOMETHING: the roster still
// arrives, the file still opens, the plain surface still paints. That is why
// each is broken on purpose here and a test must go red for it. A guard
// whose mutation turns nothing red is reported as a FAILURE rather than
// passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-host-wiring-guards.js            # report
//   node test/tools/mutate-host-wiring-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The
// harness is the same shape as its siblings and deliberately a separate
// copy, for the reason stated in mutate-routines-guards.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The roster reader over the install store, watched by the handler suite
// that reads a temporary workspace carrying that store.
const SERVER = { src: path.join(ROOT, 'lib', 'packages', 'extension-registry.js'), suite: 'test/unit/protocol-handlers-lib.test.js' };
// The records-file parsing the roster reads through, owned by the writer's
// record module and watched by the same handler suite: one parser means
// broken here is broken for the roster too.
const RECORD = { src: path.join(ROOT, 'lib', 'packages', 'extension-record.js'), suite: 'test/unit/protocol-handlers-lib.test.js' };
// The host, watched by the suite that reads init off the wire and compares
// the contract document against the exported tables and cap.
const HOST = { src: path.join(ROOT, 'public', 'extension-host.js'), suite: 'test/unit/extension-host.test.js' };
// The client wiring, the seam's mount lifecycle, the registry's failure
// answer and the frame's stylesheet, all watched by the wiring suite that
// cuts them out and runs them.
const APP = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/host-wiring.test.js' };
const FILES = { src: path.join(ROOT, 'public', 'views', 'files.js'), suite: 'test/unit/host-wiring.test.js' };
const REGISTRY = { src: path.join(ROOT, 'public', 'renderer-registry.js'), suite: 'test/unit/host-wiring.test.js' };
// The same registry module, watched by its own unit suite for the marker
// rules: a second target rather than a second suite on the first, because
// the scoped gate reads each row's suite as the literal beside its target.
const REGISTRY_SPEC = { src: path.join(ROOT, 'public', 'renderer-registry.js'), suite: 'test/unit/renderer-registry.test.js' };
const SHEET = { src: path.join(ROOT, 'public', 'styles', 'components', 'extension-frame.css'), suite: 'test/unit/host-wiring.test.js' };
// The file tree's filter, watched by the handler suite that builds a tree
// over a workspace carrying the install store.
const TREE = { src: path.join(ROOT, 'server.js'), suite: 'test/unit/protocol-handlers-lib.test.js' };

const MUTATIONS = [
  // ===== ONE STORE =====
  // Point the extension root back at the retired per-directory layout and a
  // payload for an installed extension reads from a directory nothing
  // writes to.
  [SERVER, 'the payload reads the install store, not the retired per-directory layout',
    "const { RECORDS_PATH, RECORDS_SCHEMA, EXTENSIONS_ROOT, readAllOff } = require('./extension-record.js');",
    "const { RECORDS_PATH, RECORDS_SCHEMA, readAllOff } = require('./extension-record.js');\nconst EXTENSIONS_ROOT = '.rundock/plugins';"],
  // Point the roster at the retired state file and the records the install
  // flow writes are read by nothing.
  [SERVER, 'the roster reads the records file the install flow writes',
    "const { RECORDS_PATH, RECORDS_SCHEMA, EXTENSIONS_ROOT, readAllOff } = require('./extension-record.js');",
    "const { RECORDS_SCHEMA, EXTENSIONS_ROOT, readAllOff } = require('./extension-record.js');\nconst RECORDS_PATH = '.rundock/plugin-state.json';"],
  // Drop the record's copy of the declaration and an install, which
  // materialises the entry's own path and leaves no manifest behind, has
  // nothing the roster can read: the path real installs take goes dark.
  [SERVER, 'the record supplies the declaration when the installed directory carries no manifest',
    "  const entry = shipped && typeof shipped.entry === 'string' ? shipped.entry : record.entry;\n  const match = shipped && typeof shipped.match === 'string' ? shipped.match : record.match;",
    "  const entry = shipped && typeof shipped.entry === 'string' ? shipped.entry : null;\n  const match = shipped && typeof shipped.match === 'string' ? shipped.match : null;"],
  // Widen the match grammar and a rule the registry can never honour turns
  // into a claim that silently renders nothing.
  [SERVER, 'only a match of the form *.<ext> becomes a claim',
    "const SIMPLE_MATCH = /^\\*\\.([A-Za-z0-9][A-Za-z0-9-]*)$/;",
    "const SIMPLE_MATCH = /^.*\\.([A-Za-z0-9][A-Za-z0-9-]*)$/;"],
  // Require enabled to be stated and every freshly installed extension is
  // off.
  [SERVER, 'an absent enabled field means enabled',
    '      enabled: record.enabled !== false && !allOff,',
    '      enabled: record.enabled === true && !allOff,'],
  // Treat a broken records file as empty and "your records are broken"
  // reads as "you have no extensions". The parsing lives in the record
  // module, which the roster reads through, so it is broken there.
  [RECORD, 'an unreadable records file is a refusal, never an empty roster',
    '    throw new TypeError(`extension records unreadable: ${e.message}`);',
    '    return [];'],
  // Serve any renderer id and the roster and the payload stop agreeing on
  // what a renderer is.
  // Repointed when a region extension arrived: it declares no renderer and
  // asks without naming one, so the check grew a second half. The rule is
  // unchanged and stricter than it was: naming a renderer is still refused
  // unless the extension actually has it, which spelling the id correctly
  // does not by itself establish.
  [SERVER, 'the one renderer id is the only one served',
    '  if (asksForRenderer && (rendererId !== RENDERER_ID || !declared.match)) {',
    '  if (false) {'],
  // And the other half: asking without naming one is only for an extension
  // that has none. Without this a caller could omit the id and be served any
  // extension's entry.
  [SERVER, 'omitting the renderer id is only for an extension that has none',
    '  if (!asksForRenderer && !declared.draws) {',
    '  if (false) {'],
  // Resolve a declared stylesheet with a bare join and a manifest naming a
  // path outside the directory serves the workspace's own files.
  [SERVER, 'a declared stylesheet is read only from inside the extension\'s directory',
    '    const stylePath = insideOrNull(dir, declaredStyle);',
    '    const stylePath = path.resolve(dir, declaredStyle);'],
  // Drop the record's copy of the styles and an installed directory without
  // a root manifest serves its entry bare, with the declared palette gone.
  [SERVER, 'the record supplies the styles when the installed directory carries no manifest',
    '  const styles = shipped && shipped.styles !== undefined ? shipped.styles : record.styles;',
    '  const styles = shipped && shipped.styles !== undefined ? shipped.styles : undefined;'],

  // Restore the fixed filter and a file an installed extension renders is
  // never listed, so the roster's claim can never be opened from the tree.
  [TREE, 'the tree lists what an enabled record claims, beside the built-in kinds',
    '      } else if (VIEWABLE_FILE_RE.test(item.name) || (claimed && claimed.test(item.name))) {',
    '      } else if (VIEWABLE_FILE_RE.test(item.name)) {'],
  // Stop the freshness pass reading the records file and a disabled record
  // goes on being listed until some directory happens to change.
  [TREE, 'a records change alone makes the cached tree stale',
    '  if (_treeCache.records !== extensionRecordsMtime()) return false;\n',
    ''],

  // ===== THE INIT MESSAGE =====
  // Strip the file from init and a renderer has nothing to render.
  [HOST, 'init carries the opened file and the theme',
    "      send({ type: 'init', path: filePath, content, theme: currentTheme(doc), sources, state: viewState });",
    "      send({ type: 'init' });"],
  // Drop the cap and any size of file is handed to a frame.
  [HOST, 'text over the cap is never handed to a frame',
    '  if (content.length > MAX_INIT_CONTENT_CHARS) {',
    '  if (false) {'],
  // Move the cap without the document and the two promise different limits.
  [HOST, 'the document states the cap the host enforces',
    'export const MAX_INIT_CONTENT_CHARS = 2000000;',
    'export const MAX_INIT_CONTENT_CHARS = 2000001;'],
  // Hard-code the theme and a light page tells its frames it is dark.
  [HOST, 'the theme is read from the body class at mount time',
    "  return doc.body && doc.body.classList.contains('light') ? 'light' : 'dark';",
    "  return 'dark';"],

  // ===== THE PALETTE =====
  // Drop the token block and a stylesheet written in var(--accent) renders
  // as nothing: the palette never reaches the frame.
  [HOST, 'the host\'s tokens are inlined into the frame',
    "  const tokens = tokenCss ? `<style data-rundock-tokens>${neutraliseClose(tokenCss, 'style')}</style>` : '';",
    "  const tokens = '';"],
  // Put the tokens after the extension's styles and the extension can no
  // longer read them where the cascade needs them first.
  // Repointed when the base stylesheet joined the frame. The order is tokens,
  // floor, extension, and the half that is load-bearing is the LAST one: the
  // floor and an extension's own styles are both element rules, so whichever
  // is written second wins, and the extension has to be able to override the
  // floor deliberately. Moving the extension to the front is what breaks it.
  //
  // The tokens' position is NOT part of that contract, and a row asserting it
  // was written here and removed. A custom property resolves at computed-value
  // time wherever it is declared, so the floor reads --base whether the tokens
  // came before it or after. The mutation written to "prove" the ordering
  // deleted the floor instead, which trips the tests for the floor existing
  // as well as any for its position, and a mutation that breaks two guards
  // proves nothing about either.
  [HOST, 'the tokens come ahead of the extension\'s own styles',
    "  const styles = tokens + base + uiCss + (payload.styles || [])\n    .map((css) => `<style>${neutraliseClose(css, 'style')}</style>`).join('');",
    "  const styles = (payload.styles || [])\n    .map((css) => `<style>${neutraliseClose(css, 'style')}</style>`).join('') + tokens + base + uiCss;"],
  // Read values from anywhere but the computed style and the injected
  // palette stops following the theme and the palette that is actually
  // showing.
  [HOST, 'the token values are read out of the computed style at frame build',
    '    const value = computed.getPropertyValue(name).trim();',
    "    const value = '';"],
  // Ignore the flip and a mounted frame keeps the old theme's palette for
  // as long as the file stays open.
  // Rebuild a view that said it handles theme and it loses what it has not
  // yet saved: the in-place restyle is the whole point of the message.
  [HOST, 'a view that handles theme is restyled in place, not rebuilt',
    '    if (handlesTheme && initSent) {',
    '    if (false) {'],
  // Let the frame take a theme message from any window and anything that can
  // post into it can repaint the view.
  [HOST, 'the frame applies a theme message only from its parent',
    "  + 'if(e.source!==parent||!e.data||e.data.type!==\"theme\")return;'",
    "  + 'if(!e.data||e.data.type!==\"theme\")return;'"],
  [HOST, 'a theme change while mounted rebuilds the frame with the new values',
    '    if (!alive || currentTheme(doc) === mountedTheme) return;',
    '    return;'],

  // ===== THE FILE DECIDES, FOR AS LONG AS IT IS OPEN =====
  // Skip the claim question in the reconcile and a roster that leaves the
  // version alone keeps a mount the file no longer claims.
  [FILES, 'the reconcile asks the file before it keeps a mount',
    "  if (standing.action === 'released' || standing.action === 'reclaimed') return standing;\n",
    ''],
  // Skip it when a write lands and a view that wrote its own marker out keeps
  // drawing, and saving to, a file that no longer claims it.
  [APP, 'a landed write to the open file asks the claim again',
    '      if (d.path === currentFilePath) recheckExtensionClaim();\n',
    ''],

  // ===== THE ROSTER JOIN =====
  [APP, 'the roster is registered through the registry module\'s own constructor',
    '    registry.registerFromRoster(roster);\n',
    ''],
  // Drop the sequence guard and the roster whose module resolves last wins,
  // whichever workspace it came from.
  [APP, 'the last roster is the truth, whatever order the module loads resolve',
    '    if (seq !== extensionRosterSeq) return null;\n',
    ''],
  // Keep the previous registry on an error and the old workspace's claims
  // answer for the new one.
  [APP, 'a roster error installs an empty registry, never the previous one',
    '  return installRendererRegistry((mod) => mod.createRendererRegistry({ unavailable: reason }));',
    '  return Promise.resolve(null);'],
  [APP, 'the roster is requested in the startup batch',
    "  ws.send(JSON.stringify({ type: 'list_extensions' }));\n",
    ''],
  [APP, 'every roster arrival reconciles the live mount',
    '    if (registry) reconcileExtensionMount(roster);\n',
    ''],
  [APP, 'a roster reply reaches the registry through the dispatch',
    "    case 'extensions': extensionRosterArrived(d.extensions); if (typeof packagesReplyArrived === 'function') packagesReplyArrived(d); break;\n",
    ''],
  // Read a missing roster as a roster of none and a reply without one
  // replaces a good registry with an empty one and tears the live mount
  // down under a false reason.
  [APP, 'a reply without a roster array is nothing to reconcile, never a roster of none',
    '  if (!Array.isArray(roster)) return Promise.resolve(null);\n',
    '  if (!Array.isArray(roster)) roster = [];\n'],
  [REGISTRY, 'an empty registry carries the roster failure as every answer\'s reason',
    '      if (unavailable) return { registered: false, reason: unavailable };\n',
    ''],

  // ===== A MARKER CLAIMS A SUBSET, NEVER THE WHOLE CONTAINER =====
  // Pass the path alone and the registry is blind again: a marked-subset
  // claim can never fire, which was the whole gap.
  [FILES, 'the seam hands the registry the content it already holds',
    '  const claim = registry && registry.rendererFor ? registry.rendererFor(path, content) : null;',
    '  const claim = registry && registry.rendererFor ? registry.rendererFor(path) : null;'],
  // Skip the content check and a marker claim never answers: every marked
  // file falls to the bare claim or to nothing.
  [REGISTRY_SPEC, 'a marker claim is decided from the file content, not the path alone',
    `      if (slot.marked.size && typeof content === 'string') {
        for (const key of frontmatterKeys(content)) {
          const marked = slot.marked.get(key);
          // The marker rides on the claim: a view is handed a note's named
          // sources only when it claimed the note by its marker.
          if (marked) return { registered: true, extension: marked.extension, renderer: marked.renderer, marker: marked.declares };
        }
      }
`,
    ''],
  // Yield to the bare claim when one exists and the marker stops beating
  // it: the more specific claim loses on exactly the files it names.
  [REGISTRY_SPEC, 'a marker claim beats a bare claim on the same target',
    '          if (marked) return { registered: true, extension: marked.extension, renderer: marked.renderer, marker: marked.declares };',
    '          if (marked && !slot.bare) return { registered: true, extension: marked.extension, renderer: marked.renderer, marker: marked.declares };'],
  // Blind the core table and an extension declaring kanban-plugin registers:
  // boards would be contested rather than Rundock's.
  [REGISTRY_SPEC, 'the core marker is refused at registration, enforced rather than emergent',
    `          const coreOwner = declares !== null && CORE_MARKERS[target]
            ? CORE_MARKERS[target][declares] : null;`,
    '          const coreOwner = null;'],
  // Let a second claim on one marker overwrite the first and the winner
  // flips silently, with the refusal gone.
  [REGISTRY_SPEC, 'two claims on one marker keep first-claim-wins with the refusal recorded',
    `            if (slot.marked.has(declares)) {
              refusals.push({ extension: ext.id, target, declares,
                reason: \`Files ending "\${target}" and marked "\${declares}" are already rendered by \${slot.marked.get(declares).extension}.\` });
              continue;
            }
`,
    ''],
  // Accept any string as a marker and an unreadable key registers a claim
  // that no frontmatter scan can ever answer.
  [REGISTRY_SPEC, 'a marker outside the key grammar never registers',
    'const MARKER_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;',
    'const MARKER_KEY = /^[\\s\\S]+$/;'],
  // Scan the whole file instead of the closed frontmatter block and a
  // key-shaped line in the body claims the note.
  [REGISTRY_SPEC, 'a marker is read only from the closed frontmatter block, never the body',
    "  for (const line of src.slice(3, 3 + closing.index).split('\\n')) {",
    "  for (const line of src.split('\\n')) {"],
  // Read the declares claim only from a shipped manifest and the path real
  // installs take (no manifest materialized, the record's copy stands in)
  // loses its marker: the extension silently claims nothing.
  [SERVER, 'the record supplies the declares claim when the installed directory carries no manifest',
    "  const declares = shipped && typeof shipped.declares === 'string' ? shipped.declares : record.declares;",
    "  const declares = shipped && typeof shipped.declares === 'string' ? shipped.declares : null;"],
  // Blind the roster's core table and the kanban-plugin claim rides to the
  // client as a working renderer, with no problem line for the row.
  [SERVER, 'the core marker is refused on the roster, so the managed row can say so',
    '      const coreOwner = CORE_MARKERS[renderer.target] ? CORE_MARKERS[renderer.target][renderer.declares] : null;',
    '      const coreOwner = null;'],
  // Forget the holders and both claims on one marker read as working: the
  // loser is computed at the client and dropped, which the install rules forbid.
  [SERVER, 'a second claim on one marker is a named refusal on the roster',
    '      const holder = holders.get(key);',
    '      const holder = null;'],
  // Accept any declares and an unreadable marker silently widens into a
  // bare claim on the whole container.
  [SERVER, 'a declares outside the key grammar never becomes a roster claim',
    '    if (mapped.target && declared.declares && !SLUG.test(declared.declares)) {',
    '    if (false) {'],

  // ===== THE TRANSPORT =====
  // Key by extension alone and two renderers of one extension take each
  // other's payload.
  [APP, 'a fetch is correlated by extension id plus renderer id',
    '  return `${extensionId} ${rendererId}`;',
    '  return String(extensionId);'],
  // Remove the clock and a reply that never comes leaves the pane blank.
  [APP, 'a reply that never comes settles by the clock',
    '    waiter.timer = setTimeout(() => {\n      waiter.settle({ extensionId, rendererId, reason: `no renderer payload arrived within ${timeoutMs}ms` });\n    }, timeoutMs);\n',
    ''],
  [APP, 'a closed socket settles every fetch in flight',
    "      waiter.settle({ reason: 'the connection closed before the renderer payload arrived' });\n",
    ''],

  // ===== TEARDOWN AND RECONCILE =====
  // Keep the file open across a workspace switch and the previous
  // workspace's frame stays in the pane with its mediator listening.
  [APP, 'a different workspace closes the open file, which releases the mount',
    '  closeOpenFile();\n  conversations = [];',
    '  conversations = [];'],
  [FILES, 'the mount is handed the opened file',
    "      // after ready. The host's cap applies here as it does to any caller.\n      path,\n      content,\n",
    ''],
  [FILES, 'an extension absent from the roster is torn down',
    '  if (!entry || entry.enabled === false) {',
    '  if (entry && entry.enabled === false) {'],
  [FILES, 'a disabled extension is torn down',
    '  if (!entry || entry.enabled === false) {',
    '  if (!entry) {'],
  [FILES, 'a different version swaps and the same version is left alone',
    "  if (version === info.version) return { action: 'kept' };",
    "  if (version !== info.version) return { action: 'kept' };"],
  [FILES, 'a swap mounts the freshly fetched payload',
    '    const swapped = mount.swap(payload);',
    '    const swapped = mount;'],
  [FILES, 'a late swap is abandoned when the mount was released meanwhile',
    '    if (token !== extensionSeamToken || activeExtensionMount !== mount) return;\n    if (!payload',
    '    if (!payload'],
  [FILES, 'releasing the mount forgets what was mounted',
    '  activeExtensionMountInfo = null;\n  // The pane gets its padding back',
    '  // The pane gets its padding back'],
  // Route the frame's open around the resolver and a bare name opens the
  // wrong file, or none.
  [FILES, 'the frame\'s open goes through the wikilink resolver',
    '      onOpen: (target) => openWikilink(target),',
    '      onOpen: (target) => openWorkspaceFilePath(target),'],

  // ===== THE STYLESHEET =====
  [SHEET, 'the frame\'s floor is the host\'s floor',
    'min-height: 40px;',
    'min-height: 0;'],
  [SHEET, 'the frame paints its surface through a token',
    'background: var(--elevated);',
    'background: #272727;'],
];

const REPORTER = ['--test-reporter', 'spec'];

function redTests(suite) {
  let out = '';
  let failed = false;
  try {
    out = execFileSync('node', ['--test', ...REPORTER, suite],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const targets = targetsFromRows(MUTATIONS);
  const session = beginMutationRun({ files: [...new Set(targets.map((t) => t.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of rowsForShard(MUTATIONS)) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, red: [] }
        : { label, applied: true, red });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, unparsable } of results) {
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Tests red | Which |');
    console.log('|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(NO_VERDICT);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const results = run();
  const failed = report(results, process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(exitCodeFor(failed, results));
  }
}

module.exports = { MUTATIONS, run };
