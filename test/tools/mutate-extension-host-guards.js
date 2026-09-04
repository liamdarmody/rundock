#!/usr/bin/env node
'use strict';
// Break each of the extension host's guards in turn and report which tests
// notice.
//
// Every rule here is a trust rule: the sandbox posture, the closed message
// table, the watchdog, the degrade path, the teardown, the path guard. Each
// can be deleted with the product still rendering SOMETHING, which is why a
// green suite proves nothing about them until each is broken on purpose and
// a test goes red for it. A guard whose mutation turns nothing red is
// reported as a FAILURE rather than passed over.
//
//   node test/tools/mutate-extension-host-guards.js            # report
//   node test/tools/mutate-extension-host-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The
// harness is the same shape as its siblings and deliberately a separate
// copy, for the reason stated in mutate-routines-guards.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The host, watched by the suite that mounts it in a real DOM and reads the
// wire.
const HOST = { src: path.join(ROOT, 'public', 'extension-host.js'), suite: 'test/unit/extension-host.test.js' };
// The client registry and the file view's seam over it.
const REGISTRY = { src: path.join(ROOT, 'public', 'renderer-registry.js'), suite: 'test/unit/renderer-registry.test.js' };
// The server's payload reader, watched where its path guard is driven with a
// manifest that tries to escape.
const SERVER = { src: path.join(ROOT, 'lib', 'packages', 'extension-registry.js'), suite: 'test/unit/extension-host.test.js' };
// The file view's seam and its shared mount release, watched by the suite
// that cuts them from source and drives them.
const FILES = { src: path.join(ROOT, 'public', 'views', 'files.js'), suite: 'test/unit/renderer-registry.test.js' };

