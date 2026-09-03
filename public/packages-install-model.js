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

  // The one reply entry: the model's own phase decides which handler runs,
  // so no routing ever depends on a wire field the model has not verified.
  function reply(state, msg) {
    if (state.phase === 'classifying') return planReply(state, msg);
    if (state.phase === 'applying') return applyReply(state, msg);
    return { state };
  }

  function planReply(state, msg) {
    if (state.phase !== 'classifying') return { state };
    if (msg.type === 'package_import_error') {
      // Classified by code, never by message prose: the wording belongs to
      // the producer and may change without ceremony.
      if (msg.code === 'empty-package') {
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

  // The approval is built by THE decision contract itself: the shared
  // decide from packages-decide.js, loaded by script tag in the browser and
  // required here under Node, with every item decided add.
  function sharedDecide() {
    if (typeof module === 'object' && module.exports) return require('./packages-decide.js').decide;
    return RundockPackagesDecide.decide;
  }

  function allAddApproval(plan) {
    const decisions = {};
    for (const item of plan.items) decisions[item.id] = 'add';
    return sharedDecide()(plan, decisions);
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

  // A dropped connection ends any wait: for a lost plan the person just
  // reads again; for a lost apply the truth is unknown, because the write
  // may or may not have landed, so the copy claims neither and points at
  // where the answer actually lives.
  function connectionLost(state) {
    if (state.phase === 'classifying') {
      return { state: { phase: 'failed', sourcePath: state.sourcePath, message: 'The connection dropped before an answer arrived. Nothing was added. Read the package again to continue.', canReplan: true } };
    }
    if (state.phase === 'applying') {
      return { state: { phase: 'failed', sourcePath: state.sourcePath, message: 'The connection dropped while adding. The import may or may not have completed: check your team and the receipts in .claude/rundock/receipts to see what arrived, then read the package again if it did not.', canReplan: true } };
    }
    return { state };
  }

  function retry(state) {
    if (!state.sourcePath) return { state: initial() };
    return submit(initial(), state.sourcePath);
  }

  // ---- The extension install flow: URL and pin in, trust step, one answer.
  //
  // Same discipline as the pack flow above: every transition returns
  // { state, send }, send exists only when the person explicitly asked for
  // something, and the trust step's words live here where a suite can hold
  // them. Decline DOES send, unlike the pack flow's cancel, because the
  // server is holding an acquired snapshot for this offer and "no" has to
  // reach the thing that can discard it; it still installs nothing.

  function extInitial() {
    return { phase: 'ext-idle', url: '', reference: '', fieldError: null };
  }

  function extSubmit(state, rawUrl, rawReference) {
    const url = String(rawUrl || '').trim();
    const reference = String(rawReference || '').trim();
    if (!url || !reference) {
      return { state: { ...extInitial(), url, reference,
        fieldError: 'Enter the repository URL and the exact tag, release or commit to install.' } };
    }
    return {
      state: { phase: 'ext-acquiring', url, reference },
      send: { type: 'plan_extension_install', url, reference },
    };
  }

  function extReply(state, msg) {
    if (state.phase === 'ext-acquiring') {
      if (msg.type === 'extension_install_error') {
        return { state: { phase: 'ext-failed', url: state.url, reference: state.reference,
          message: msg.message || 'The extension could not be read.' } };
      }
      if (msg.type === 'extension_install_plan') {
        return { state: { phase: 'ext-trust', url: state.url, reference: state.reference,
          token: msg.token, manifest: msg.manifest, facts: msg.facts, replaces: msg.replaces || null } };
      }
      return { state };
    }
    if (state.phase === 'ext-installing') {
      if (msg.type === 'extension_install_error') {
        return { state: { phase: 'ext-failed', url: state.url, reference: state.reference,
          message: msg.message || 'The extension could not be installed.' } };
      }
      if (msg.type === 'extension_install_result') {
        return { state: { phase: 'ext-done', record: msg.record } };
      }
      return { state };
    }
    return { state };
  }

  function extCount(n, word) { return count(n, word); }

  // The consent screen's whole text. The boundary it describes only covers
  // half the package, and the copy says which half: the view is sandboxed,
  // the agents and skills are not, and they are the larger part of what a
  // person is trusting. The facts line says the list was read from the
  // package, because derived facts beat declared intentions and the reader
  // should know which kind these are.
  function extTrustCopy(state) {
    const f = state.facts;
    const contentLine = (f.agents || f.skills)
      ? `It also adds ${extCount(f.agents, 'agent')} and ${extCount(f.skills, 'skill')}. They are not sandboxed: once added they act with the same access your own agents have. They are the larger part of what you are trusting here. `
      : 'It adds no agents and no skills. ';
    return {
      headline: `Install ${state.manifest.name} ${state.manifest.version}?`,
      factsLead: 'Read from the package itself, not from its author:',
      body: `This extension ships a view that runs sandboxed, in an isolated frame that cannot reach your files, your conversations or your permissions. ${contentLine}`
        + 'Rundock does not review extensions; what you install is your choice.',
      files: f.files,
      matchLine: `It asks to render files matching: ${f.match}`,
      replacesLine: state.replaces
        ? `This replaces the installed ${state.replaces.version} (pinned at ${state.replaces.reference}).`
        : null,
      sourceLine: `From ${state.url} at ${state.reference}.`,
      confirmLabel: 'Install it',
      declineLabel: 'No, remove what was fetched',
    };
  }

  function extConfirm(state) {
    if (state.phase !== 'ext-trust') return { state };
    return {
      state: { phase: 'ext-installing', url: state.url, reference: state.reference },
      send: { type: 'confirm_extension_install', token: state.token },
    };
  }

  function extDecline(state) {
    if (state.phase !== 'ext-trust') return { state };
    return { state: extInitial(), send: { type: 'decline_extension_install', token: state.token } };
  }

  function extConnectionLost(state) {
    if (state.phase === 'ext-acquiring' || state.phase === 'ext-trust') {
      return { state: { phase: 'ext-failed', url: state.url, reference: state.reference,
        message: 'The connection dropped. Nothing was installed. Read the extension again to continue.' } };
    }
    if (state.phase === 'ext-installing') {
      return { state: { phase: 'ext-failed', url: state.url, reference: state.reference,
        message: 'The connection dropped while installing. Check Settings for whether it arrived, then read the extension again if it did not.' } };
    }
    return { state };
  }

  return { initial, submit, reply, planReply, offerCopy, cancel, confirm, applyReply, doneCopy, retry, connectionLost, allAddApproval,
    extInitial, extSubmit, extReply, extTrustCopy, extConfirm, extDecline, extConnectionLost };
}));
