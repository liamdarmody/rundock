#!/usr/bin/env node
'use strict';
// Take the package update's guards apart one at a time and report which
// tests notice. An update decides, for every item a person may have worked
// on, whether the author's version is written over it; every rule that keeps
// the person's work, carries their routine switches, lands everything as one
// transaction or refuses a release that is not newer could be deleted with
// the happy path still green unless a test is proven to notice.
//
//   node test/tools/mutate-package-update-guards.js            # report
//   node test/tools/mutate-package-update-guards.js --markdown # as a table
//
// Same shape as the sibling harnesses, and a copy rather than a shared
// module for the reason mutate-atomic-write-guards.js gives.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const FINGERPRINT = { src: path.join(ROOT, 'lib', 'packages', 'package-fingerprint.js'), suite: 'test/unit/package-fingerprint.test.js' };
const STATE = { src: path.join(ROOT, 'lib', 'packages', 'package-state.js'), suite: 'test/unit/package-state.test.js' };
// A link inside a package folder is proven where it matters: the uninstall keeps it.
const STATE_UNINSTALL = { src: path.join(ROOT, 'lib', 'packages', 'package-state.js'), suite: 'test/unit/package-uninstall.test.js' };
const CHECK = { src: path.join(ROOT, 'lib', 'packages', 'package-check.js'), suite: 'test/unit/package-check.test.js' };
const CLASSIFY = { src: path.join(ROOT, 'lib', 'packages', 'update-classify.js'), suite: 'test/unit/update-classify.test.js' };
const CARRY = { src: path.join(ROOT, 'lib', 'packages', 'routine-carry.js'), suite: 'test/unit/routine-carry.test.js' };
const EVALUATE = { src: path.join(ROOT, 'lib', 'packages', 'import-evaluate.js'), suite: 'test/unit/package-import-evaluate.test.js' };
const APPLY = { src: path.join(ROOT, 'lib', 'packages', 'import-apply.js'), suite: 'test/unit/package-import-apply.test.js' };
const PLAN = { src: path.join(ROOT, 'lib', 'packages', 'package-update-plan.js'), suite: 'test/unit/package-update-plan.test.js' };
const EXTRAS = { src: path.join(ROOT, 'lib', 'packages', 'package-update-apply.js'), suite: 'test/unit/package-update-wire.test.js' };
const WIRE = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'packages.js'), suite: 'test/unit/package-update-wire.test.js' };
const CHECK_WIRE = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'packages.js'), suite: 'test/unit/package-update-check.test.js' };
// The tag lister the check runs, proved at the wire against a real repository.
const TAG_LISTER = { src: path.join(ROOT, 'lib', 'packages', 'extension-source.js'), suite: 'test/unit/package-update-check.test.js' };
const MODEL = { src: path.join(ROOT, 'public', 'packages-update-model.js'), suite: 'test/unit/packages-update-model.test.js' };
const PAGE = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/packages-manage.test.js' };
const UNINSTALL = { src: path.join(ROOT, 'lib', 'packages', 'package-uninstall.js'), suite: 'test/unit/package-uninstall.test.js' };
const UNINSTALL_WIRE = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'packages.js'), suite: 'test/unit/package-uninstall.test.js' };
const DISPLAY = { src: path.join(ROOT, 'lib', 'packages', 'display-name.js'), suite: 'test/unit/package-display-name.test.js' };
const SERVER = { src: path.join(ROOT, 'server.js'), suite: 'test/unit/workspace-open-recovery.test.js' };
const APPROVAL = { src: path.join(ROOT, 'lib', 'packages', 'import-apply.js'), suite: 'test/unit/package-routine-approval.test.js' };
const APPROVAL_WRITE = { src: path.join(ROOT, 'lib', 'agents', 'routines.js'), suite: 'test/unit/package-routine-approval.test.js' };
// Where the receipt's "no longer carried" mark is read back and written.
const RECEIPT_READ = { src: path.join(ROOT, 'lib', 'packages', 'extension-manage.js'), suite: 'test/unit/package-state.test.js' };
const RETIRED = { src: path.join(ROOT, 'lib', 'packages', 'import-apply.js'), suite: 'test/unit/package-update-wire.test.js' };
// The link typed into Packages, proved by the "a redraw while the person
// types keeps the typed link" tests.
const TYPED_LINK = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/extension-install.test.js' };
// A plain link's pin, proved at the wire by the install tests.
const INSTALL_WIRE = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'packages.js'), suite: 'test/unit/extension-install.test.js' };

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  // ===== WHAT RUNDOCK WRITES INTO AN AGENT IS NOT AN EDIT =====
  [FINGERPRINT, 'the routine state Rundock writes is left out of the authored fingerprint',
    '      if (STATE_LINE.test(lines[i])) drop.add(i);', ''],
  [FINGERPRINT, 'only inside the routines section: the same word elsewhere is content',
    '  const kept = lines.filter((_, i) => !drop.has(i)).join',
    '  const kept = lines.filter((l, i) => !drop.has(i) && !STATE_LINE.test(l)).join'],

  // ===== THE BASE IS WHAT THIS PACKAGE LAST WROTE =====
  [STATE, 'a later skip wrote nothing, so the earlier base stands',
    '      if (item.fingerprint) {', '      if (!item.fingerprint) known.base = null;\n      if (item.fingerprint) {'],
  [STATE, 'a package from a folder is never checked for updates',
    'updatable: LINK_SOURCE.test(id)', 'updatable: true'],

  [STATE, "a card compares an agent on what its author wrote, so a routine switched on is not a change",
    "    now = item.kind === 'agent' ? authoredDigest('agent', bytes) : digestFile(bytes);", '    now = digestFile(bytes);'],
  [STATE, 'a card never counts an item that is gone',
    "      if (item.state === 'absent') continue;\n", ''],

  // ===== ONLY A NEWER RELEASE =====
  [CHECK, 'only a tag strictly newer than the installed one is offered',
    'compareSemver(parts, pin) > 0', 'compareSemver(parts, pin) >= 0'],
  [CHECK, 'a package installed at a commit is never offered an update',
    "  if (!pin) return { ...base, outcome: 'no-release' };\n",
    "  if (!pin) return { ...base, outcome: 'newer-available', newer: listing.map((t) => t.name) };\n"],
  [CHECK, 'a tag the author moved is named',
    'same.commit !== pkg.commit', 'false'],
  // Report an annotated tag's own object id and every annotated release
  // reads as moved, since that id never equals the commit that was installed.
  [TAG_LISTER, "an annotated tag is compared on the commit it peels to, never its tag object",
    'commit: peeled.get(name) || plain.get(name)', 'commit: plain.get(name)'],
  // List with --refs and the peeled lines never arrive, so moved-tag
  // detection compares the installed commit with a tag object.
  [TAG_LISTER, 'moved-tag detection reads the peeled line git gives only without --refs',
    "'ls-remote', '--tags', url]", "'ls-remote', '--tags', '--refs', url]"],
  [WIRE, 'an update that carries an extension is refused unless it arrived at a tag or a commit',
    "      requireFixedPin(source, extensionDeps.pinKindOf(snapshot)); // an update is code, held to the install's rule\n", ''],
  [WIRE, "an update whose extension declares another name is refused",
    '      if (pkg.extension && extension.manifest.name !== pkg.extension) {', '      if (false) {'],
  [WIRE, 'the server plans only a release the check reports newer',
    '    if (!status.newer.includes(source.reference)) {', '    if (false) {'],

  // ===== THE PERSON'S WORK IS KEPT =====
  [CLASSIFY, 'what both sides changed is kept, never overwritten',
    ": out('both-changed', 'skip', true)", ": out('both-changed', 'overwrite', true)"],
  [CLASSIFY, "the author's version of what both changed is saved for review",
    "out('both-changed', 'skip', true)", "out('both-changed', 'skip')"],
  [CLASSIFY, 'what the person removed stays removed',
    "    if (base) return out('removed-by-you', 'skip');\n", ''],
  [CLASSIFY, 'a version that gains a key acting without asking is not written',
    "  if (gainsUnasked) return out('acts-without-asking', 'skip', true);\n", ''],
  [CLASSIFY, 'a starter file is never replaced',
    ": out('starter-alongside', 'skip');", ": out('starter-alongside', 'overwrite');"],
  [PLAN, 'a kept item is approved at the bytes already there',
    '  let approvedDigest = skip ? item.plannedDigest : item.approvedDigest;', '  let approvedDigest = item.approvedDigest;'],
  [PLAN, 'a changed starter template arrives alongside',
    '  const copies = placeAlongside(snapshot, changedStarters, source.reference);',
    '  const copies = placeAlongside(snapshot, [], source.reference);'],
  [PLAN, 'an adoption recorded at install is applied to the new version',
    '  const shaped = transform && transform.adoptUnder ?', '  const shaped = false ?'],

  // ===== THE PERSON'S ROUTINE SWITCHES SURVIVE =====
  [CARRY, "the switches land on the author's routine",
    '    next = updateRoutineBlock(next, name, fields, occurrence);\n', ''],
  [CARRY, 'a switch that did not land is a refusal',
    "      if (!landed || landed.raw[key] !== value) throw", '      if (false) throw'],
  [EVALUATE, 'a carried routine state is validated',
    '  if (value.routineState !== undefined) validateRoutineState(', '  if (false) validateRoutineState('],
  [EVALUATE, 'a carried routine state reaches the adapter',
    '  if (item.kind === \'agent\' && item.agent.routineState !== undefined) outcome.routineState = item.agent.routineState;', ''],
  [APPLY, 'the adapter writes the carried switches',
    '    const landed = write.routineState', '    const landed = false'],

  // ===== APPROVALS NEVER TRAVEL WITH A PACKAGE =====
  [APPROVAL, 'every agent a package lands has its shipped approvals replaced',
    '  return withRundockApprovals(addProvenance(text, sourceId));', '  return addProvenance(text, sourceId);'],
  [APPROVAL, 'only a routine the card says will run itself is approved by Rundock',
    '  const next = replaceApprovals(normal, runsItself);', '  const next = replaceApprovals(normal, () => true);'],
  [APPROVAL_WRITE, 'a shipped approval is never kept',
    '    const hash = approves(routine) ? computePlanHash(routine) : APPROVAL_PENDING;',
    '    const hash = block.planApprovedHash || (approves(routine) ? computePlanHash(routine) : APPROVAL_PENDING);'],

  // ===== ONE TRANSACTION =====
  [APPLY, "an update's extras ride the one transaction",
    '    writes.push(...(more.writes || []));\n', ''],
  [WIRE, 'the server applies the plan it holds, never one the client sends',
    '    const approval = pending.update && pending.update.approval;',
    '    const approval = msg.approval || (pending.update && pending.update.approval);'],
  [WIRE, 'an update waits for a running routine of an agent it rewrites',
    '    const busy = approval ? runningAffected(approval) : [];', '    const busy = [];'],
  [EXTRAS, "the author's version of a kept item is saved",
    '        if (!entry.saveAuthor) continue;', '        continue;'],
  [EXTRAS, 'what an update replaces is backed up',
    '      if (planned.get(write.id) === ABSENT_DIGEST) continue;', '      continue;'],
  [SERVER, 'an interrupted transaction is recovered when its workspace opens',
    '    try { recoverPendingWrites(dir); }', '    try { void dir; }'],

  // ===== UNINSTALL TAKES ONLY WHAT NOBODY CHANGED =====
  [UNINSTALL, 'an item the person edited stays',
    "    else if (item.state === 'as-installed') goes.push(entry(item));\n    else stays.push(entry(item, 'edited'));",
    '    else goes.push(entry(item));'],
  [UNINSTALL, 'every starter file stays, touched or not',
    "    if (item.kind === 'starter') stays.push(entry(item, 'starter'));",
    "    if (item.kind === 'starter' && item.state !== 'as-installed') stays.push(entry(item, 'starter'));"],
  [STATE_UNINSTALL, 'a package folder holding a link is the person\'s, kept and never walked',
    "    try { now = digestDirectory(absolute); } catch (e) { if (e instanceof TypeError) return 'changed'; throw e; }",
    '    now = digestDirectory(absolute);'],
  [UNINSTALL, 'a confirm that no longer matches the plan removes nothing',
    '  if (plan.key !== key) {', '  if (false) {'],
  [UNINSTALL, "the package's receipts go, so it leaves the list",
    ', ...plan.receipts.map((r) => at(workspace, r))]', ']'],
  [UNINSTALL, 'only this package\'s receipts go',
    '.filter((r) => r.source && r.source.id === id)', '.filter((r) => r.source)'],
  [UNINSTALL, 'the extension record leaves with its folder',
    'records.filter((r) => r.name !== plan.extension.name)', 'records'],
  [UNINSTALL, 'everything leaves in one transaction',
    '  writeAsUnit(workspace, writes, { removes, afterStep: options.afterStep });',
    '  writeAsUnit(workspace, writes, { afterStep: options.afterStep }); writeAsUnit(workspace, [], { removes });'],
  [UNINSTALL_WIRE, 'an uninstall waits for a running routine of an agent it removes',
    "    const busy = extensionDeps.runningRuns().filter((run) => removing.has(run.agent));",
    "    const busy = [];"],

  // ===== A PACKAGE'S NAME IS PLAIN TEXT =====
  [DISPLAY, 'a display name carries no markup, line break or control character',
    '    && !/[<>\\x00-\\x1f\\x7f]/.test(value);', ';'],

  // ===== CHECKS ONLY WHEN ASKED, AND NEVER ALL AT ONCE =====
  [CHECK_WIRE, "a repository's releases are reused for an hour",
    'if (hit && extensionDeps.now() - hit.at < PACKAGE_CHECK_TTL_MS)', 'if (false)'],
  [CHECK_WIRE, 'git runs one package at a time',
    '  const run = packageCheckQueue.then(() => extensionDeps.listTagCommits(url));',
    '  const run = Promise.resolve(extensionDeps.listTagCommits(url));'],
  // Run git synchronously, with the same arguments and the same answer, and
  // the server's one thread waits on the network for every check.
  [TAG_LISTER, 'the update check never holds the server while git runs',
    "    execFile('git', [...GIT_LOW_SPEED, 'ls-remote', '--tags', url], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: GIT_ENV }, (error, stdout) => {",
    "    ((file, args, options, done) => { let out; try { out = execFileSync(file, args, options); } catch (e) { done(e); return; } done(null, out); })('git', [...GIT_LOW_SPEED, 'ls-remote', '--tags', url], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: GIT_ENV }, (error, stdout) => {"],

  // ===== THE PAGE =====
  [PAGE, 'Packages checks for updates when it opens',
    "  if (section === 'packages' && packagesUpdate) packagesUpdateApply(updateModel().checkAll(packagesUpdate));\n", ''],
  [PAGE, 'the update review opens inside its card',
    "      ${c.review ? packagesUpdateReviewHtml(c.review) : ''}", "      ${''}"],
  [PAGE, 'Clear asks before it sends',
    '  if (!packagesClearAsked) { packagesClearAsked = true; packagesRenderIfVisible(); return; }\n', ''],
  // A redraw that arrives while a link is being typed (an update check
  // finishing, say) puts back what was typed; a change of workspace clears it.
  [TYPED_LINK, 'a redraw of the packages section restores the link being typed',
    '    packagesTypingRestore(el, typing);\n',
    ''],
  [TYPED_LINK, 'the typed link is what the restore puts back',
    '  field.value = typing.value;\n',
    ''],
  [TYPED_LINK, 'a change of workspace empties the typed link',
    "  if (field) field.value = '';\n",
    ''],
  // Drop the pin and a plain link to agents and skills with no version tags
  // is planned and recorded at no reference, not at the commit installed.
  [INSTALL_WIRE, 'a plain content link with no version tags is pinned to the commit fetched',
    '      source = { ...source, reference: headCommit };\n',
    ''],
  [MODEL, 'confirm sends only the token',
    "send: { type: 'confirm_package_update', token: state.review.token, requestId },",
    "send: { type: 'confirm_package_update', token: state.review.token, requestId, approval: state.review.approval },"],
  [MODEL, 'a package installed at a commit says how to get the latest, and offers no check',
    "if (!SEMVER.test(card.reference || '')) return { text: 'Installed from a commit. Paste the link again to get the latest.', tone: 'neutral' };",
    "if (!SEMVER.test(card.reference || '')) return { text: 'Installed from a commit.', tone: 'neutral' };"],
  [UNINSTALL, 'the extension folder removed is built from the record\'s name, never its stored root',
    'root: `${EXTENSIONS_ROOT}/${card.extension.name}` }',
    "root: (require('./extension-record.js').readExtensionRecords(workspace).find((r) => r.name === card.extension.name) || {}).root || `${EXTENSIONS_ROOT}/${card.extension.name}` }"],
  // Drop the absent line and an item that is gone is offered as a link to a
  // file that is not there, unmarked.
  [MODEL, 'an item that is gone is marked removed and never linked',
    "        if (i.state === 'absent') return { label: i.label, kind, open: null, target: null, mark: 'removed' };\n", ''],
  [MODEL, 'uninstall confirms the plan it was shown, by its key',
    "      send: { type: 'confirm_package_uninstall', source: u.id, key: u.plan.key, requestId },",
    "      send: { type: 'confirm_package_uninstall', source: u.id, requestId },"],

  // ===== WHAT AN UPDATE'S NEW VERSION NO LONGER CARRIES =====
  // Each link of the chain from the plan's retired group to the package's
  // state: the wire hands it to the apply, the apply writes it into the
  // receipt, the receipt reader keeps the mark only where it is honest, and
  // the state reads it as no longer carried.
  [STATE, 'an item the receipt marks as no longer in the package is not carried',
    '      known.carried = item.inPackage !== false;',
    '      known.carried = true;'],
  [RECEIPT_READ, 'the no-longer-carried mark is honoured only on a kept entry',
    "      if (item.outcome === 'kept' && i.inPackage === false) item.inPackage = false;",
    '      if (i.inPackage === false) item.inPackage = false;'],
  [RETIRED, 'the receipt lists what the new version no longer carries',
    '    ...retiredEntries(update && update.retired),\n',
    ''],
  [WIRE, 'the update hands its retired group to the apply',
    ', retired: pending.update.groups.retired || [] }',
    ' }'],
  // Without it an approval sent back naming another reference applies, and
  // the receipt records that reference as what was installed.
  [INSTALL_WIRE, 'an install confirm is refused when its source is not the one offered',
    '    if (!sameSource(msg.approval && msg.approval.source, pending.plan.source)) {',
    '    if (false) {'],
];

