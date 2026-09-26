'use strict';
// WHAT "KEEP AGENTS INSIDE THIS WORKSPACE" IS ACTUALLY DOING, for the
// Permissions row, and the switch's own writes.
//
// The row states the effective state first, so it is computed from the files
// the runtime reads, never from the stored switch alone: a preference that
// says on beside a block that says off is Off.
//
// `sandbox.enabled` IS AN OR ACROSS LAYERS IN THE SHIPPED RUNTIME. Claude
// Code's settings documentation (code.claude.com/docs/en/settings, "Settings
// precedence") describes a key taking the value of the highest layer that sets
// it, but the shipped runtime reads the enable as
//   [...layers, localSettings].some(e => e?.sandbox?.enabled === !0)
// (Claude Code 2.1.281, matching the 2.1.266 measurement recorded in
// lib/workspace/scaffold.js). So any layer that enables the sandbox turns it
// on, whatever Rundock's own block says, and the row reports that: it is never
// Off while a file Rundock can read turns it on.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isRundockSandbox, sandboxSwitchFor, reconcileSandboxForMode, sandboxSettings, tempRoots, workingFoldersFor } = require('./scaffold.js');
const { normalizeOne, effectiveWorkingFolders, readWorkingFolders, writeWorkingFolders } = require('./working-folders.js');

// The system-wide layer an administrator can set on macOS. Read only.
const MANAGED_SETTINGS_DARWIN = '/Library/Application Support/ClaudeCode/managed-settings.json';

function readJson(file) {
  try { return { found: true, value: JSON.parse(fs.readFileSync(file, 'utf-8')) }; } catch (e) {
    return { found: e.code !== 'ENOENT', value: null };
  }
}

// The other files Rundock can read that can turn the sandbox on, as the row
// names them.
function otherLayers(dir, home) {
  return [
    { label: '.claude/settings.json', file: path.join(dir, '.claude', 'settings.json') },
    { label: '~/.claude/settings.json', file: path.join(home, '.claude', 'settings.json') },
  ];
}
const enabledIn = (v) => (v && typeof v === 'object' && v.sandbox && typeof v.sandbox === 'object' && typeof v.sandbox.enabled === 'boolean' ? v.sandbox.enabled : null);

function sandboxStatus(dir, platform = process.platform, opts = {}) {
  const home = opts.home || os.homedir();
  const managedPath = opts.managedPath || MANAGED_SETTINGS_DARWIN;
  const local = readJson(path.join(dir, '.claude', 'settings.local.json')).value;
  const present = !!local && typeof local === 'object' && 'sandbox' in local;
  const block = present ? local.sandbox : null;
  // Absent is managed: there is nothing to defer to, and the next write is ours.
  const managed = !present || isRundockSandbox(block);
  const blockOn = present && !!block && typeof block === 'object' && block.enabled === true;
  // Any layer that enables it turns it on.
  const managedOn = enabledIn(readJson(managedPath).value) === true;
  const enabledElsewhere = otherLayers(dir, home)
    .filter((layer) => enabledIn(readJson(layer.file).value) === true)
    .map((layer) => layer.label);
  const effective = blockOn || managedOn || enabledElsewhere.length > 0;
  const setBy = managedOn ? 'managed' : enabledElsewhere.length ? 'elsewhere' : 'workspace';
  const available = platform === 'darwin';
  const stored = sandboxSwitchFor(dir).stored;
  return {
    type: 'sandbox_status',
    platform,
    available,
    present,
    managed,
    on: available && effective,
    // Rundock's own block, apart from what is in force: another layer that
    // turns the sandbox on keeps it on whatever this says.
    blockOn: available && blockOn,
    // Who is keeping it as it is: managed settings, another file Rundock can
    // read (named in enabledElsewhere), or Rundock's own block.
    setBy: available ? setBy : null,
    enabledElsewhere: available ? enabledElsewhere : [],
    stored,
    // Told once, to a workspace that predates the switch and whose block is
    // Rundock's. A block a person wrote was never moved by mode, so there is
    // nothing to tell them.
    notice: available && present && managed && !stored ? (blockOn ? 'on' : 'off') : null,
  };
}

