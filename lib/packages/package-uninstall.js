'use strict';
// UNINSTALLING A PACKAGE, decided 2026-09-24 for 0.15.0. What goes is what
// this package put there and nobody has changed since: every agent and skill
// whose bytes still match what the package last wrote (on the authored
// fingerprint, so a routine switched on is not a change), its extension's
// record, folder and view state, and its receipts, so the package leaves the list and
// nothing else records it. What stays is everything the person made theirs:
// an item they edited, and every starter file, whatever state it is in.
//
// The plan is read from the workspace, and read again at confirm. The key
// names exactly what would go, with the bytes it would go at; if anything
// moved in between, the confirm is refused rather than deleting something
// the person did not see listed. Everything leaves in one transaction.

const crypto = require('node:crypto');
const path = require('node:path');

const { packageCards } = require('./package-state.js');
const { listReceipts, RECEIPTS_DIR } = require('./extension-manage.js');
const { readExtensionRecords, recordsWrite, EXTENSIONS_ROOT } = require('./extension-record.js');
const { stateFolderFor } = require('./extension-state.js');
const { writeAsUnit } = require('../workspace/atomic-write.js');

const at = (workspace, relative) => path.join(workspace, ...relative.split('/'));

function planUninstall(workspace, id) {
  const card = packageCards(workspace).find((c) => c.id === id);
  if (!card) throw Object.assign(new Error('That package is not installed.'), { code: 'not-installed' });
  const entry = (item, why) => ({ id: item.id, kind: item.kind, label: item.label, destination: item.destination, ...(why ? { why } : {}) });
  const goes = [];
  const stays = [];
  for (const item of card.items) {
    if (item.state === 'absent') continue;
    if (item.kind === 'starter') stays.push(entry(item, 'starter'));
    else if (item.state === 'as-installed') goes.push(entry(item));
    else stays.push(entry(item, 'edited'));
  }
  const extension = card.extension ? { name: card.extension.name, root: `${EXTENSIONS_ROOT}/${card.extension.name}` } : null;
  const receipts = listReceipts(workspace).filter((r) => r.source && r.source.id === id).map((r) => `${RECEIPTS_DIR}/${r.file}`);
  // What would go, and the state it would go in: the confirm refuses when
  // this differs from what was shown.
  const key = crypto.createHash('sha256')
    .update(JSON.stringify({ goes: goes.map((g) => g.id), stays: stays.map((s) => [s.id, s.why]), extension, receipts }))
    .digest('hex');
  return { id, name: card.name, title: card.title, goes, stays, extension, receipts, key };
}

/**
 * Remove what the plan says goes, as one transaction. `key` is the plan the
 * person confirmed; a plan that no longer matches is refused, nothing moved.
 */
function applyUninstall(workspace, id, key, options = {}) {
  const plan = planUninstall(workspace, id);
  if (plan.key !== key) {
    throw Object.assign(new Error('Something in this package changed since you opened the confirmation, so nothing was removed. Open it again to see what would go.'), { code: 'stale' });
  }
  const writes = [];
  const removes = [...plan.goes.map((g) => at(workspace, g.destination)), ...plan.receipts.map((r) => at(workspace, r))];
  if (plan.extension) {
    const records = readExtensionRecords(workspace);
    writes.push(recordsWrite(workspace, records.filter((r) => r.name !== plan.extension.name)));
    removes.push(at(workspace, plan.extension.root));
    // Its view state goes with it, every note's, in the same transaction: the
    // folder under Rundock's own, named from the extension alone. Kept on
    // update and disable, which never come through here.
    removes.push(stateFolderFor(workspace, plan.extension.name));
  }
  writeAsUnit(workspace, writes, { removes, afterStep: options.afterStep });
  return plan;
}

module.exports = { planUninstall, applyUninstall };