const MUTATIONS = [
  // ===== THE POSTURE =====
  // Widen the sandbox and the frame gains the app's origin: the one
  // combination the contract forbids in as many words.
  [HOST, 'the sandbox grants scripts and nothing else',
    "    frame.setAttribute('sandbox', 'allow-scripts');",
    "    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');"],
  // The frame CSP is the contract's no-network enforcement; weakening it must
  // redden the posture test, or the no-network claim rests on nothing.
  [HOST, "the frame document denies the network with default-src 'none'",
    'const FRAME_CSP = "default-src \'none\'; script-src \'unsafe-inline\'; "',
    'const FRAME_CSP = "default-src * ; script-src \'unsafe-inline\'; "'],
  // Drop the closing-tag escaping and a payload can break out of its own
  // script element, so the view never says ready.
  [HOST, 'the inlined payload cannot close its own element',
    "  return String(text || '').split(`</${tag}`).join(`<\\\\/${tag}`);",
    "  return String(text || '');"],

  // ===== THE CLOSED TABLE =====
  // Silence instead of refusal: the extension never learns it was refused
  // and an audit never sees the attempt.
  [HOST, 'a message outside the contract is refused with a reason, on the wire',
    "    if (!verdict.ok) {\n      send({ type: 'refused', of: verdict.of, reason: verdict.reason });\n      return;\n    }",
    '    if (!verdict.ok) {\n      return;\n    }'],
  // Shrink the table without touching the document and the two-way check
  // must fail naming the drift.
  [HOST, 'the enforced table and the published table cannot drift apart',
    "  open: { target: (v) => typeof v === 'string' && v.length > 0 },\n",
    ''],

  // ===== THE DEGRADE PATH =====
  [HOST, 'a view that never starts is torn down by the clock',
    '    readyTimer = win.setTimeout(() => {\n      degrade(`the extension did not start within ${readyTimeoutMs}ms`);\n    }, readyTimeoutMs);',
    ''],
  [HOST, 'a reported failure tears the frame down rather than leaving it',
    "    if (data.type === 'error') {\n      degrade(`the extension reported a failure: ${data.message}`);\n      return;\n    }",
    "    if (data.type === 'error') {\n      return;\n    }"],

  // ===== THE TEARDOWN =====
  [HOST, 'an update under a live mount tears the old frame down first',
    '    swap(newPayload) {\n      teardown();',
    '    swap(newPayload) {'],

  // ===== THE REGISTRY =====
  [REGISTRY, 'two claims on one target cannot both render it',
    '          if (byTarget.has(target)) {\n            const holder = byTarget.get(target);\n            refusals.push({ extension: ext.id, target,\n              reason: `"${target}" is already rendered by ${holder.extension}` });\n            continue;\n          }',
    ''],
  [REGISTRY, 'an unregistered target is an answer with a reason, never an invented renderer',
    '      if (!hit) {\n        return { registered: false, reason: `no installed extension renders "${target}"` };\n      }',
    "      if (!hit) {\n        return { registered: true, extension: 'unknown', renderer: 'unknown' };\n      }"],
  // Widen the grammar to accept multi-segment targets the last-dot lookup can
  // never match, and the quiet-shadowing refusal this module exists to
  // prevent comes back.
  [REGISTRY, 'the accepted grammar is a single segment the lookup can honour',
    "  return /^\\.[a-z0-9][a-z0-9-]*$/.test(normaliseTarget(target));",
    "  return /^\\.[a-z0-9][a-z0-9.-]*$/.test(normaliseTarget(target));"],

  // ===== THE CLAMP =====
  // Assign the raw height and a hostile view stretches the page exactly as
  // the contract says it cannot.
  [HOST, 'the requested height is clamped to the published bounds',
    '      const h = Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, data.height));',
    '      const h = data.height;'],

  // ===== THE REAL WIRE =====
  // Remove the listener registration and the host mediates nothing a real
  // frame posts; remove its teardown and a stale listener survives the mount.
  [HOST, 'the mediator is bound to the window on mount',
    "    win.addEventListener('message', onMessage);\n",
    ''],
  [HOST, 'the mediator is unbound on teardown',
    "    alive = false;\n    win.removeEventListener('message', onMessage);",
    '    alive = false;'],

  // ===== THE PATH GUARD =====
  // Let a manifest walk out of its own directory and the server reads
  // whatever the workspace holds on the extension's behalf.
  [SERVER, 'a payload path resolves inside the extension directory or not at all',
    '  if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;\n  return null;',
    '  return real;'],
  // Drop the array discipline and a manifest whose renderers is a JSON object
  // makes the server raise on .find rather than refuse.
  [SERVER, 'a manifest whose renderers is not an array is refused, never raised on',
    "  if (!Array.isArray(manifest.renderers)) {\n    return { ok: false, reason: 'the manifest declares no renderers array' };\n  }\n",
    ''],
  // Drop the styles path guard and a manifest stylesheet reads arbitrary
  // workspace files server-side.
  [SERVER, 'a stylesheet path resolves inside the extension directory or not at all',
    "    if (!stylePath) return { ok: false, reason: 'a stylesheet does not resolve inside the extension\\'s own directory' };",
    '    if (!stylePath) { stylePath = path.resolve(dir, name); }'],
  // Drop the styles-shape check and a non-array styles field is coerced
  // rather than refused.
  [SERVER, 'a styles field that is not an array of strings is refused',
    "  if (!Array.isArray(styleNames) || styleNames.some((n) => typeof n !== 'string')) {\n    return { ok: false, reason: 'the renderer styles must be an array of file names' };\n  }\n",
    ''],

  // ===== THE FILE VIEW'S MOUNT LIFECYCLE =====
  // Remove the token guard and two opens of one path both mount, leaking the
  // first frame and repainting over the second.
  [FILES, 'a superseded open neither mounts nor degrades',
    '    if (superseded()) return;\n    // SUCCESS IS AN ENTRY',
    '    // SUCCESS IS AN ENTRY'],
  // Remove the release before the board-or-seam decision and a live mount
  // survives a file open.
  [FILES, 'every file open releases the live mount before it decides',
    '    releaseExtensionMount();\n    // A markdown file whose frontmatter',
    '    // A markdown file whose frontmatter'],
  // Remove the release in closeOpenFile and a mount survives a workspace
  // switch.
  [FILES, 'a workspace switch releases the live mount',
    '  releaseExtensionMount();\n  currentFilePath = null;',
    '  currentFilePath = null;'],
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
  const targets = [HOST, REGISTRY, SERVER, FILES];
  const session = beginMutationRun({ files: [...new Set(targets.map((t) => t.src))] });
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
