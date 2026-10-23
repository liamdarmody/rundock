#!/usr/bin/env node
'use strict';
// Break each rule behind links in frontmatter, and creating a note from a
// link to a missing one, in turn, and report which tests notice.
//
// What a value shows as a link, what stays escaped text, when the raw YAML is
// trusted for an unquoted link's name, where a new note may be made and that
// it is made once and never over a note already there: every one of those
// rules can be deleted with the product still drawing SOMETHING, which is why
// each is broken on purpose here and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-frontmatter-links-guards.js            # report
//   node test/tools/mutate-frontmatter-links-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The harness
// is the same shape as its siblings, deliberately a separate copy: pulling
// them together means editing instruments already in the gate.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');
const at = (...p) => path.join(ROOT, ...p);
const PANEL_SUITE = 'test/unit/frontmatter-links.test.js';

const LINKS = { src: at('public', 'editor', 'markdown', 'prop-links.js'), suite: PANEL_SUITE };
const RAW = { src: at('public', 'editor', 'markdown', 'frontmatter-edit.js'), suite: PANEL_SUITE };
const PANEL = { src: at('public', 'editor', 'panels', 'properties.js'), suite: PANEL_SUITE };
const PANEL_XSS = { src: at('public', 'editor', 'panels', 'properties.js'), suite: 'test/unit/callouts-and-properties.test.js' };
const EDITOR = { src: at('public', 'editor', 'index.js'), suite: PANEL_SUITE };
const DELEGATE = { src: at('public', 'editor', 'index.js'), suite: 'test/unit/wikilink-delegate.test.js' };
const BODY = { src: at('public', 'editor', 'plugins', 'missing-links.js'), suite: PANEL_SUITE };
const CREATE = { src: at('public', 'views', 'files.js'), suite: 'test/unit/link-create.test.js' };
const HOST_RESOLVER = { src: at('public', 'views', 'files.js'), suite: PANEL_SUITE };
const APP = { src: at('public', 'app.js'), suite: 'test/unit/link-create.test.js' };
// The rules only the server can keep: it is the last thing between a click
// and an existing note's bytes, so the booted-server suite watches it.
const SERVER = { src: at('lib', 'protocol', 'handlers', 'files.js'), suite: 'test/integration/create-path-exclusive.test.js' };
const SERVER_UNIT = { src: at('lib', 'protocol', 'handlers', 'files.js'), suite: 'test/unit/protocol-handlers-lib.test.js' };
const CREATE_GUARD = { src: at('server.js'), suite: 'test/unit/create-path-guard.test.js' };

