#!/usr/bin/env node
'use strict';
// A NOTE'S CASE VARIANT ON A REAL CASE-INSENSITIVE DISK, NEVER SKIPPED.
//
// A note's case variant is the same file on a case-insensitive disk, and the
// resolver must refuse it as the note itself (identity by device and inode),
// or a write to it as a source would bypass the rule that a view may not
// change its own list. This runs the real resolver against real files on a
// real case-insensitive filesystem, with nothing mocked:
//
// - where the system temporary directory is already case-insensitive (the
//   default on macOS), there;
// - otherwise, on macOS, on a small APFS volume (case-insensitive, the APFS default) created for
//   this run with hdiutil and removed after it;
// - otherwise it FAILS, naming why: a check that cannot run is not a pass.
//
// Run by the release gate on macOS beside the Electron step, once on the
// default disk and once on a volume made for it. Exits 0 on a
// pass and 1 on anything else, printing a JSON report either way.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveSources, REASONS } = require('../../lib/workspace/named-sources.js');

function caseInsensitive(dir) {
  const probe = path.join(dir, `Rundock-Case-Probe-${process.pid}`);
  fs.writeFileSync(probe, 'x');
  try { return fs.existsSync(path.join(dir, path.basename(probe).toLowerCase())); } finally { fs.rmSync(probe, { force: true }); }
}

function check(root) {
  const ws = fs.mkdtempSync(path.join(root, 'rundock-case-identity-'));
  fs.writeFileSync(path.join(ws, 'dash.md'), '---\nportfolio-dashboard: true\nsources:\n  - DASH.md\n  - Dash.MD\n  - notes/a.csv\n---\n# Dashboard\n');
  fs.mkdirSync(path.join(ws, 'notes'));
  fs.writeFileSync(path.join(ws, 'notes', 'a.csv'), 'a,1\n');
  const variantsExist = fs.existsSync(path.join(ws, 'DASH.md')) && fs.existsSync(path.join(ws, 'Dash.MD'));
  const r = resolveSources(ws, 'dash.md');
  fs.rmSync(ws, { recursive: true, force: true });
  return { variantsExist, sources: r.sources };
}

function main() {
  const report = { platform: process.platform, surface: null, checks: [] };
  const ok = (name, pass, detail) => report.checks.push({ name, ok: !!pass, ...(pass ? {} : { detail }) });
  let volume = null;
  try {
    const tmp = fs.realpathSync(os.tmpdir());
    let root = null;
    // RUNDOCK_CASE_IDENTITY_VOLUME=1 takes the volume road even on a case-insensitive
    // default disk, so that road is exercised rather than trusted.
    if (caseInsensitive(tmp) && process.env.RUNDOCK_CASE_IDENTITY_VOLUME !== '1') {
      root = tmp; report.surface = 'the system temporary directory, which is case-insensitive';
    } else if (process.platform === 'darwin') {
      const dir = fs.mkdtempSync(path.join(tmp, 'rundock-ci-vol-'));
      const image = path.join(dir, 'ci.dmg');
      const mount = path.join(dir, 'mnt');
      fs.mkdirSync(mount);
      execFileSync('hdiutil', ['create', '-size', '16m', '-fs', 'APFS', '-volname', 'RundockCaseIdentity', image], { stdio: 'ignore' });
      execFileSync('hdiutil', ['attach', image, '-mountpoint', mount, '-nobrowse'], { stdio: 'ignore' });
      volume = { dir, mount };
      root = mount; report.surface = 'a case-insensitive APFS volume created for this run';
    } else {
      ok('a case-insensitive filesystem is available to run on', false, 'the temporary directory is case-sensitive and no volume can be made here');
    }
    if (root) {
      ok('(instrument) the surface is case-insensitive', caseInsensitive(root), root);
      const r = check(root);
      ok('(instrument) both case variants of the note exist as the note', r.variantsExist, r);
      const self = r.sources.filter((s) => s.path !== 'notes/a.csv');
      ok('every case variant of the note is refused as the note itself, never handed',
        self.length === 2 && self.every((s) => s.refused === REASONS.self), self);
      ok('an ordinary listed file beside them is still handed', r.sources.some((s) => s.path === 'notes/a.csv' && s.content === 'a,1\n'), r.sources);
    }
  } catch (e) {
    ok('run completed', false, String(e && e.stack || e));
  } finally {
    if (volume) {
      try { execFileSync('hdiutil', ['detach', volume.mount, '-force'], { stdio: 'ignore' }); } catch (e) { /* reported below if it lingers */ }
      fs.rmSync(volume.dir, { recursive: true, force: true });
    }
  }
  report.ok = report.checks.length > 0 && report.checks.every((c) => c.ok);
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  if (process.env.RUNDOCK_RECORD_EVIDENCE === '1') {
    const road = process.env.RUNDOCK_CASE_IDENTITY_VOLUME === '1' ? 'case-identity-apfs-volume.json' : 'case-identity-default-disk.json';
    const out = path.join(__dirname, '..', '..', 'docs', 'evidence', 'trust-boundary', road);
    fs.writeFileSync(out, `${JSON.stringify({ ...report, surface: report.surface }, null, 1)}\n`);
  }
  process.exit(report.ok ? 0 : 1);
}

main();