// Every write the switch makes is all or nothing across the two files it
// touches, state.json and settings.local.json: their exact bytes are captured
// first and put back if anything after fails, so a failed flip never leaves a
// stored switch that disagrees with the block.
function snapshot(files) {
  return files.map((file) => {
    try { return { file, bytes: fs.readFileSync(file), absent: false }; } catch (e) {
      return { file, bytes: null, absent: e.code === 'ENOENT' };
    }
  });
}
function restore(snaps) {
  for (const s of snaps) {
    try {
      if (s.bytes) fs.writeFileSync(s.file, s.bytes);
      else if (s.absent && fs.existsSync(s.file)) fs.unlinkSync(s.file);
    } catch (e) { console.warn(`  Could not restore ${s.file}: ${e.message}`); }
  }
}
function writeOwnState(dir, patch) {
  const file = path.join(dir, '.rundock', 'state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...state, ...patch }, null, 2));
}

// Throws with a reason a person can read; the handler reports it.
function setSandboxSwitch(dir, on, platform = process.platform) {
  if (typeof on !== 'boolean') throw new Error('the switch can only be on or off.');
  const status = sandboxStatus(dir, platform);
  if (!status.available) throw new Error('keeping agents inside this workspace is not available on this computer.');
  if (!status.managed) throw new Error('this workspace\'s sandbox was set up outside Rundock.');
  const snaps = snapshot([path.join(dir, '.rundock', 'state.json'), path.join(dir, '.claude', 'settings.local.json')]);
  try {
    writeOwnState(dir, { sandboxSwitch: on ? 'on' : 'off' });
    reconcileSandboxForMode(dir, on ? 'on' : 'off', platform);
  } catch (e) {
    restore(snaps);
    throw e;
  }
}

// The notice's dismissal: the switch is stored at what it already is.
function pinSandboxSwitch(dir) {
  const current = sandboxSwitchFor(dir);
  if (!current.stored) writeOwnState(dir, { sandboxSwitch: current.on ? 'on' : 'off' });
}

// BRINGING A PERSON'S OWN RULES IN. The one route by which Rundock replaces a
// block it did not write, and only after the person has seen, in the review,
// every folder that becomes a working folder and every rule that cannot come.
//
// What Rundock can represent is exactly what it writes: the workspace and its
// runtime roots, the folders a person names, its own deny list, the on or off
// state, and the fixed network and command settings of its on shape. A written
// folder becomes a working folder; everything else is named and dropped.
function settingsFile(dir) { return path.join(dir, '.claude', 'settings.local.json'); }

function importReview(dir, home = os.homedir()) {
  const raw = fs.readFileSync(settingsFile(dir));
  const block = JSON.parse(raw.toString('utf-8')).sandbox;
  const own = sandboxSettings(dir, 'darwin', home, tempRoots(), effectiveWorkingFolders([]), 'on');
  const named = readWorkingFolders();
  const folders = [];
  const dropped = [];
  const drop = (rule, value) => dropped.push({ rule, value: typeof value === 'string' ? value : JSON.stringify(value) });
  const b = block && typeof block === 'object' && !Array.isArray(block) ? block : {};
  for (const [key, value] of Object.entries(b)) {
    if (key === 'enabled') continue;
    if (key === 'autoAllowBashIfSandboxed' && value === true) continue;
    if (key === 'network' && JSON.stringify(value) === JSON.stringify(own.network)) continue;
    if (key !== 'filesystem' || !value || typeof value !== 'object') { drop(key, value); continue; }
    for (const [fsKey, list] of Object.entries(value)) {
      const entries = Array.isArray(list) ? list : [list];
      for (const entry of entries) {
        if (fsKey === 'allowWrite' && own.filesystem.allowWrite.includes(entry)) continue;
        if (fsKey === 'denyWrite' && own.filesystem.denyWrite.includes(entry)) continue;
        const folder = fsKey === 'allowWrite' ? normalizeOne(entry) : null;
        if (folder && folder !== path.resolve(dir)) { if (!named.includes(folder) && !folders.includes(folder)) folders.push(folder); continue; }
        drop(`filesystem.${fsKey}`, entry);
      }
    }
  }
  return {
    folders, dropped,
    on: b.enabled === true,
    digest: crypto.createHash('sha256').update(raw).digest('hex'),
  };
}

function checkImportable(dir, platform) {
  const status = sandboxStatus(dir, platform);
  if (!status.available) throw new Error('keeping agents inside this workspace is not available on this computer.');
  if (!status.present || status.managed) throw new Error('there are no custom rules here to bring in.');
}

function reviewSandboxImport(dir, platform = process.platform) {
  checkImportable(dir, platform);
  return importReview(dir);
}

function importSandboxRules(dir, digest, platform = process.platform) {
  checkImportable(dir, platform);
  const review = importReview(dir);
  if (digest !== review.digest) throw new Error('your settings file has changed since you reviewed it. Review it again.');
  const snaps = snapshot([path.join(dir, '.rundock', 'state.json'), settingsFile(dir)]);
  try {
    writeWorkingFolders([...readWorkingFolders(), ...review.folders]);
    writeOwnState(dir, { sandboxSwitch: review.on ? 'on' : 'off' });
    const settings = JSON.parse(fs.readFileSync(settingsFile(dir), 'utf-8'));
    settings.sandbox = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), review.on ? 'on' : 'off');
    fs.writeFileSync(settingsFile(dir), JSON.stringify(settings, null, 2));
  } catch (e) {
    restore(snaps);
    throw e;
  }
}

module.exports = {
  sandboxStatus, setSandboxSwitch, pinSandboxSwitch, reviewSandboxImport, importSandboxRules,
  writeOwnState, snapshot, restore, MANAGED_SETTINGS_DARWIN,
};
