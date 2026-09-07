'use strict';
/**
 * The install flow's model: which of PL4's states the flow is in, every word
 * it says, and the only messages it is ever allowed to send.
 *
 * WHY THIS IS A MODULE AND NOT A VIEW: the same reason the routines model is
 * one. Everything this flow is judged on is copy, a state rule, or a promise
 * about what gets sent when, and promises about sending are exactly the ones
 * a browser-only implementation lets rot. Here, every transition returns
 * `{ state, send }`, `send` is undefined unless the person explicitly asked
 * for something, and the suite exhausts the transitions.
 *
 * ONE LINK FIELD FOR BOTH KINDS. The person pastes a GitHub link and, when
 * they have one, a pin; the server acquires the snapshot and classifies it
 * from its bytes. A manifest with an extension block comes back as a trust
 * step; anything else comes back as the "not a Rundock package" offer of
 * whatever agents and skills were found. The client never names a path.
 *
 * EVERY REPLY IS MATCHED TO THE REQUEST THAT PRODUCED IT, by operation and
 * token, never by type alone: an error raised by an uninstall or an update
 * check arriving while an install is in flight is somebody else's answer,
 * and it leaves this flow exactly where it was.
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
    return { phase: 'idle', link: '', reference: '', fieldError: null };
  }

  function count(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function carried(state) {
    return { link: state.link, reference: state.reference };
  }

  function submit(state, rawLink, rawReference) {
    const link = String(rawLink || '').trim();
    const reference = String(rawReference || '').trim();
    if (!link) {
      return { state: { ...initial(), reference, fieldError: 'Paste the GitHub link of the repository to read.' } };
    }
    return {
      state: { phase: 'classifying', link, reference, outstanding: { operation: 'plan', token: null } },
      // The pin is optional here because agents and skills may arrive
      // unpinned; the server asks for it if the bytes turn out to be code.
      send: { type: 'plan_package_install', url: link, reference: reference || null },
    };
  }

  // The correlation rule: a reply belongs to this flow only when it names
  // the operation the flow is waiting on and, once a token has been issued,
  // that token. A plan request has no token yet, so its reply is matched by
  // operation alone and the token it carries is adopted from there.
  function correlated(state, msg) {
    const waiting = state.outstanding;
    if (!waiting || !msg || msg.operation !== waiting.operation) return false;
    return waiting.token === null || msg.token === waiting.token;
  }

  // The one reply entry: the correlation rule decides whether the reply is
  // ours at all, and the model's own phase decides which handler runs.
  function reply(state, msg) {
    if (!correlated(state, msg)) return { state };
    if (state.phase === 'classifying') return planReply(state, msg);
    if (state.phase === 'applying') return applyReply(state, msg);
    if (state.phase === 'installing') return installReply(state, msg);
    return { state };
  }

  function isError(msg) {
    return msg.type === 'package_install_error' || msg.type === 'package_import_error';
  }

  function offerFrom(carry, token, plan, installed) {
    const items = plan.items;
    return {
      state: {
        phase: 'offer',
        ...carry,
        token,
        plan,
        installed: installed || null,
        agents: items.filter((i) => i.kind === 'agent').length,
        skills: items.filter((i) => i.kind === 'skill').length,
        collisions: items.filter((i) => i.collision).map((i) => ({ id: i.id, kind: i.kind, slug: i.slug })),
      },
    };
  }

  function planReply(state, msg) {
    if (state.phase !== 'classifying') return { state };
    const carry = carried(state);
    if (isError(msg)) {
      // Classified by code, never by message prose: the wording belongs to
      // the producer and may change without ceremony.
      if (msg.code === 'empty-package') {
        return { state: { phase: 'nothing-usable', ...carry } };
      }
      // The bytes are an extension and no pin was given: the field asks for
      // it, with the link kept, rather than a dead end.
      if (msg.code === 'unpinned-reference') {
        return { state: { ...initial(), ...carry, fieldError: msg.message } };
      }
      return { state: { phase: 'failed', ...carry, message: msg.message || 'The package could not be read.' } };
    }
    if (msg.type === 'extension_install_plan') {
      return {
        state: {
          phase: 'trust', ...carry, token: msg.token,
          manifest: msg.manifest, facts: msg.facts, replaces: msg.replaces || null,
        },
      };
    }
    return offerFrom(carry, msg.token || null, msg.plan, null);
  }

  // PL4's decided treatment: the plain confirm-card, no amber, because
  // nothing in a content-only import executes at install time.
  function offerCopy(state) {
    return {
      headline: state.installed
        ? `${state.installed.name} ${state.installed.version} is installed. Add its agents and skills too?`
        : "This isn't a Rundock package",
      body: `Rundock found ${count(state.agents, 'agent')} and ${count(state.skills, 'skill')} built for Claude Code. `
        + "They're not sandboxed: once added they act with the same access your own agents have. "
        + 'Nothing runs until you add them.',
      confirmLabel: 'Add to my team',
      cancelLabel: state.installed ? 'No, keep only the extension' : 'Cancel',
      confirmDisabled: state.collisions.length > 0,
      collisionNote: state.collisions.length === 0 ? null
        : `${count(state.collisions.length, 'item')} here (${state.collisions.map((c) => c.slug).join(', ')}) `
          + 'already exist in your workspace. Each needs its own keep-or-replace decision, which this flow '
          + 'does not offer yet, so nothing can be added from this package here.',
    };
  }

  // Cancel sends nothing: the person changed their mind, and a flow that has
  // written nothing has nothing to say to the server about it. It is the way
  // out of every state that holds nothing on the server.
  function cancel() {
    return { state: initial() };
  }

  // Decline DOES send, because the server is holding an acquired snapshot
  // under this token and "no" has to reach the thing that can discard it. It
  // still installs nothing, and the flow returns to its start.
  function decline(state) {
    if (state.phase !== 'offer' && state.phase !== 'trust') return { state };
    if (!state.token) return cancel();
    return { state: initial(), send: { type: 'decline_package_install', token: state.token } };
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
    if (state.phase === 'trust') {
      return {
        state: { phase: 'installing', ...carried(state), token: state.token, outstanding: { operation: 'install', token: state.token } },
        send: { type: 'confirm_extension_install', token: state.token },
      };
    }
    if (state.phase !== 'offer') return { state };
    if (state.collisions.length > 0) return { state };
    return {
      state: { phase: 'applying', ...carried(state), installed: state.installed || null, outstanding: { operation: 'apply', token: state.token || null } },
      send: { type: 'confirm_package_install', token: state.token || null, approval: allAddApproval(state.plan) },
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
    const carry = carried(state);
    if (isError(msg)) {
      return { state: { phase: 'failed', ...carry, message: msg.message || 'The import could not be applied.' } };
    }
    if (msg.status === 'stale') {
      return {
        state: {
          phase: 'failed',
          ...carry,
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
        ...carry,
        installed: state.installed || null,
        written: (msg.writes || []).map((w) => ({ id: w.id, kind: w.kind, destination: w.destination })),
        blocked: (msg.blocked || []).map((b) => ({ id: b.id, slug: b.id.split(':')[1], reason: reasonWords(b.reason) })),
        receipt: msg.receipt || null,
      },
    };
  }

  // The extension half landed. When the repository also carried agents and
  // skills, the server kept the snapshot and the reply carries their plan:
  // the flow moves to the offer as the second step the trust card promised,
  // and nothing about them lands until the person answers that.
  function installReply(state, msg) {
    if (state.phase !== 'installing') return { state };
    const carry = carried(state);
    if (isError(msg)) {
      return { state: { phase: 'failed', ...carry, message: msg.message || 'The extension could not be installed.' } };
    }
    if (msg.content && msg.content.plan) return offerFrom(carry, msg.content.token, msg.content.plan, msg.record);
    return { state: { phase: 'done', ...carry, installed: msg.record, written: [], blocked: [], receipt: null } };
  }

  function doneCopy(state) {
    const ext = state.installed;
    const parts = state.written.map((w) => ({ label: w.id.split(':')[1], kind: w.kind, destination: w.destination }));
    return {
      headline: ext ? `Installed ${ext.name} ${ext.version}`
        : (state.written.length > 0 ? 'Added to your team' : 'Nothing was added'),
      parts: ext ? [{ label: `${ext.name} extension, ${ext.version}`, kind: 'extension', destination: ext.root }, ...parts] : parts,
      blockedLines: state.blocked.map((b) => `${b.slug}: not added, because ${b.reason}`),
      note: ext ? `Pinned at ${ext.source.reference}. Update checks read this record, so you never enter the link again.` : null,
    };
  }

  // A dropped connection ends any wait: for a lost plan the person just
  // reads again; for a lost apply the truth is unknown, because the write
  // may or may not have landed, so the copy claims neither and points at
  // where the answer actually lives. An offer or trust step whose token the
  // server issued dies with the connection, because the server releases the
  // snapshot when the socket closes.
  function connectionLost(state) {
    const carry = carried(state);
    if (state.phase === 'classifying') {
      return { state: { phase: 'failed', ...carry, message: 'The connection dropped before an answer arrived. Nothing was added. Read the package again to continue.', canReplan: true } };
    }
    if ((state.phase === 'offer' || state.phase === 'trust') && state.token) {
      return { state: { phase: 'failed', ...carry, message: 'The connection dropped. Nothing was installed. Read the package again to continue.', canReplan: true } };
    }
    if (state.phase === 'applying') {
      return { state: { phase: 'failed', ...carry, message: 'The connection dropped while adding. The import may or may not have completed: check your team and the receipts in .claude/rundock/receipts to see what arrived, then read the package again if it did not.', canReplan: true } };
    }
    if (state.phase === 'installing') {
      return { state: { phase: 'failed', ...carry, message: 'The connection dropped while installing. Check Settings for whether it arrived, then read the package again if it did not.', canReplan: true } };
    }
    return { state };
  }

  function retry(state) {
    if (!state.link) return { state: initial() };
    return submit(initial(), state.link, state.reference);
  }

  // ---- The trust step: the one state that runs third-party code.

  // Facts the host enforces, in the shape the host module exports them. The
  // trust card's safety claims are generated from this table, one sentence
  // per fact, and the focused suite compares it to the host's own tables and
  // to the contract document, so a claim can never outlive the thing that
  // makes it true. `init` names the fields of the opened file the frame is
  // told about; the host's own suite binds it to the contract document's
  // init row once that row exists.
  const HOST_FACTS = {
    sandbox: 'allow-scripts',
    network: "default-src 'none'",
    messages: ['ready', 'resize', 'error', 'open'],
    init: ['path', 'content'],
  };

  function hostClaims(facts) {
    return [
      `Its view runs in a frame whose only sandbox grant is ${facts.sandbox}: an opaque origin with no access to Rundock's page, storage or scripts.`,
      `The frame's own policy is ${facts.network}: it cannot load or contact anything on the network.`,
      `It can send Rundock only these messages: ${facts.messages.join(', ')}. Anything else is refused.`,
      `It receives the opened file's ${facts.init.join(' and ')}, read-only, and nothing else about your workspace.`,
    ];
  }

  // The consent screen's whole text, split the way PL4 splits it: what will
  // run (the view, inside the host's enforced boundary) and what you will
  // keep (agents and skills, which are ordinary files and not sandboxed).
  // The facts line says the list was read from the package, because derived
  // facts beat declared intentions and the reader should know which kind
  // these are. Each half states plainly what confirm does with it, and the
  // focused suite holds the filesystem to those two sentences.
  function trustCopy(state) {
    const f = state.facts;
    const name = state.manifest.name;
    const both = f.agents > 0 || f.skills > 0;
    return {
      headline: `Install ${name} ${state.manifest.version}?`,
      sourceLine: `From ${state.link}, pinned to ${state.reference}.`,
      factsLead: 'Read from the package itself, not from its author:',
      files: f.files,
      matchLine: `It asks to render files matching: ${f.match}`,
      runsHeading: 'What will run',
      runsLines: hostClaims(HOST_FACTS),
      keepsHeading: 'What you will keep',
      halves: {
        extension: `Install puts the view above under .claude/rundock/extensions/${name}, where uninstall can remove it.`,
        content: both
          ? `The ${count(f.agents, 'agent')} and ${count(f.skills, 'skill')} in this repository are not added by this step. `
            + 'Once the extension is installed you are offered them separately, and nothing about them lands until you answer that. '
            + 'They are not sandboxed: once added they act with the same access your own agents have.'
          : 'It adds no agents and no skills.',
      },
      reviewLine: 'Rundock does not review extensions; what you install is your choice.',
      replacesLine: state.replaces
        ? `This replaces the installed ${state.replaces.version} (pinned at ${state.replaces.reference}).`
        : null,
      confirmLabel: 'Install it',
      declineLabel: 'No, remove what was fetched',
    };
  }

  return { initial, submit, reply, planReply, offerCopy, cancel, decline, confirm, applyReply, installReply, doneCopy,
    retry, connectionLost, allAddApproval, HOST_FACTS, hostClaims, trustCopy };
}));
