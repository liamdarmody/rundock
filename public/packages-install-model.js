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
  // A result arriving in the offer phase is the review's own projection (the
  // server evaluated the current decisions without writing), which is why no
  // new wire type exists for it: it is an import result, computed not applied.
  function reply(state, msg) {
    if (state.phase === 'classifying') return planReply(state, msg);
    if (state.phase === 'offer') return evaluationReply(state, msg);
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
    // NOTHING IS SILENTLY OVERWRITTEN: every colliding item starts decided
    // skip, so a person who reviews the list and moves on keeps what they
    // already have, and overwrite always requires a deliberate switch.
    const decisions = {};
    for (const item of items) decisions[item.id] = item.collision ? 'skip' : 'add';
    const offer = {
      phase: 'offer',
      sourcePath: state.sourcePath,
      plan: msg.plan,
      agents: items.filter((i) => i.kind === 'agent').length,
      skills: items.filter((i) => i.kind === 'skill').length,
      collisions: items.filter((i) => i.collision).map((i) => ({ id: i.id, kind: i.kind, slug: i.slug })),
      decisions,
      projection: null,
    };
    if (offer.collisions.length === 0) return { state: offer };
    // A review with decisions to make is projected by the one evaluator on
    // the server, never by a second copy of its rules here: the same message
    // family that applies an import evaluates it, without writing.
    return { state: offer, send: evaluateMessage(offer) };
  }

  function decisionsFor(state) {
    const decisions = {};
    for (const item of state.plan.items) decisions[item.id] = state.decisions[item.id];
    return decisions;
  }

  function evaluateMessage(state) {
    return {
      type: 'evaluate_package_decisions',
      sourcePath: state.sourcePath,
      approval: sharedDecide()(state.plan, decisionsFor(state)),
    };
  }

  // One decision, changed. Only combinations the evaluator itself accepts
  // can be chosen: a colliding item is overwritten or skipped, a new item is
  // added or skipped (skipping a new item is how a blocked row clears its
  // conflict). Anything else is refused unchanged, and every change asks the
  // server to project the result so blocking is never computed locally.
  function setDecision(state, id, decision) {
    if (state.phase !== 'offer') return { state };
    const item = state.plan.items.filter((i) => i.id === id)[0];
    if (!item) return { state };
    const allowed = item.collision ? ['overwrite', 'skip'] : ['add', 'skip'];
    if (allowed.indexOf(decision) === -1) return { state };
    if (state.decisions[id] === decision) return { state };
    const next = { ...state, decisions: { ...state.decisions, [id]: decision }, projection: null };
    return { state: next, send: evaluateMessage(next) };
  }

  // What the projection said about the current decisions. Stale voids the
  // whole review, per the state model: the workspace or source moved, so
  // every choice above no longer describes what is actually there.
  function evaluationReply(state, msg) {
    if (state.phase !== 'offer') return { state };
    if (msg.type === 'package_import_error') {
      return { state: { phase: 'failed', sourcePath: state.sourcePath, message: msg.message || 'The review could not be checked.', canReplan: true } };
    }
    if (msg.type !== 'package_import_result') return { state };
    if (msg.status === 'stale') {
      return { state: { phase: 'stale', sourcePath: state.sourcePath } };
    }
    return {
      state: {
        ...state,
        projection: {
          status: msg.status,
          blocked: (msg.blocked || []).map((b) => ({ id: b.id, reason: b.reason })),
        },
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
      confirmDisabled: false,
    };
  }

  // Cancel sends nothing: the person changed their mind, and a flow that has
  // written nothing has nothing to say to the server about it.
  function cancel() {
    return { state: initial() };
  }

  // The approval is built by THE decision contract itself: the shared
  // decide from packages-decide.js, loaded by script tag in the browser and
  // required here under Node, carrying exactly the decisions on the review.
  function sharedDecide() {
    if (typeof module === 'object' && module.exports) return require('./packages-decide.js').decide;
    return RundockPackagesDecide.decide;
  }

  function confirm(state) {
    if (state.phase !== 'offer') return { state };
    return {
      state: { phase: 'applying', sourcePath: state.sourcePath },
      send: { type: 'apply_package_import', sourcePath: state.sourcePath, approval: sharedDecide()(state.plan, decisionsFor(state)) },
    };
  }

  // THE TONE EACH REVIEW CLASS CARRIES, in one place so a walk can prove the
  // ruling: nothing on this surface executes anything, so nothing here takes
  // the danger tone except the one state where the person's review work has
  // been voided under them. Blocked is attention, per the state model's own
  // convention that a notice where nothing broke does not reach for danger.
  var REVIEW_TONES = {
    willAdd: 'success',
    collision: 'neutral',
    skippedNew: 'neutral',
    blocked: 'attention',
    stale: 'danger',
  };

  // WHERE EACH EVALUATOR BUCKET REACHES THIS SURFACE. The keys are the
  // evaluator's own result shape; a bucket added there without a home here
  // fails the walk that compares the two, so an outcome can never be
  // computed that this surface silently has no words for.
  var RESULT_RENDERINGS = {
    status: 'routes the review: stale voids it, ready and decisions-blocked keep it open',
    writes: 'the will-add and overwrite rows, counted into the confirm label',
    unchanged: 'a collision whose bytes already match what arrives, said on its row',
    skipped: 'the skip rows, counted into the confirm label',
    blocked: 'the blocked treatment on the rows the projection names',
    stale: 'the review-void state over the whole card',
  };

  function reviewRowClass(state, item) {
    const blocked = !!(state.projection
      && state.projection.blocked.some((b) => b.id === item.id));
    if (blocked) return 'blocked';
    if (item.collision) return 'collision';
    return state.decisions[item.id] === 'skip' ? 'skippedNew' : 'willAdd';
  }

  function reviewCounts(state) {
    const counts = { adds: 0, overwrites: 0, skips: 0, blocked: 0 };
    for (const item of state.plan.items) {
      const rowClass = reviewRowClass(state, item);
      if (rowClass === 'blocked') counts.blocked += 1;
      else if (state.decisions[item.id] === 'skip') counts.skips += 1;
      else if (item.collision) counts.overwrites += 1;
      else counts.adds += 1;
    }
    return counts;
  }

  // The confirm button's own label carries the breakdown, the same honesty
  // rule as the success receipts: never a generic Confirm with the detail
  // left to body copy underneath.
  function confirmLabel(counts) {
    if (counts.adds === 0 && counts.overwrites === 0 && counts.blocked === 0 && counts.skips > 0) {
      return `Skip ${counts.skips}, nothing added`;
    }
    const parts = [];
    if (counts.adds) parts.push(`add ${counts.adds}`);
    if (counts.overwrites) parts.push(`overwrite ${counts.overwrites}`);
    if (counts.skips) parts.push(`skip ${counts.skips}`);
    if (counts.blocked) parts.push(`${counts.blocked} blocked`);
    const joined = parts.join(', ');
    return joined.charAt(0).toUpperCase() + joined.slice(1);
  }

  function reviewCopy(state) {
    const counts = reviewCounts(state);
    const rows = state.plan.items.map((item) => {
      const rowClass = reviewRowClass(state, item);
      const identical = item.collision && item.plannedDigest === item.approvedDigest;
      return {
        id: item.id,
        name: item.slug,
        kind: item.kind,
        rowClass,
        tone: REVIEW_TONES[rowClass],
        decision: state.decisions[item.id],
        colliding: item.collision,
        compare: !item.collision ? null : {
          have: identical
            ? 'Already in your workspace, identical to what arrives.'
            : 'Already in your workspace, with different content.',
          arrives: identical
            ? "The package's version, byte for byte what you have."
            : "The package's version. Overwrite replaces yours with it.",
        },
        // NEVER OVERWRITE AS THE WAY OUT: the blocked row's one action is
        // skipping, and the copy says what skipping keeps.
        blockedNote: rowClass !== 'blocked' ? null
          : 'Blocked: this would give your team a second default agent. Rundock allows exactly one. '
            + 'Skipping this item keeps your workspace exactly as it is and clears the conflict.',
        blockedAction: rowClass !== 'blocked' ? null
          : { label: 'Skip this item', decision: 'skip' },
      };
    });
    return {
      title: 'Review this package',
      rows,
      counts,
      confirmLabel: confirmLabel(counts),
      confirmNote: counts.blocked > 0
        ? `${counts.blocked} item${counts.blocked === 1 ? '' : 's'} will not be written until the default conflict clears.`
        : counts.adds === 0 && counts.overwrites === 0
          ? 'Confirming writes nothing, and says so rather than doing something silent.'
          : 'Nothing else in your workspace changes.',
      confirmWarn: counts.blocked > 0,
      cancelLabel: 'Cancel',
    };
  }

  // The review-void state: the person did real work deciding, that work is
  // gone, and the copy lands with enough weight to be read, not skimmed.
  function staleCopy() {
    return {
      tone: REVIEW_TONES.stale,
      headline: 'Your workspace changed',
      body: 'Something this review depended on changed while you were deciding. '
        + 'Every choice above has been discarded and nothing was written.',
      actionLabel: 'Re-plan',
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

  // A dropped connection in the stale phase changes nothing: the review is
  // already void and the only action re-plans, which checks the connection
  // itself on the way out.

  return { initial, submit, reply, planReply, offerCopy, cancel, confirm, applyReply, doneCopy, retry, connectionLost,
    setDecision, reviewCopy, staleCopy, confirmLabel, reasonWords, REVIEW_TONES, RESULT_RENDERINGS };
}));
