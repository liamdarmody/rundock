#!/usr/bin/env node
'use strict';
// Break each of the extension install flow's guards in turn and report which
// tests notice.
//
// The rules this lane leaves behind are all promises to a person deciding
// whether to trust code: the pin is required, the trust step tells the
// truth, no is really no, the record remembers the source so they never
// retype it, one transaction carries the install, and uninstall removes
// exactly what install created. Every one can be deleted with the product
// still installing SOMETHING, which is why each is broken on purpose here
// and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-extension-install-guards.js            # report
//   node test/tools/mutate-extension-install-guards.js --markdown # as a table
//
// The files are restored afterwards, including when a run throws. The
// harness is the same shape as its siblings and deliberately a separate
// copy, for the reason recorded in mutate-routines-guards.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');
const SUITE = 'test/unit/extension-install.test.js';

const SOURCE = { src: path.join(ROOT, 'lib', 'packages', 'extension-source.js'), suite: SUITE };
const MANIFEST = { src: path.join(ROOT, 'lib', 'packages', 'extension-manifest.js'), suite: SUITE };
const RECORD = { src: path.join(ROOT, 'lib', 'packages', 'extension-record.js'), suite: SUITE };
const INSTALL = { src: path.join(ROOT, 'lib', 'packages', 'extension-install.js'), suite: SUITE };
const HANDLERS = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'packages.js'), suite: SUITE };
const MODEL = { src: path.join(ROOT, 'public', 'packages-install-model.js'), suite: SUITE };
const SETTINGS_VIEW = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: SUITE };