const NOT_MUTATED = [];

const REPORTER = ['--test-reporter=spec', '--test-reporter-destination=stdout'];

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
  if (marker === -1) return failed ? { unparsable: true } : [];
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const files = [...new Set(MUTATIONS.map(([t]) => t.src))];
  const session = beginMutationRun({ files });
  const originals = new Map(files.map((file) => [file, session.original(file)]));
  const results = [];
  try {
    for (const [t, label, guard, without] of MUTATIONS) {
      const original = originals.get(t.src);
      const matches = original.split(guard).length - 1;
      if (matches !== 1) {
        results.push({ label, applied: false, ...(matches > 1 ? { ambiguous: matches } : {}), red: [] });
        continue;
      }
      fs.writeFileSync(t.src, original.replace(guard, without));
      const red = redTests(t.suite);
      results.push(red && red.unparsable ? { label, applied: true, matches, unparsable: true, red: [] } : { label, applied: true, matches, red });
      fs.writeFileSync(t.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, matches, unparsable } of results) {
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | ${matches} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | ${ambiguous} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | 0 | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | ${matches} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${matches} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  found in ${matches} place\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Places found | Tests red | Which |');
    console.log('|---|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  for (const gap of NOT_MUTATED) console.log(`\nNot mutated: ${gap.what}. ${gap.why}`);
  return failed;
}

function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(2);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, NOT_MUTATED, run };
