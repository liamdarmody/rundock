'use strict';
// THE UPDATE PLAN (B+, decided 2026-09-24): an ordinary install plan of the
// new version, with every item classified against what this package last
// wrote and what is in the workspace now, and decided accordingly. The
// result is an approval the unchanged evaluator judges and the unchanged
// transaction writes, plus the groups the review shows.
//
// Three facts per item, each an authored digest (package-fingerprint.js):
// the base from the receipts, the workspace now, and the author's new
// version shaped exactly as it would land: the transform the receipt
// recorded (an adoption or a re-point) re-applied, provenance added, and the
// person's routine switches carried. Whatever the person changed is kept;
// where the author changed it too, `saveAuthor` marks it for the review copy.

const fs = require('node:fs');
const path = require('node:path');

const { buildPlan, actsWithoutAsking } = require('./import-plan.js');
const { digestFile, withProvenance, withAdoption, withReportsTo, itemSourcePath } = require('./import-apply.js');
const { ABSENT_DIGEST } = require('./import-evaluate.js');
const { authoredDigest } = require('./package-fingerprint.js');
const { routineStateOf, withRoutineState } = require('./routine-carry.js');
const { classifyUpdate } = require('./update-classify.js');
const { parseAgentFrontmatter, agentIsDefault } = require('../agents/discovery.js');

const readText = (absolute) => { try { return fs.readFileSync(absolute, 'utf8'); } catch (e) { return null; } };
const at = (root, relative) => path.join(root, ...relative.split('/'));
// The file whose frontmatter can act without asking: an agent, or a skill's SKILL.md.
const actingFile = (root, kind, relative) => at(root, kind === 'skill' ? `${relative}/SKILL.md` : relative);

// The author's new agent, shaped the way it would land over the live one.
function shapedAgent(sourceText, sourceId, transform, liveText) {
  const shaped = transform && transform.adoptUnder ? withAdoption(sourceText, transform.adoptUnder)
    : transform && transform.attachTo ? withReportsTo(sourceText, transform.attachTo) : sourceText;
  const state = liveText === null ? [] : routineStateOf(liveText).filter((s) => Object.keys(s.fields).length);
  return { text: withRoutineState(withProvenance(shaped, sourceId), state), state };
}

function decideItem(workspace, snapshot, sourceId, pkg, item) {
  const known = pkg.items[item.id] || null;
  const base = known && known.base ? (known.base.authored || (item.kind === 'agent' ? null : known.base.fingerprint)) : null;
  const transform = known && known.transform;
  const liveText = item.kind === 'starter' || item.plannedDigest === ABSENT_DIGEST ? null : readText(actingFile(workspace, item.kind, item.destination));
  let incoming = item.sourceDigest;
  let live = item.plannedDigest;
  let shaped = null;
  if (item.kind === 'agent') {
    shaped = shapedAgent(fs.readFileSync(at(snapshot, itemSourcePath('agent', item.slug)), 'utf8'), sourceId, transform, liveText);
    incoming = authoredDigest('agent', shaped.text);
    if (liveText !== null) live = authoredDigest('agent', liveText);
  }
  const incomingKeys = item.kind === 'starter' ? [] : actsWithoutAsking(readText(actingFile(snapshot, item.kind, itemSourcePath(item.kind, item.slug))));
  const liveKeys = actsWithoutAsking(liveText);
  const verdict = classifyUpdate({
    kind: item.kind, inPackage: !!known, base, live, incoming,
    gainsUnasked: incomingKeys.some((key) => !liveKeys.includes(key)),
  });
  const skip = verdict.decision === 'skip';
  const agent = item.agent === null ? null : { plannedDefault: item.agent.plannedDefault, approvedDefault: item.agent.plannedDefault };
  let approvedDigest = skip ? item.plannedDigest : item.approvedDigest;
  if (agent && !skip) {
    // A new agent lands as the plan offered it; one written over the live
    // file lands shaped: transform re-applied and switches carried.
    const text = verdict.decision === 'overwrite' ? shaped.text : null;
    if (text !== null) {
      approvedDigest = digestFile(Buffer.from(text, 'utf8'));
      agent.approvedDefault = agentIsDefault(parseAgentFrontmatter(text.replace(/\r\n/g, '\n')));
      if (transform) Object.assign(agent, transform);
      if (shaped.state.length) agent.routineState = shaped.state;
    } else {
      agent.approvedDefault = item.agent.approvedDefault;
    }
  }
  return {
    verdict,
    approvalItem: { id: item.id, kind: item.kind, slug: item.slug, destination: item.destination, collision: item.collision,
      decision: verdict.decision, plannedDigest: item.plannedDigest, approvedDigest, sourceDigest: item.sourceDigest, agent },
  };
}