const MUTATIONS = [
  // ===== WHAT IS A LINK: THE MAP'S GRAMMAR =====
  [LINKS, 'an embed is not a link, as the Map does not count it',
    "    if (m[1] === '!') continue;\n",
    ''],
  [LINKS, 'a link inside code is not a link',
    "  const masked = src.replace(CODE_SPAN_RE, (m) => ' '.repeat(m.length));",
    '  const masked = src;'],

  // ===== THE UNQUOTED-LINK SHAPE GATE =====
  // The raw text is trusted for a name only when the parse has the one shape
  // an unquoted [[X]] gives, and only when the link is all that was written.
  [LINKS, 'the raw text is read only for a parse of exactly one list holding one list',
    '  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0])) return null;',
    '  if (!Array.isArray(parsed)) return null;'],
  [LINKS, 'nothing but a comment may follow an unquoted link',
    "  if (segs.length > 2 || (segs.length === 2 && !/^\\s+#/.test(segs[1].text))) return null;",
    ''],
  [RAW, 'only a list\'s own items count, not dashes nested inside them',
    '    .filter((l) => l.search(/\\S/) === indent)\n',
    ''],
  [PANEL, 'the panel reads an unquoted link from the raw YAML',
    '    const unquoted = written ? unquotedLinkText(parsedValue, written.inline) : null;',
    '    const unquoted = null;'],
  [EDITOR, 'the editor hands the panel the raw block',
    '{ ...panelOpts, raw: parts.raw }',
    'panelOpts'],

  // ===== NO EDIT OFFERED THAT CAN ONLY SNAP BACK =====
  [RAW, 'a value with a comment beside it is refused up front, with the reason',
    "  if (/(?:^|\\s)#/.test(unquoted)) return 'This value has a comment beside it in the file, so it is edited there, where the comment is kept.';\n",
    ''],
  [PANEL, 'the panel offers no edit the file would refuse',
    '    const editable = onEditProperty && !refusal && [',
    '    const editable = onEditProperty && ['],

  // ===== ESCAPING AROUND IN-TEXT LINKS =====
  [PANEL, 'the words around a link are escaped',
    '<span class="prop-text" data-at="${start}">${escapeHtml(seg.text)}</span>',
    '<span class="prop-text" data-at="${start}">${seg.text}</span>'],
  [PANEL, 'a link\'s alias is escaped',
    '>${escapeHtml(display)}</a>',
    '>${display}</a>'],
  [PANEL_XSS, 'a link\'s target is escaped into its attribute',
    'data-target="${escapeHtml(link.target)}"',
    'data-target="${link.target}"'],

  // ===== CLICKING =====
  [PANEL, 'a click on the words puts the caret where it landed',
    "  return Number(run.getAttribute('data-at')) + offset;",
    '  return null;'],
  [PANEL, 'a missing link in the panel creates its note rather than opening nothing',
    "    const go = el.classList.contains('dead') ? st.onCreateWikilink : st.onWikilinkClick;",
    '    const go = st.onWikilinkClick;'],
  [DELEGATE, 'a missing link in the body creates its note too',
    '    if (missing) onCreateWikilink(target);\n    else onWikilinkClick(target, alias);',
    '    onWikilinkClick(target, alias);'],
  [BODY, 'a body link to a missing note is marked',
    "      if (node.type.name === 'wikilink' && missing(node.attrs.target)) {",
    '      if (false) {'],
  [BODY, 'a link added while editing is marked too',
    '      apply: (tr, set) => (tr.docChanged ? decorate(tr.doc) : set),',
    '      apply: (tr, set) => set,'],

  // A link to a heading in the same note names no note, so it is never
  // missing: without this it draws dashed in the panel and the body.
  [HOST_RESOLVER, 'a link to a heading in the same note is never missing',
    "  if (!tree || !String(target).split('#')[0].trim()) return true;",
    '  if (!tree) return true;'],

  // ===== NEVER OUTSIDE THE WORKSPACE =====
  [CREATE, '. and .. are refused as leaving the workspace',
    "  if (segments.some((s) => s === '.' || s === '..')) return { refusal: 'That link points outside this workspace.' };\n",
    ''],
  [CREATE, 'no name, folder or traversal starting with a dot is made',
    "  if (segments.some((s) => s === '.' || s === '..')) return { refusal: 'That link points outside this workspace.' };\n"
      + "  if (segments.some((s) => !s.trim())) return { refusal: 'A folder in that link has no name.' };\n"
      + "  if (segments.some((s) => s.startsWith('.'))) return { refusal: 'Note and folder names cannot start with a dot.' };\n",
    ''],
  [CREATE, 'a character a file name cannot hold is refused',
    "  if (LINK_NAME_FORBIDDEN_RE.test(name)) return { refusal: 'Note and folder names cannot contain : * ? \" < > |, a backslash or a control character.' };\n",
    ''],
  [CREATE, 'a control character is refused, so a NUL never reaches the server',
    String.raw`const LINK_NAME_FORBIDDEN_RE = /[:*?"<>|\\\u0000-\u001f\u007f-\u009f]/;`,
    String.raw`const LINK_NAME_FORBIDDEN_RE = /[:*?"<>|\\\u007f-\u009f]/;`],
  [CREATE, 'DEL and the C1 controls are refused too',
    String.raw`const LINK_NAME_FORBIDDEN_RE = /[:*?"<>|\\\u0000-\u001f\u007f-\u009f]/;`,
    String.raw`const LINK_NAME_FORBIDDEN_RE = /[:*?"<>|\\\u0000-\u001f]/;`],
  [CREATE, 'a refused name says nothing was made and what to do',
    "showLinkNotice('That note cannot be created', where.refusal, true, NOTHING_CREATED);",
    "showLinkNotice('That note cannot be created', where.refusal, true);"],
  [CREATE, 'a refusal from the server says the same',
    'String(msg.reason), true, NOTHING_CREATED);',
    'String(msg.reason), true);'],
  [CREATE, 'only a note is made from a link',
    "  if (!/\\.md$/i.test(file)) return { refusal: 'Only notes can be made from a link, and this one names another kind of file.' };\n",
    ''],
  [CREATE, 'a bare name goes beside its note, a path counts from the root',
    '  const folder = segments.length > 1 || !fromPath ?',
    '  const folder = !fromPath ?'],

  // ===== ONCE, AND NEVER OVER A NOTE ALREADY THERE =====
  [CREATE, 'a second click while a create is on its way sends nothing',
    '  if (pendingLinkCreates.has(where.path)) return;\n',
    ''],
  [CREATE, 'a click while the connection is closed says so',
    "    showLinkNotice('Not connected', 'Nothing was sent. Try again once the connection returns.', true);\n",
    ''],
  [CREATE, 'a lost connection clears the creates it was carrying',
    '  pendingLinkCreates.clear();',
    ''],
  [APP, 'the socket close handler clears a link\'s pending creates',
    ' linkCreatesConnectionLost();',
    ''],
  [CREATE, 'a note that already exists is opened instead',
    "  if (msg.type === 'path_created' || msg.reason === 'already exists') openWorkspaceFilePath(msg.path);",
    "  if (msg.type === 'path_created') openWorkspaceFilePath(msg.path);"],
  [CREATE, 'only an answer a link asked for is taken from the caller',
    '  if (!pendingLinkCreates.delete(msg.path)) return false;',
    '  pendingLinkCreates.delete(msg.path);'],
  // Without `wx` the write follows a dangling link out of the workspace and
  // empties a file another writer made after any check.
  [SERVER, 'the create is exclusive: nothing already at the path is written over',
    "fs.writeFileSync(full, msg.content || '', { encoding: 'utf-8', flag: 'wx' });",
    "fs.writeFileSync(full, msg.content || '', 'utf-8');"],
  [SERVER, 'something already at the path is answered as already there',
    "          if (e && e.code !== 'EEXIST') throw e;",
    '          throw e;'],
  [SERVER_UNIT, 'a failure no errno rule describes still gets a plain sentence of its own',
    ", fallback: `Rundock couldn't create the ${what}.` });",
    ' });'],
  [SERVER_UNIT, 'a failed create sends a plain sentence, never the raw error and its path',
    'reason: r.message, system: true }',
    'reason: r.message, detail: r.detail, system: true }'],
  [CREATE_GUARD, 'the server splits a created path on backslashes too, as Windows does',
    String.raw`  const segments = rel.split(/[\\/]/).filter(Boolean);`,
    "  const segments = rel.split('/').filter(Boolean);"],
  [SERVER_UNIT, 'a failed create takes away the empty folders it made',
    '          if (made) removeEmptyFoldersUpTo(path.dirname(full), made);\n',
    ''],
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
    // than thrown, so the report says which mutation was in flight.
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
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
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
      // A guard that matches more than once is refused rather than taking the
      // first: it would break whichever came first and report on that.
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

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT. A full temp root
// surfaces as tests going red, and red tests are exactly what this instrument
// reports as a guard somebody was watching.
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
