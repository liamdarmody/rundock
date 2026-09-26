'use strict';
/**
 * Package updates on the Packages page (B+, decided 2026-09-24): checking,
 * the update row on a package's history entry, the review before anything
 * changes, and what the person is told afterwards. Pure, like the install and
 * manage models: every transition returns `{ state, send }`, and `send` is
 * undefined unless the person asked.
 *
 * The review offers no per-item choices. Whatever the person changed is
 * kept, and the author's version of it is saved for them to review; the
 * server applies the plan it holds, so nothing this model sends can widen
 * what is written. Copy is UK English: it is what a person reads.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./packages-install-model.js'));
  } else root.RundockPackagesUpdateModel = factory(root.RundockPackagesInstallModel);
}(typeof self !== 'undefined' ? self : this, function (install) {

  const GROUPS = [
    ['author-changed', 'Changed by the author', 'These will update.'],
    ['new', 'New in this version', 'These will be added.'],
    ['starter-alongside', 'New starter templates', 'Your files are never touched. Each new template is added beside the one you have, so you can move your data across when you are ready.'],
    ['both-changed', 'You and the author both changed these', 'Yours are kept. The author\'s version is saved for you to review.'],
    ['acts-without-asking', 'These would now act without asking', 'Not updated: the author\'s version adds settings that run without a permission card. It is saved for you to review.'],
    ['path-taken', 'Already in your workspace', 'Yours are kept. The author\'s version is saved for you to review.'],
    ['unknown', 'Changed since they were added', 'Rundock cannot tell who changed these, so yours are kept. The author\'s version is saved for you to review.'],
    ['edited', 'You edited these', 'Kept as yours. The author has not changed them.'],
    ['removed-by-you', 'You removed these', 'They stay removed.'],
    ['retired', 'No longer in the package', 'Kept, and marked as no longer from the package.'],
  ];
  const KIND_WORDS = { agent: 'agent', skill: 'skill', starter: 'starter file' };

  function initial() {
    return { statuses: {}, errors: {}, checking: false, checkingIds: {}, review: null, busy: null, done: null, uninstall: null, notice: null };
  }

  const nameOf = (id) => String(id || '').replace(/^https:\/\/github\.com\//, '').split('/').pop() || id;
  const without = (map, key) => { const next = { ...map }; delete next[key]; return next; };

  // Checked when Packages opens and when the person asks: every installed
  // package in one message, answered one at a time.
  function checkAll(state) {
    if (state.checking) return { state };
    return { state: { ...state, checking: true, errors: {} }, send: { type: 'check_package_update' } };
  }

  // One package's own Check for updates.
  function checkOne(state, id) {
    if (state.checking || state.checkingIds[id]) return { state };
    return { state: { ...state, checkingIds: { ...state.checkingIds, [id]: true }, errors: without(state.errors, id) }, send: { type: 'check_package_update', source: id } };
  }

  // Uninstall is a question first: the server says what would go and what
  // would stay, and nothing is removed until the person confirms that list.
  function beginUninstall(state, id) {
    if (state.busy || (state.uninstall && state.uninstall.busy)) return { state };
    return {
      state: { ...state, review: null, notice: null, uninstall: { id, plan: null, busy: true }, errors: without(state.errors, id) },
      send: { type: 'plan_package_uninstall', source: id },
    };
  }

  function confirmUninstall(state) {
    const u = state.uninstall;
    if (!u || !u.plan || u.busy) return { state };
    const requestId = `uninstall-${u.plan.key.slice(0, 12)}`;
    return {
      state: { ...state, uninstall: { ...u, busy: true } },
      send: { type: 'confirm_package_uninstall', source: u.id, key: u.plan.key, requestId },
    };
  }

  function cancelUninstall(state) {
    if (!state.uninstall || state.uninstall.busy) return { state };
    return { state: { ...state, uninstall: null } };
  }

  function beginReview(state, id) {
    const status = state.statuses[id];
    if (state.busy || !status || status.outcome !== 'newer-available') return { state };
    const to = status.newer[status.newer.length - 1];
    return {
      state: { ...state, busy: { operation: 'package-update-plan', id }, done: null, errors: without(state.errors, id) },
      send: { type: 'plan_package_update', source: id, reference: to },
    };
  }

  function confirm(state) {
    if (!state.review || state.busy) return { state };
    const requestId = `update-${state.review.token}`;
    return {
      state: { ...state, busy: { operation: 'package-update', id: state.review.id, requestId } },
      send: { type: 'confirm_package_update', token: state.review.token, requestId },
    };
  }

  function cancel(state) {
    if (!state.review || state.busy) return { state };
    return { state: { ...state, review: null }, send: { type: 'decline_package_install', token: state.review.token } };
  }

  function reply(state, msg) {
    if (!msg || typeof msg.type !== 'string') return { state };
    if (msg.type === 'package_update_status') {
      return { state: { ...state, statuses: { ...state.statuses, [msg.id]: { outcome: msg.outcome, current: msg.current, newer: Array.isArray(msg.newer) ? msg.newer : [], moved: msg.moved || null } } } };
    }
    // Every package has answered, including none at all.
    if (msg.type === 'package_update_checked') {
      return { state: msg.id ? { ...state, checkingIds: without(state.checkingIds, msg.id) } : { ...state, checking: false } };
    }
    if (msg.type === 'package_uninstall_plan') {
      if (!state.uninstall || state.uninstall.id !== msg.id) return { state };
      return { state: { ...state, uninstall: { id: msg.id, plan: msg, busy: false } } };
    }
    if (msg.type === 'package_uninstall_result') {
      const kept = (msg.kept || []).map((k) => k.label);
      const text = kept.length
        ? `${msg.title} is uninstalled. Kept, because you edited them or they're starter files: ${kept.join(', ')}.`
        : `${msg.title} is uninstalled.`;
      return { state: { ...state, uninstall: null, statuses: without(state.statuses, msg.id), notice: { text, tone: 'neutral' } } };
    }
    if (msg.type === 'package_install_error' && /^package-uninstall/.test(msg.operation || '')) {
      const id = msg.id || (state.uninstall && state.uninstall.id);
      return { state: { ...state, uninstall: null, errors: id ? { ...state.errors, [id]: msg.message || 'That didn\'t work.' } : state.errors } };
    }
    if (msg.type === 'package_update_plan') {
      return { state: { ...state, busy: null, review: { ...msg, name: nameOf(msg.id) } } };
    }
    if (msg.type === 'package_update_result') {
      if (msg.status !== 'ready') {
        return { state: { ...state, busy: null, review: null, errors: { ...state.errors, [msg.id]: 'Something in your workspace changed while you were reviewing, so nothing was updated. Review the update again.' } } };
      }
      return { state: { ...state, busy: null, review: null, statuses: without(state.statuses, msg.id), done: { id: msg.id, name: nameOf(msg.id), to: msg.to, groups: msg.groups || {} } } };
    }
    if (msg.type === 'package_install_error' && /^package-update/.test(msg.operation || '')) {
      const id = msg.id || (state.busy && state.busy.id) || (state.review && state.review.id);
      return { state: { ...state, busy: null, checkingIds: id ? without(state.checkingIds, id) : state.checkingIds, review: msg.operation === 'package-update' ? null : state.review, errors: id ? { ...state.errors, [id]: msg.message || 'That didn\'t work.' } : state.errors } };
    }
    return { state };
  }

  const SEMVER = /^v?\d+\.\d+\.\d+$/;
  const COUNT_WORDS = [['agent', 'agent'], ['skill', 'skill'], ['routine', 'routine'], ['starter', 'starter file'], ['extension', 'extension']];
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // The status line under a package's name, and its tone: what the check
  // said, or why there is nothing to check.
  function statusFor(state, card, broken) {
    if (state.errors[card.id]) return { text: install.sentence(state.errors[card.id]), tone: 'danger' };
    if (broken) return { text: 'Rundock couldn\'t load this package\'s extension.', tone: 'danger' };
    if (!card.updatable) return { text: 'Added from a folder, so it can\'t be checked for updates.', tone: 'neutral' };
    if (!SEMVER.test(card.reference || '')) return { text: 'Installed from a commit. Paste the link again to get the latest.', tone: 'neutral' };
    const status = state.statuses[card.id];
    if (!status) return null;
    const moved = status.moved ? ` The author moved ${status.moved.tag} to different code after you added it.` : '';
    if (status.outcome === 'newer-available') {
      return { text: `Update available: ${status.newer[status.newer.length - 1]}${moved ? `.${moved}` : ''}`, tone: 'update' };
    }
    return { text: `Up to date${moved ? `.${moved}` : ''}`, tone: 'neutral' };
  }

  // One card per installed package, from the server's package cards
  // (package-state.js) and the installed-extensions roster, with the
  // actions, review, summary and uninstall question that belong to it.
  function cardRows(state, page) {
    const cards = page && Array.isArray(page.packages) ? page.packages : [];
    const roster = page && Array.isArray(page.extensions) ? page.extensions : [];
    return cards.map((card) => {
      const ext = card.extension ? roster.find((e) => e && e.id === card.extension.name) : null;
      const broken = !!(ext && ext.broken);
      const present = card.items.filter((i) => i.state !== 'absent');
      const counts = COUNT_WORDS.filter(([k]) => card.counts[k]).map(([k, w]) => plural(card.counts[k], w)).join(' · ');
      // Only an item still in the workspace links to where it lives. One
      // that is gone stays on the card, marked and not linked; one the
      // package no longer carries is marked too (a starter file is the
      // person's, so never marked for that). A gone agent's routines went
      // with it, so only a present agent's are listed.
      const entry = (i, kind, open) => {
        if (i.state === 'absent') return { label: i.label, kind, open: null, target: null, mark: 'removed' };
        return { label: i.label, kind, open, target: i.target, mark: i.carried === false && i.kind !== 'starter' ? 'no longer in the package' : null };
      };
      const items = [];
      for (const kind of ['agent', 'skill']) for (const i of card.items.filter((x) => x.kind === kind)) items.push(entry(i, kind, i.open));
      for (const i of present) for (const r of i.routines || []) items.push({ label: r, kind: 'routine', open: 'routine', target: i.target, mark: null });
      for (const i of card.items.filter((x) => x.kind === 'starter')) items.push(entry(i, 'starter file', 'file'));
      if (card.extension && !broken) items.push({ label: card.title, kind: 'extension', open: 'extension', target: card.extension.name, mark: null });
      const status = state.statuses[card.id];
      const newer = status && status.outcome === 'newer-available' ? status.newer[status.newer.length - 1] : null;
      const checkable = card.updatable && SEMVER.test(card.reference || '') && !broken;
      const checking = !!(state.checking || state.checkingIds[card.id]);
      const actions = [];
      if (newer) actions.push({ action: 'update', label: state.busy && state.busy.id === card.id ? 'Reading the update…' : `Update to ${newer}`, accent: true, disabled: !!state.busy });
      else if (checkable) actions.push({ action: 'check', label: checking ? 'Checking…' : 'Check for updates', accent: false, disabled: checking });
      actions.push({ action: 'uninstall', label: 'Uninstall', danger: true, disabled: !!(state.uninstall && state.uninstall.busy) });
      const uninstall = state.uninstall && state.uninstall.id === card.id && state.uninstall.plan ? uninstallCopy(state.uninstall, card.title) : null;
      return {
        id: card.id, title: card.title,
        version: SEMVER.test(card.reference || '') ? card.reference : card.commit ? card.commit.slice(0, 7) : (card.reference || null),
        repoLabel: card.updatable ? `github.com/${card.repo}` : card.repo,
        repoUrl: card.updatable ? card.id : null,
        chip: broken ? 'Couldn\'t load' : null,
        status: statusFor(state, card, broken),
        counts, items, actions,
        review: state.review && state.review.id === card.id ? reviewCopy(state, card.title) : null,
        done: state.done && state.done.id === card.id ? doneCopy(state, card.title) : null,
        uninstall,
      };
    });
  }

  function uninstallCopy(u, title) {
    const KIND = { agent: 'agent', skill: 'skill', starter: 'starter file' };
    const goes = u.plan.goes.map((g) => `${g.label} (${KIND[g.kind] || g.kind})`);
    if (u.plan.extension) goes.push(`${title} (extension)`);
    const stays = u.plan.stays.map((s) => (s.why === 'edited' ? `${s.label} (${KIND[s.kind] || s.kind}), edited since install` : `${s.label} (${KIND[s.kind] || s.kind})`));
    return {
      title: `Uninstall ${title}?`,
      groups: [
        ...(goes.length ? [{ label: 'Goes', sub: 'Unchanged since install.', items: goes }] : []),
        ...(stays.length ? [{ label: 'Stays', sub: 'Anything you edited, and every starter file.', items: stays }] : []),
      ],
      nothing: goes.length ? null : 'Nothing of this package is left as it was installed, so nothing is removed. It leaves this list.',
      confirmLabel: u.busy ? 'Uninstalling…' : `Uninstall ${title}`,
      cancelLabel: 'Cancel',
      disabled: !!u.busy,
    };
  }

  function itemLabel(entry) {
    const label = `${entry.slug} (${KIND_WORDS[entry.kind] || entry.kind})`;
    if (!entry.alongside) return label;
    return entry.alongsideKept
      ? `${entry.slug}: a file of yours already has the name ${entry.alongside}, so the new template was not added`
      : `${entry.alongside}, beside ${entry.slug}`;
  }

  function extensionLines(ext) {
    if (!ext) return [];
    const added = ext.added || {};
    const lines = [];
    if (added.writes) lines.push(install.writeClaim(ext.manifest || {}));
    if (added.sources) lines.push(...install.sourcesClaims(ext.manifest || {}));
    if (added.asks && added.asks.length) lines.push(install.askClaim({ asks: added.asks }));
    return lines.filter(Boolean);
  }

  function reviewCopy(state, title) {
    const r = state.review;
    if (!r) return null;
    const name = title || r.name;
    const groups = [];
    for (const [key, label, sub] of GROUPS) {
      const entries = (r.groups && r.groups[key]) || [];
      const items = entries.map((e) => ({
        label: itemLabel(e),
        routines: (r.routines && r.routines[e.id] || []).map((routine) => install.routineSentence('This agent', routine)),
      }));
      if (key === 'author-changed' && r.extension) {
        items.push({ label: `${r.extension.manifest.name} (extension) → v${r.extension.manifest.version}`, routines: [], privileges: extensionLines(r.extension) });
      }
      if (items.length) groups.push({ key, label, sub, items });
    }
    const changes = ((r.groups && r.groups['author-changed']) || []).length + ((r.groups && r.groups.new) || []).length + (r.extension ? 1 : 0);
    const kept = ['both-changed', 'acts-without-asking', 'path-taken', 'unknown', 'edited'].reduce((n, k) => n + ((r.groups && r.groups[k]) || []).length, 0);
    return {
      title: `Update ${name} to ${r.to}?`,
      groups,
      summary: `${changes} ${changes === 1 ? 'change' : 'changes'}, ${kept} of yours kept.`,
      note: 'Your starter files are never touched.',
      confirmLabel: state.busy ? 'Updating…' : `Update ${name}`,
      cancelLabel: 'Cancel',
      disabled: !!state.busy,
    };
  }

  // The ready-made prompt: every file the person should look at, paired with
  // what the update saved or added beside it. Sent nowhere; the view copies it.
  function mergePrompt(done, title) {
    if (!done) return null;
    const name = title || done.name;
    const saved = [];
    for (const entries of Object.values(done.groups || {})) {
      for (const e of entries) if (e.saveAuthor && e.saved) saved.push(`- ${e.destination} and ${e.saved}`);
    }
    const migrate = ((done.groups || {})['starter-alongside'] || []).filter((e) => e.alongside && !e.alongsideKept)
      .map((e) => `- ${e.slug} into ${e.alongside}`);
    if (!saved.length && !migrate.length) return null;
    const parts = [`I have just updated ${name} to ${done.to}.`];
    if (saved.length) {
      parts.push(`For each pair below, the first file is mine and the second is the author's new version. Merge the author's changes into my file without losing my edits, show me the result before saving, and leave the author's copy as it is.\n${saved.join('\n')}`);
    }
    if (migrate.length) {
      parts.push(`Move my data from each old file into the new template beside it, in the new format. Show me the result before saving, and keep the old file as it is.\n${migrate.join('\n')}`);
    }
    return parts.join('\n\n');
  }

  function doneCopy(state, title) {
    if (!state.done) return null;
    const name = title || state.done.name;
    const prompt = mergePrompt(state.done, name);
    return {
      text: `${name} is updated to ${state.done.to}.`,
      prompt,
      promptLead: prompt ? 'Some of your files were kept as they are. To bring the author\'s changes in, copy this and ask an agent:' : null,
    };
  }

  function workspaceChanged() {
    return initial();
  }

  function dismissDone(state) { return { state: { ...state, done: null } }; }

  return {
    initial, checkAll, checkOne, beginReview, confirm, cancel, reply, cardRows, statusFor, reviewCopy, doneCopy, mergePrompt,
    beginUninstall, confirmUninstall, cancelUninstall, dismissDone, workspaceChanged, GROUPS,
  };
}));
