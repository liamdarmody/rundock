'use strict';
/**
 * The install flow's model: which of PL4's states the flow is in, every word
 * it says, and the only two messages it is ever allowed to send.
 *
 * WHY THIS IS A MODULE AND NOT A VIEW: the same reason the routines model is
 * one. Everything this flow is judged on is copy, a state rule, or a promise
 * about what gets sent when, and promises about sending are exactly the ones
 * a browser-only implementation lets rot. Here, every transition returns
 * `{ state, send }`, `send` is undefined unless the person explicitly asked
 * for something, and the suite exhausts the transitions.
 *
 * THE RULING THIS FILE HOLDS: nothing is silent, and collisions fail closed.
 * Planning happens only on submit; writing happens only on confirm; cancel
 * sends nothing at all. And a plan containing any colliding item can never
 * produce an apply message from this flow, because deciding a collision is a
 * per-item choice this slice does not offer, and defaulting that choice in
 * either direction is an unreviewed write or a silent loss.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else root.RundockPackagesInstallModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function initial() {
    return { phase: 'idle', sourcePath: '', fieldError: null };
  }

  function count(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function submit(state, rawPath) {
    const sourcePath = String(rawPath || '').trim();
    if (!sourcePath) {
      return { state: { ...initial(), fieldError: 'Enter the path of the package folder to read.' } };
    }
    return {
      state: { phase: 'classifying', sourcePath },
      send: { type: 'plan_package_import', sourcePath, source: { id: sourcePath, reference: null } },
    };
  }

  function planReply(state, msg) {
    if (state.phase !== 'classifying') return { state };
    if (msg.type === 'package_import_error') {
      if (/no agents and no skills/.test(msg.message || '')) {
        return { state: { phase: 'nothing-usable', sourcePath: state.sourcePath } };
      }
      return { state: { phase: 'failed', sourcePath: state.sourcePath, message: msg.message || 'The package could not be read.' } };
    }
    const items = msg.plan.items;
    return {
      state: {
        phase: 'offer',
        sourcePath: state.sourcePath,
        plan: msg.plan,
        agents: items.filter((i) => i.kind === 'agent').length,
        skills: items.filter((i) => i.kind === 'skill').length,
        collisions: items.filter((i) => i.collision).map((i) => ({ id: i.id, kind: i.kind, slug: i.slug })),
      },
    };
  }

  // PL4's decided treatment: the plain confirm-card, no amber, because
  // nothing in a content-only import executes at install time.
  function offerCopy(state) {
    return {
      headline: "This isn't a Rundock package",
      body: `Rundock found ${count(state.agents, 'agent')} and ${count(state.skills, 'skill')} built for Claude Code. `
        + "They're not sandboxed: once added they act with the same access your own agents have. "
        + 'Nothing runs until you add them.',
      confirmLabel: 'Add to my team',
      cancelLabel: 'Cancel',
      confirmDisabled: state.collisions.length > 0,
      collisionNote: state.collisions.length === 0 ? null
        : `${count(state.collisions.length, 'item')} here (${state.collisions.map((c) => c.slug).join(', ')}) `
          + 'already exist in your workspace. Each needs its own keep-or-replace decision, which this flow '
          + 'does not offer yet, so nothing can be added from this package here.',
    };
  }

  // Cancel sends nothing: the person changed their mind, and a flow that has
  // written nothing has nothing to say to the server about it.
  function cancel() {
    return { state: initial() };
  }

  // The all-add approval. For a decision set with no skips this is
  // byte-identical to lib/packages/import-plan.js decide(plan, allAdd),
  // which the focused unit suite pins with a deep equality against the real
  // function, so this cannot drift from the one true decision contract.
  function allAddApproval(plan) {
    return {
      schema: plan.schema,
      source: plan.source,
      manifest: plan.manifest,
      items: plan.items.map((item) => ({ ...item, decision: 'add' })),
    };
  }

  function confirm(state) {
    if (state.phase !== 'offer') return { state };
    if (state.collisions.length > 0) return { state };
    return {
      state: { phase: 'applying', sourcePath: state.sourcePath },
      send: { type: 'apply_package_import', sourcePath: state.sourcePath, approval: allAddApproval(state.plan) },
    };
  }

  function reasonWords(reason) {
    if (reason === 'default-conflict') return 'this would give your team a second default agent';
    if (reason === 'destination-changed') return 'the workspace changed after you reviewed it';
    if (reason === 'source-changed' || reason === 'source-missing') return 'the package changed after you reviewed it';
    return reason;
  }

  function applyReply(state, msg) {
    if (state.phase !== 'applying') return { state };
    if (msg.type === 'package_import_error') {
      return { state: { phase: 'failed', sourcePath: state.sourcePath, message: msg.message || 'The import could not be applied.' } };
    }
    if (msg.status === 'stale') {
      return {
        state: {
          phase: 'failed',
          sourcePath: state.sourcePath,
          message: 'Nothing was added: ' + msg.stale.map((s) => `${s.id.split(':')[1]}, because ${reasonWords(s.reason)}`).join('; ')
            + '. Review the package again to continue.',
          canReplan: true,
        },
      };
    }
    // 'ready' lands writes; 'decisions-blocked' lands nothing. Both render as
    // the outcome they actually produced, named item by item.
    return {
      state: {
        phase: 'done',
        sourcePath: state.sourcePath,
        written: (msg.writes || []).map((w) => ({ id: w.id, kind: w.kind, destination: w.destination })),
        blocked: (msg.blocked || []).map((b) => ({ id: b.id, slug: b.id.split(':')[1], reason: reasonWords(b.reason) })),
        receipt: msg.receipt || null,
      },
    };
  }

  function doneCopy(state) {
    return {
      headline: state.written.length > 0 ? 'Added to your team' : 'Nothing was added',
      parts: state.written.map((w) => ({ label: w.id.split(':')[1], kind: w.kind, destination: w.destination })),
      blockedLines: state.blocked.map((b) => `${b.slug}: not added, because ${b.reason}`),
    };
  }

  function retry(state) {
    if (!state.sourcePath) return { state: initial() };
    return submit(initial(), state.sourcePath);
  }

  return { initial, submit, planReply, offerCopy, cancel, confirm, applyReply, doneCopy, retry, allAddApproval };
}));
