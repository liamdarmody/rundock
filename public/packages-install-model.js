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
 * ONE LINK FIELD FOR BOTH KINDS. The person pastes a GitHub link and, when
 * they have one, a pin; the server acquires the snapshot and classifies it
 * from its bytes. A manifest with an extension block comes back as a trust
 * step; anything else comes back as the "not a Rundock package" offer of
 * whatever agents and skills were found. The client never names a path.
 *
 * EVERY REPLY IS MATCHED TO THE REQUEST THAT PRODUCED IT, by operation, by
 * the token the server issued for the held snapshot, and by the request id
 * the flow stamped on the ask, never by type alone: an error raised by an
 * uninstall or an update check arriving while an install is in flight is
 * somebody else's answer, and an evaluate reply landing after a newer
 * decision has asked its own projection is a reply this review has moved
 * past. Either leaves this flow exactly where it was.
 *
 * THE RULING THIS FILE HOLDS: nothing is silent, and nothing is silently
 * overwritten. Planning happens only on submit; writing happens only on
 * confirm; cancel sends nothing at all. A colliding item opens the review
 * decided skip, and overwriting it is always a deliberate switch the person
 * throws themselves, never a default. Whether a decided review is safe to
 * apply is never computed here: the review's projection is asked of the
 * server's evaluator, the one place that rule lives, and this file only
 * renders what comes back. The messages that leave this model each leave
 * only on an explicit action: the plan request on submit, the evaluation
 * request whenever the decided set changes, the confirm at the trust step
 * or on the offer, and decline where the server holds something to discard.
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

  // Every evaluate and apply request carries its own id, echoed back by the
  // server, so a reply is matched to the very request that produced it
  // rather than to whatever phase the flow happens to be in when the reply
  // lands. Random, not sequential: nothing here needs ordering, only
  // uniqueness against every other id this flow instance has already sent.
  // Plan requests do not need one: their success replies carry types
  // (`package_import_plan`, `extension_install_plan`) no other request can
  // produce, so there is no shared envelope for a stray reply to be misread
  // through.
  function nextRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
  // the operation the flow is waiting on; once a token has been issued, that
  // token; and, when the ask carried a request id, that id. A plan request
  // has no token yet, so its reply is matched by operation alone and the
  // token it carries is adopted from there. The typed-path handlers, which
  // no interface reaches any more, answer with a null token, which is why
  // the token half of the rule is skipped rather than compared when none
  // was issued.
  function correlated(state, msg) {
    const waiting = state.outstanding;
    if (!waiting || !msg || msg.operation !== waiting.operation) return false;
    if (waiting.token !== null && msg.token !== waiting.token) return false;
    return waiting.requestId == null || msg.requestId === waiting.requestId;
  }

  // The one reply entry: the correlation rule decides whether the reply is
  // ours at all, and the model's own phase decides which handler runs. This
  // matters because evaluate_package_decisions and the apply share one
  // reply envelope (package_import_result): confirm can be pressed before an
  // outstanding evaluate reply lands, moving the phase to 'applying' while
  // that projection is still in flight, and the projection's own reply must
  // then change nothing rather than being misread as a completed apply.
  function reply(state, msg) {
    if (!correlated(state, msg)) return { state };
    if (state.phase === 'classifying') return planReply(state, msg);
    if (state.phase === 'offer') return evaluationReply(state, msg);
    if (state.phase === 'applying') return applyReply(state, msg);
    if (state.phase === 'installing') return installReply(state, msg);
    return { state };
  }

  function isError(msg) {
    return msg.type === 'package_install_error' || msg.type === 'package_import_error';
  }

  // The offer, from whichever step produced the plan: the first read of a
  // repository holding agents and skills, or the second step after an
  // extension from the same repository was installed. NOTHING IS SILENTLY
  // OVERWRITTEN: every colliding item starts decided skip, so a person who
  // reviews the list and moves on keeps what they already have, and
  // overwrite always requires a deliberate switch.
  function offerFrom(carry, token, plan, installed) {
    const items = plan.items;
    const decisions = {};
    for (const item of items) decisions[item.id] = item.collision ? 'skip' : 'add';
    const collisions = items.filter((i) => i.collision).map((i) => ({ id: i.id, kind: i.kind, slug: i.slug }));
    const offer = {
      phase: 'offer',
      ...carry,
      token: token || null,
      plan,
      installed: installed || null,
      agents: items.filter((i) => i.kind === 'agent').length,
      skills: items.filter((i) => i.kind === 'skill').length,
      collisions,
      // Which surface this offer is: the plain confirm card, or the review
      // with decisions to make. The model says so; the view branches on
      // this and holds no rule of its own about collisions.
      review: collisions.length > 0,
      decisions,
      projection: null,
      // The id of the evaluate request this offer is currently waiting on,
      // if any. Set here rather than left implicit so a reply can be matched
      // to it: see askEvaluation and evaluationReply below.
      evaluateRequestId: null,
      outstanding: null,
    };
    // A collision-free plan never asks for a projection, so a plan the
    // evaluator would still block on (a default conflict among only-new
    // agents, say) cannot show the blocked treatment or its skip action on
    // this surface today. That is a recorded limit of this slice, not an
    // accident: only a plan with collisions opens the review at all, and the
    // review is the one surface a projection is asked for.
    if (!offer.review) return { state: offer };
    // A review with decisions to make is projected by the one evaluator on
    // the server, never by a second copy of its rules here: the same message
    // family that applies an import evaluates it, without writing.
    return askEvaluation(offer);
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
    // A projection or apply result sharing no field with a plan reply must
    // be refused here rather than dereferenced: `package_import_plan` is the
    // only other type this phase's success case ever produces.
    if (msg.type !== 'package_import_plan' || !msg.plan) return { state };
    return offerFrom(carry, msg.token || null, msg.plan, null);
  }

  function decisionsFor(state) {
    const decisions = {};
    for (const item of state.plan.items) decisions[item.id] = state.decisions[item.id];
    return decisions;
  }

  // Ask the server to project the current decisions, tagging the request
  // with a fresh id and carrying that same id forward on the state so the
  // eventual reply can be matched to THIS request rather than to whichever
  // one the offer phase happens to be in when a reply lands. The token names
  // the snapshot the server is holding for this offer, so the projection is
  // read from the bytes the person is deciding about. Every place that
  // changes what is being decided (the initial ask, and every decision flip
  // below) goes through here, never around it.
  function askEvaluation(state) {
    const requestId = nextRequestId();
    return {
      state: { ...state, evaluateRequestId: requestId, outstanding: { operation: 'evaluate', token: state.token, requestId } },
      send: {
        type: 'evaluate_package_decisions',
        requestId,
        token: state.token,
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
  // Both checks below identify the message itself, not just this phase,
  // over and above the correlation rule at the entry: an apply result
  // shares this same package_import_result envelope, and a decision made
  // after this projection was asked for sends a NEW evaluate request,
  // superseding this one. Either kind of stray reply changes nothing,
  // leaving the offer waiting on the request it actually sent.
  function evaluationReply(state, msg) {
    if (state.phase !== 'offer') return { state };
    if (msg.operation !== 'evaluate' || msg.requestId !== state.evaluateRequestId) return { state };
    const carry = carried(state);
    if (isError(msg)) {
      return { state: { phase: 'failed', ...carry, message: msg.message || 'The review could not be checked.', canReplan: true } };
    }
    if (msg.type !== 'package_import_result') return { state };
    if (msg.status === 'stale') {
      return { state: { phase: 'stale', ...carry, token: state.token, installed: state.installed || null } };
    }
    // The projection is kept as MEMBERSHIP, one id list per evaluator bucket,
    // because every count and every row mark below is read from it and never
    // from local decisions: a byte-identical collision decided overwrite is in
    // `unchanged`, not `writes`, and must be counted as what it is.
    const ids = (list) => (list || []).map((entry) => entry.id);
    return {
      state: {
        ...state,
        outstanding: null,
        projection: {
          writes: ids(msg.writes),
          unchanged: ids(msg.unchanged),
          skipped: ids(msg.skipped),
          blocked: (msg.blocked || []).map((b) => ({ id: b.id, reason: b.reason })),
        },
      },
    };
  }

  // PL4's decided treatment: the plain confirm-card, no amber, because
  // nothing in a content-only import executes at install time. A colliding
  // plan never reaches this card: it opens the review instead.
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
  // still installs nothing, and the flow returns to its start. A voided
  // review holds its token the same way, so leaving it declines too.
  function decline(state) {
    if (state.phase !== 'offer' && state.phase !== 'trust' && state.phase !== 'stale') return { state };
    if (!state.token) return cancel();
    return { state: initial(), send: { type: 'decline_package_install', token: state.token } };
  }

  // The approval is built by THE decision contract itself: the shared
  // decide from packages-decide.js, loaded by script tag in the browser and
  // required here under Node, carrying exactly the decisions on the review.
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
    // Tagged the same way an evaluate request is, and for the same reason:
    // an evaluate reply this offer already asked for can still be in flight
    // when confirm is pressed, and applyReply below must be able to tell
    // that reply apart from the one this request will eventually produce.
    const requestId = nextRequestId();
    const token = state.token || null;
    return {
      state: { phase: 'applying', ...carried(state), installed: state.installed || null, outstanding: { operation: 'apply', token, requestId } },
      send: { type: 'confirm_package_install', token, requestId, approval: sharedDecide()(state.plan, decisionsFor(state)) },
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

  // The review does not repeat the plain offer card's not-sandboxed
  // sentence: the signed-off mock draws the review without it, spending the
  // card on the decisions, and the fact is stated once, at plan time, on
  // the offer card every collision-free import confirms through. A person
  // reaching the review has already read the package's contents item by
  // item, which is more than the plain card asks of them.
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
  // on. The correlation rule at the entry rejects it unread, by operation
  // and request id, which is what keeps the flow in 'applying' until the
  // real apply result arrives.
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
  // and nothing about them lands until the person answers that. A collision
  // among them opens the review exactly as a first read would.
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
  // snapshot when the socket closes, and that includes a review mid-decision:
  // the decisions cannot be applied to bytes the server no longer holds. A
  // dropped connection in the stale phase changes nothing: the review is
  // already void and the only action re-plans, which checks the connection
  // itself on the way out.
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
  // makes it true. `init` names the fields the frame is told about in the
  // one message the host sends it: the opened file's path and text, and the
  // theme the page shows at mount time; the suite binds this row to the
  // contract document's init row.
  const HOST_FACTS = {
    sandbox: 'allow-scripts',
    network: "default-src 'none'",
    messages: ['ready', 'resize', 'error', 'open'],
    init: ['path', 'content', 'theme'],
  };

  function listWords(items) {
    if (items.length < 2) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  function hostClaims(facts) {
    return [
      `Its view runs in a frame whose only sandbox grant is ${facts.sandbox}: an opaque origin with no access to Rundock's page, storage or scripts.`,
      `The frame's own policy is ${facts.network}: it cannot load or contact anything on the network.`,
      `It can send Rundock only these messages: ${facts.messages.join(', ')}. Anything else is refused.`,
      `It receives the opened file's ${listWords(facts.init)}, read-only, and nothing else about your workspace.`,
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

  // The update check's three named outcomes, each in its own words. A pin
  // the check cannot order against the listing (a commit, a codename) is
  // said to be exactly that, never "up to date", which would be a claim
  // the code cannot make.
  function updateStatusCopy(status) {
    if (status.outcome === 'newer-available') return `Update available: ${status.newer[status.newer.length - 1]}. Installing it asks for permission again.`;
    if (status.outcome === 'up-to-date') return `Up to date at ${status.current}.`;
    return `Pinned at ${status.current}, which cannot be compared with the tags this repository publishes. Pin a tag to have updates checked.`;
  }

  return { initial, submit, reply, planReply, offerCopy, cancel, decline, confirm, applyReply, installReply, doneCopy,
    retry, connectionLost, allAddApproval, HOST_FACTS, hostClaims, trustCopy, updateStatusCopy,
    setDecision, reviewCopy, staleCopy, confirmLabel, reasonWords, REVIEW_TONES };
}));