const MUTATIONS = [
  // ===== THE PIN IS REQUIRED =====
  // Let the well-known moving names through and "pinned at main" becomes a
  // promise about whatever main means tomorrow.
  [SOURCE, 'a moving branch name is refused as not a pin',
    `  if (MOVING_NAMES.has(reference.toLowerCase())) {
    refuse(\`"\${reference}" is a moving branch name, not a pin; use a tag, release or commit\`,
      'unpinned-reference');
  }`,
    ''],
  // Default the absent pin and the refusal's whole reason is inverted.
  [SOURCE, 'an absent reference is refused, never defaulted to a branch',
    `  if (!reference) {
    refuse('a pinned reference (tag, release or commit) is required; an install is a promise '
      + 'about exact bytes, and a moving branch cannot keep it', 'unpinned-reference');
  }`,
    `  if (!reference) {
    return { url: \`https://github.com/\${owner}/\${repo}\`, owner, repo, reference: 'main' };
  }`],
  // Let a reference beginning with "-" through and it lands in a git argv
  // position as an option rather than as the thing to fetch.
  [SOURCE, 'a reference beginning with "-" is refused, not fed to a git argv',
    `  if (reference.startsWith('-')) {
    refuse(\`"\${reference}" is not a reference; a pin cannot begin with "-"\`, 'unpinned-reference');
  }`,
    ''],
  // Skip the cleanup on a failed fetch and the temporary directory
  // acquireWithGit created leaks for the life of the process on every
  // refused reference.
  [SOURCE, 'a failed fetch removes the temporary directory acquireWithGit created',
    '    discardAcquisition(dir);',
    ''],

  // ===== CODE REQUIRES A MANIFEST =====
  // Wave a manifest-less snapshot through as an extension and inference has
  // quietly grown the one thing it must never infer.
  [MANIFEST, 'a snapshot without a manifest is not an extension',
    `      refuse(\`the package has no \${MANIFEST_NAME}; code requires a manifest, always\`, 'not-an-extension');`,
    `      return { name: 'inferred', version: '0.0.0', entry: 'index.html', match: '*' };`],
  // Skip the symlink check on the entry path and a path segment linking
  // outside the snapshot is walked straight through instead of refused.
  [MANIFEST, 'extension.entry is refused when a path segment is a symlink',
    '    if (stat.isSymbolicLink()) refuse(`extension.entry passes through a symlink at ${segment}`);',
    ''],
  // Skip the symlink check inside the mounted directory and a file linking
  // outside the snapshot is read and materialised as if it were the
  // package's own bytes.
  [MANIFEST, 'a file inside the mounted directory is refused when it is a symlink',
    '    if (stat.isSymbolicLink()) refuse(`${relative} is a symlink`);',
    ''],

  // ===== NO IS REALLY NO =====
  // Keep the snapshot after a decline and "nothing left behind" is false in
  // the one place the person cannot see.
  [HANDLERS, 'declining discards the acquired snapshot',
    '  if (pending) discardAcquisition(pending.snapshot);',
    ''],

  // ===== AN UPDATE READS ITS URL FROM THE RECORD, NEVER FROM THE CALLER =====
  // Let a caller-supplied url win over the record's own and the whole point
  // of persisting the source is undone: an update could be pointed at a
  // repository the person never consented to.
  [HANDLERS, 'the update path sources its URL from the installed record, not the message',
    '    source = parseGitHubSource(record.source.url, msg.reference);',
    '    source = parseGitHubSource(msg.url || record.source.url, msg.reference);'],

  // ===== A HANDLER ANSWERS, IT NEVER THROWS; A PERSISTED RECORD IS NOT
  //       TRUSTED INPUT =====
  // Skip the missing-record refusal and the generic TypeError that follows
  // is still caught by the same try, but with a message this handler never
  // meant to send: the named refusal a caller could act on is gone.
  [HANDLERS, 'planning an update for a name with no installed record is refused by name',
    `    if (!record) throw new Error(\`no extension named "\${msg.name}" is installed\`);
    if (!record.source || typeof record.source.url !== 'string') {`,
    `    if (!record.source || typeof record.source.url !== 'string') {`],
  // Skip the missing-source check and a record with no source field falls
  // straight into parseGitHubSource with an undefined url, refused only by
  // accident rather than by a stated rule about what this record must carry.
  [HANDLERS, 'a record missing its own source is refused by name',
    `    if (!record.source || typeof record.source.url !== 'string') {
      throw new Error(\`the installed record for "\${msg.name}" carries no source url; refusing to update\`);
    }`,
    ''],
  // Skip the revalidation and the persisted url goes straight into
  // beginExtensionPlan and a git argv unchecked, exactly the trust the
  // uninstall path refuses to extend to the same file's root.
  [HANDLERS, 'the stored url is revalidated through the same GitHub-source validation a fresh install uses',
    '    source = parseGitHubSource(record.source.url, msg.reference);',
    '    source = { url: record.source.url, reference: msg.reference };'],

  // ===== CONSENT BINDS TO THE WORKSPACE IT WAS SHOWN AGAINST =====
  // Skip the workspace check and a confirm answered after the server moved
  // to another workspace installs into whatever is current now, replacing
  // that workspace's files under a trust card that described a different one.
  [HANDLERS, 'a confirm is refused when the server\'s workspace has changed since the plan',
    `    if (pending.workspace !== workspace) {
      throw Object.assign(
        new Error('the workspace changed since this package was read; read it again'),
        { code: 'workspace-changed' },
      );
    }`,
    ''],

  // ===== AN UNANSWERED OFFER DOES NOT LIVE FOREVER =====
  // Skip the close release and a dropped connection leaves the fetched
  // snapshot and its token alive for the life of the process.
  [HANDLERS, 'a dropped connection releases the pending offer',
    `    if (typeof ws.once === 'function') {
      ws.once('close', () => releasePending(token));
    }`,
    ''],
  // Skip the supersede release and a second plan on the same connection
  // leaves the first offer's snapshot and token alive, unreachable and
  // unanswerable, for the life of the process.
  [HANDLERS, 'a second plan on the same connection supersedes the first, unanswered one',
    `    const previousToken = pendingBySocket.get(ws);
    if (previousToken) releasePending(previousToken);`,
    ''],

  // ===== THE TRUST STEP TELLS THE TRUTH =====
  // Drop the no-review sentence and the screen implies a vetting nobody did.
  [MODEL, 'the trust step says Rundock does not review extensions',
    `        + 'Rundock does not review extensions; what you install is your choice.',`,
    `        + '',`],

  // ===== THE RECORD REMEMBERS THE SOURCE =====
  // Forget the pin and every update check needs the URL and reference typed
  // again, which is the exact gap the record exists to close.
  [INSTALL, 'the record carries the pinned reference',
    `    installedAt: options.now || new Date().toISOString(),
    root,
  };`,
    `    installedAt: options.now || new Date().toISOString(),
    root,
  };
  record.source = { url: source.url, reference: null };`],
  // Drop the "actually newer" filter and every reference the listing merely
  // differs from is offered, including ones behind the installed pin: a
  // downgrade offered as an update.
  [RECORD, 'the update check reports only references it can show come after the pin',
    '    .filter((name) => isNewerReference(name, record.source.reference))',
    ''],
  // Drop the sort and the reported order goes back to whatever the listing's
  // own order was, which for the real default lister is lexicographic:
  // v10.0.0 before v2.0.0.
  [RECORD, 'the reported order is the true numeric order, not the listing\'s own order',
    '    .sort((a, b) => compareSemver(semverParts(a), semverParts(b)));',
    ';'],

  // ===== ONE TRANSACTION CARRIES THE INSTALL =====
  // Split the record from the files and a crash between them leaves a
  // directory nothing knows about, or a record whose files never landed.
  [INSTALL, 'the files and the record land as one unit',
    `  writeAsUnit(workspace, [
    { path: path.join(workspace, ...RECORDS_PATH.split('/')), content: serialiseRecords([...others, record]) },
  ], {
    replaceDirs: [{ path: path.join(workspace, ...root.split('/')), files }],
  });`,
    `  writeAsUnit(workspace, [], {
    replaceDirs: [{ path: path.join(workspace, ...root.split('/')), files }],
  });
  writeAsUnit(workspace, [
    { path: path.join(workspace, ...RECORDS_PATH.split('/')), content: serialiseRecords([...others, record]) },
  ]);`],

  // ===== UNINSTALL REMOVES THE RECORD =====
  [INSTALL, 'uninstall removes the record entry with the files',
    '  const remaining = records.filter((r) => r.name !== name);',
    '  const remaining = records;'],

  // ===== UNINSTALL NEVER TRUSTS THE PERSISTED ROOT, AND REMOVES EXACTLY
  //       WHAT THIS INSTALL CREATED =====
  // Skip the exact-match check and a records file carrying "root":
  // ".claude/rundock/extensions" for one entry makes uninstall recursively
  // delete every installed extension, or one carrying another install's own
  // root removes that install's directory instead of this one's.
  [INSTALL, 'the removal target must equal the install-time location exactly, nothing wider',
    `  if (targetAbsolute !== expectedAbsolute) {
    refuse(\`the installed record for "\${name}" names a root that does not match its install-time location; refusing to remove anything\`, 'invalid-record');
  }`,
    ''],
  // Skip the missing-root check and a record with no root throws a raw
  // TypeError from the split() that used to read it, instead of a named
  // refusal that leaves the workspace untouched.
  [INSTALL, 'a record with no root is refused by name',
    `  if (typeof record.root !== 'string' || !record.root) {
    refuse(\`the installed record for "\${name}" has no root; refusing to remove anything\`, 'invalid-record');
  }`,
    ''],
  // Skip the name-validation and a records file carrying a name shaped like
  // a traversal ("../../etc") is joined straight into the removal target's
  // expected path instead of being refused before it is ever used.
  [INSTALL, 'a record with an invalid name is refused before it is joined into a path',
    `  if (typeof record.name !== 'string' || !SLUG.test(record.name)) {
    refuse(\`the installed record for "\${name}" carries an invalid name; refusing to remove anything\`, 'invalid-record');
  }`,
    ''],

  // ===== THE TRUST CARD SHOWS THE FACT IT DERIVED =====
  // Drop the rendered file list and the trust card prints its own lead-in
  // sentence ("read from the package itself") followed by nothing that was
  // actually read from the package.
  [SETTINGS_VIEW, 'the trust card renders the derived file list',
    '        <ul class="extension-facts-files">${copy.files.map((f) => `<li>${esc(f)}</li>`).join(\'\')}</ul>',
    ''],
  // Drop extensionReplyArrived from the exported surface and every server
  // reply for this flow resolves against `window` in a browser and throws,
  // while every test that calls the handler directly stays green.
  [SETTINGS_VIEW, 'the extension flow\'s reply entry is on the module\'s exported surface',
    '  extensionSubmit, extensionConfirm, extensionDecline, extensionBack, extensionReplyArrived };',
    '  extensionSubmit, extensionConfirm, extensionDecline, extensionBack };'],
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
    // of a stack trace that names nothing. The spec reporter's format is
    // what this parses; if it changed, fix the parser rather than trusting
    // an empty result.
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
  const targets = [SOURCE, MANIFEST, RECORD, INSTALL, HANDLERS, MODEL, SETTINGS_VIEW];
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of MUTATIONS) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      // A guard matching more than once is refused rather than taking the
      // first: the replacement would break whichever came first and report
      // on whatever that turns red.
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

module.exports = { MUTATIONS, run };