// A CHANGED STARTER TEMPLATE ARRIVES ALONGSIDE, never over the person's
// file: `Investments/Portfolio.md` from v1.3.0 lands as
// `Investments/Portfolio (v1.3.0).md`, a distinct name so a wikilink to the
// old one never becomes ambiguous. The copy is made inside the acquired
// snapshot, which this offer owns, so it travels through the ordinary plan,
// evaluator and transaction as one more starter file.
function alongsideName(relative, tag) {
  const safe = String(tag).replace(/[/\\:*?"<>|\x00-\x1f]/g, '-');
  const slash = relative.lastIndexOf('/');
  const dir = relative.slice(0, slash + 1);
  const file = relative.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  return dot > 0 ? `${dir}${file.slice(0, dot)} (${safe})${file.slice(dot)}` : `${dir}${file} (${safe})`;
}

function placeAlongside(snapshot, starters, tag) {
  const copies = new Map();
  for (const relative of starters) {
    const copy = alongsideName(relative, tag);
    fs.copyFileSync(at(snapshot, itemSourcePath('starter', relative)), at(snapshot, itemSourcePath('starter', copy)));
    copies.set(`starter:${copy}`, relative);
  }
  return copies;
}

/**
 * The update plan for one installed package (`pkg`, from package-state.js)
 * against the new version acquired at `snapshot`, from `source` { url, reference }.
 */
function buildUpdatePlan(workspace, snapshot, pkg, source) {
  const identity = { id: source.url, reference: source.reference };
  const first = buildPlan(workspace, snapshot, identity);
  const changedStarters = first.items.filter((item) => item.kind === 'starter'
    && decideItem(workspace, snapshot, source.url, pkg, item).verdict.group === 'starter-alongside').map((item) => item.slug);
  const copies = placeAlongside(snapshot, changedStarters, source.reference);
  const plan = copies.size ? buildPlan(workspace, snapshot, identity) : first;
  const items = [];
  const groups = {};
  const note = (group, entry) => { (groups[group] = groups[group] || []).push(entry); };
  const decided = plan.items.map((item) => ({ item, ...decideItem(workspace, snapshot, source.url, pkg, item) }));
  for (const { item, verdict, approvalItem } of decided) {
    items.push(approvalItem);
    if (copies.has(item.id)) continue;
    const entry = { id: item.id, kind: item.kind, slug: item.slug, destination: item.destination, saveAuthor: verdict.saveAuthor };
    const copy = decided.find((d) => copies.get(d.item.id) === item.slug);
    if (copy) Object.assign(entry, { alongside: copy.item.slug, ...(copy.verdict.decision === 'add' ? {} : { alongsideKept: true }) });
    note(verdict.group, entry);
  }
  // What this package wrote before and the new version no longer carries:
  // kept, and marked. A starter file is the person's, so never marked.
  const offered = new Set(plan.items.map((i) => i.id));
  for (const [id, known] of Object.entries(pkg.items)) {
    if (offered.has(id) || !known.base || known.kind === 'starter') continue;
    note('retired', { id, kind: known.kind, slug: id.slice(known.kind.length + 1), destination: known.destination, saveAuthor: false });
  }
  return {
    approval: { schema: plan.schema, source: plan.source, manifest: plan.manifest, items },
    groups,
    ...(plan.unasked ? { unasked: plan.unasked } : {}),
    routines: Object.fromEntries(plan.items.filter((i) => i.agent && i.agent.routines).map((i) => [i.id, i.agent.routines])),
  };
}

module.exports = { buildUpdatePlan };
