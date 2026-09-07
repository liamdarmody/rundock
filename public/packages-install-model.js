'use strict';
/**
 * The install flow's model: every state the flow can be in, every word it
 * says, and the only messages it is ever allowed to send.
 *
 * WHY THIS IS A MODULE AND NOT A VIEW: the same reason the routines model is
 * one. Everything this flow is judged on is copy, a state rule, or a promise
 * about what gets sent when, and promises about sending are exactly the ones
 * a browser-only implementation lets rot. Here, every transition returns
 * `{ state, send }`, `send` is undefined unless the person explicitly asked
 * for something, and the suite exhausts the transitions.
 *
 * THE RULING THIS FILE HOLDS: nothing is silent, and nothing is silently
 * overwritten. Planning happens only on submit; writing happens only on
 * confirm; cancel sends nothing at all. A colliding item opens the review
 * decided skip, and overwriting it is always a deliberate switch the person
 * throws themselves, never a default. Whether a decided review is safe to
 * apply is never computed here: the review's projection is asked of the
 * server's evaluator, the one place that rule lives, and this file only
 * renders what comes back. Three messages leave this model, each only on an
 * explicit action: the plan request on submit, the evaluation request
 * whenever the decided set changes, and the apply on confirm.
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

  // Every evaluate and apply request carries its own id, echoed back by the
  // server, so a reply is matched to the very request that produced it
  // rather than to whatever phase the flow happens to be in when the reply
  // lands. Random, not sequential: nothing here needs ordering, only
  // uniqueness against every other id this flow instance has already sent.
  // Plan requests do not need one: their success reply carries a type
  // (`package_import_plan`) no other request can produce, so there is no
  // shared envelope for a stray reply to be misread through.
  function nextRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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

  // The one reply entry: the phase picks which family of handler runs, and
  // each handler then checks the message's OWN identity before touching it,
  // so a reply is matched to the request that produced it rather than being
  // read as whatever the current phase happens to expect. This matters
  // because evaluate_package_decisions and apply_package_import share one
  // reply envelope (package_import_result): confirm can be pressed before an
  // outstanding evaluate reply lands, moving the phase to 'applying' while
  // that projection is still in flight, and the projection's own reply must
  // then change nothing rather than being misread as a completed apply.
  function reply(state, msg) {
    if (state.phase === 'classifying') return planReply(state, msg);
    if (state.phase === 'offer') return evaluationReply(state, msg);
    if (state.phase === 'applying') return applyReply(state, msg);
    return { state };
  }

  function planReply(state, msg) {
    if (state.phase !== 'classifying') return { state };
    if (msg.type === 'package_import_error') {
      // A stray evaluate or apply refusal reaching this phase is not this
      // request's answer and must not be read as one.
      if (msg.operation && msg.operation !== 'plan') return { state };
      // Classified by code, never by message prose: the wording belongs to
      // the producer and may change without ceremony.
      if (msg.code === 'empty-package') {
        return { state: { phase: 'nothing-usable', sourcePath: state.sourcePath } };
      }
      return { state: { phase: 'failed', sourcePath: state.sourcePath, message: msg.message || 'The package could not be read.' } };
    }
    // A projection or apply result sharing no field with a plan reply must
    // be refused here rather than dereferenced: `package_import_plan` is the
    // only type this phase's success case ever produces.
    if (msg.type !== 'package_import_plan' || !msg.plan) return { state };
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
      // The id of the evaluate request this offer is currently waiting on,
      // if any. Set here rather than left implicit so a reply can be matched
      // to it: see askEvaluation and evaluationReply below.
      evaluateRequestId: null,
    };
    // A collision-free plan never asks for a projection, so a plan the
    // evaluator would still block on (a default conflict among only-new
    // agents, say) cannot show the blocked treatment or its skip action on
    // this surface today. That is a recorded limit of this slice, not an
    // accident: only a plan with collisions opens the review at all, and the
    // review is the one surface a projection is asked for.
    if (offer.collisions.length === 0) return { state: offer };
    // A review with decisions to make is projected by the one evaluator on
    // the server, never by a second copy of its rules here: the same message
    // family that applies an import evaluates it, without writing.
    return askEvaluation(offer);
  }

  function decisionsFor(state) {
    const decisions = {};
    for (const item of state.plan.items) decisions[item.id] = state.decisions[item.id];
    return decisions;
  }

  // Ask the server to project the current decisions, tagging the request
  // with a fresh id and carrying that same id forward on the state so the
  // eventual reply can be matched to THIS request rather than to whichever
  // one the offer phase happens to be in when a reply lands. Every place
  // that changes what is being decided (the initial ask, and every decision
  // flip below) goes through here, never around it.
  function askEvaluation(state) {
    const requestId = nextRequestId();
    return {
      state: { ...state, evaluateRequestId: requestId },
      send: {
        type: 'evaluate_package_decisions',
        requestId,
        sourcePath: state.sourcePath,
        approval: sharedDecide()(state.plan, decisionsFor(state)),
      },
    };
  }

  // One decision, changed. Only combinations the evaluator itself accepts
  // can be chosen: a colliding item is overwritten or skipped, a new item is
  // added or skipped. Skipping a new item is how a blocked non-colliding row
  // (one of two incoming defaults, say) clears its conflict, through the
  // row's own Skip this item control, and the skipped-new row's Add it back
  // is the way back; the class walk in the suite reaches every row class
  // through those rendered controls. Every other combination is refused
  // unchanged, and every change asks the server to project the result so
  // blocking is never computed locally.
  function setDecision(state, id, decision) {
    if (state.phase !== 'offer') return { state };
    const item = state.plan.items.filter((i) => i.id === id)[0];
    if (!item) return { state };
    const allowed = item.collision ? ['overwrite', 'skip'] : ['add', 'skip'];
    if (allowed.indexOf(decision) === -1) return { state };
    if (state.decisions[id] === decision) return { state };
    const next = { ...state, decisions: { ...state.decisions, [id]: decision }, projection: null };
    return askEvaluation(next);
  }

  // What the projection said about the current decisions. Stale voids the
  // whole review, per the state model: the workspace or source moved, so
  // every choice above no longer describes what is actually there.
  //
  // Both checks below identify the message itself, not just this phase: an
  // apply result shares this same package_import_result envelope, and a
  // decision made after this projection was asked for sends a NEW evaluate
  // request, superseding this one. Either kind of stray reply changes
  // nothing, leaving the offer waiting on the request it actually sent.
  function evaluationReply(state, msg) {
    if (state.phase !== 'offer') return { state };
    if (msg.operation !== 'evaluate' || msg.requestId !== state.evaluateRequestId) return { state };
    if (msg.type === 'package_import_error') {
      return { state: { phase: 'failed', sourcePath: state.sourcePath, message: msg.message || 'The review could not be checked.', canReplan: true } };
    }
    if (msg.type !== 'package_import_result') return { state };
    if (msg.status === 'stale') {
      return { state: { phase: 'stale', sourcePath: state.sourcePath } };
    }
    // The projection is kept as MEMBERSHIP, one id list per evaluator bucket,
    // because every count and every row mark below is read from it and never
    // from local decisions: a byte-identical collision decided overwrite is in
    // `unchanged`, not `writes`, and must be counted as what it is.
    const ids = (list) => (list || []).map((entry) => entry.id);
    return {
      state: {
        ...state,
        projection: {
          status: msg.status,
          writes: ids(msg.writes),
          unchanged: ids(msg.unchanged),
          skipped: ids(msg.skipped),
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
    // Tagged the same way an evaluate request is, and for the same reason:
    // an evaluate reply this offer already asked for can still be in flight
    // when confirm is pressed, and applyReply below must be able to tell
    // that reply apart from the one this request will eventually produce.
    const requestId = nextRequestId();
    return {
      state: { phase: 'applying', sourcePath: state.sourcePath, requestId },
      send: { type: 'apply_package_import', requestId, sourcePath: state.sourcePath, approval: sharedDecide()(state.plan, decisionsFor(state)) },
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

  // Where each evaluator bucket reaches this surface is not restated here
  // as prose: the bucket walk in the suite renders a state that populates
  // each bucket beside one that leaves it empty and asserts the difference,
  // so a bucket added to the evaluator without a rendered home fails there.
  function reviewRowClass(state, item) {
    const blocked = !!(state.projection
      && state.projection.blocked.some((b) => b.id === item.id));
    if (blocked) return 'blocked';
    if (item.collision) return 'collision';
    return state.decisions[item.id] === 'skip' ? 'skippedNew' : 'willAdd';
  }

  // THE COUNTS ARE THE PROJECTION'S, never a local guess: overwrites are the
  // colliding members of the evaluator's `writes`, adds the rest of it, and
  // unchanged, skipped and blocked are their buckets' sizes. Until the
  // projection for the current decisions lands there are no counts at all,
  // and the label says so rather than warning about a write that would not
  // happen.
  function reviewCounts(state) {
    const p = state.projection;
    if (!p) return null;
    const colliding = new Set(state.plan.items.filter((i) => i.collision).map((i) => i.id));
    return {
      adds: p.writes.filter((id) => !colliding.has(id)).length,
      overwrites: p.writes.filter((id) => colliding.has(id)).length,
      unchanged: p.unchanged.length,
      skips: p.skipped.length,
      blocked: p.blocked.length,
    };
  }

  // The confirm button's own label carries the breakdown, the same honesty
  // rule as the success receipts: never a generic Confirm with the detail
  // left to body copy underneath. Whenever nothing reaches a destination the
  // label ends by saying so.
  function confirmLabel(counts) {
    if (!counts) return 'Checking your decisions…';
    const parts = [];
    if (counts.adds) parts.push(`add ${counts.adds}`);
    if (counts.overwrites) parts.push(`overwrite ${counts.overwrites}`);
    if (counts.skips) parts.push(`skip ${counts.skips}`);
    if (counts.unchanged) parts.push(`${counts.unchanged} unchanged`);
    if (counts.blocked) parts.push(`${counts.blocked} blocked`);
    if (counts.adds === 0 && counts.overwrites === 0) parts.push('nothing added');
    const joined = parts.join(', ');
    return joined.charAt(0).toUpperCase() + joined.slice(1);
  }

  // The reason the projection attached to a blocked item, or null if this
  // item is not (or not yet) blocked. The one place reviewCopy reaches into
  // the projection for a row's cause, so the wire's own reason is what ends
  // up in blockedNote below rather than a second, hand-written guess at it.
  function blockedReasonFor(state, item) {
    if (!state.projection) return null;
    const entry = state.projection.blocked.filter((b) => b.id === item.id)[0];
    return entry ? entry.reason : null;
  }

  function blockedCauses(state) {
    const reasons = [];
    for (const b of state.projection.blocked) if (reasons.indexOf(b.reason) === -1) reasons.push(b.reason);
    return reasons.map(reasonWords).join(', and ');
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
        // Said from the projection's own `unchanged` membership: the bytes
        // already match, so whatever is decided, nothing is written here.
        unchanged: !!(state.projection && state.projection.unchanged.indexOf(item.id) !== -1),
        compare: !item.collision ? null : {
          have: identical
            ? 'Already in your workspace, identical to what arrives.'
            : 'Already in your workspace, with different content.',
          arrives: identical
            ? "The package's version, byte for byte what you have."
            : "The package's version. Overwrite replaces yours with it.",
        },
        // NEVER OVERWRITE AS THE WAY OUT: the blocked row's one action is
        // skipping. The cause clause comes from the projection's own reason,
        // said through the one reason vocabulary (reasonWords) rather than a
        // second, hard-coded copy of what that vocabulary already says: a
        // blocking reason the evaluator ever grows besides default-conflict
        // is named correctly here instead of being reported as one.
        blockedNote: rowClass !== 'blocked' ? null
          : `Blocked: ${reasonWords(blockedReasonFor(state, item))}. `
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
      confirmNote: !counts
        ? 'Checking your decisions against your workspace.'
        : counts.blocked > 0
          // The cause clause comes from reasonWords, the same function the
          // blocked row's note uses, so one cause reaches the person in one
          // vocabulary wherever it is shown.
          ? `${count(counts.blocked, 'item')} will not be written because ${blockedCauses(state)}.`
          : counts.adds === 0 && counts.overwrites === 0
            ? 'Confirming writes nothing, and says so rather than doing something silent.'
            : 'Nothing else in your workspace changes.',
      confirmWarn: !!counts && counts.blocked > 0,
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

  // Identified the same way evaluationReply identifies its own replies: an
  // evaluate reply asked for before confirm was pressed can still be in
  // flight when this phase is entered, sharing this same result envelope,
  // and it must never be read as the apply this phase is actually waiting
  // on. Rejecting it here, unread, is what keeps the flow in 'applying'
  // until the real apply result (matched by its own requestId) arrives.
  function applyReply(state, msg) {
    if (state.phase !== 'applying') return { state };
    if (msg.operation !== 'apply' || msg.requestId !== state.requestId) return { state };
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
  // where the answer actually lives. A dropped connection in the stale
  // phase changes nothing: the review is already void and the only action
  // re-plans, which checks the connection itself on the way out, so neither
  // branch here needs to name that phase.
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

  return { initial, submit, reply, planReply, offerCopy, cancel, confirm, applyReply, doneCopy, retry, connectionLost,
    setDecision, reviewCopy, staleCopy, confirmLabel, reasonWords, REVIEW_TONES };
}));
