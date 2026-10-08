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
 * ONE LINK FIELD FOR BOTH KINDS, AND THE LINK IS ALL THAT TRAVELS. The
 * person pastes a GitHub link; the server acquires the snapshot, classifies
 * it from its bytes, and resolves the reference itself: a link that names
 * one (a release or tree URL, or owner/repo@ref) supplies it, and a link
 * that names none is pinned to the repository's latest version tag, or to
 * the exact commit fetched when it has none. A manifest with an extension block comes
 * back as a trust step; anything else comes back as the "not a Rundock
 * package" offer of whatever agents and skills were found. The client never
 * names a path, and never sends a reference of its own.
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

  // Every message this model can send, declared once so the suite can hold
  // the walk over every sending transition to exactly this set, and so a
  // message added to a transition without being named here fails there.
  const OUTGOING = [
    'plan_package_install', 'evaluate_package_decisions',
    'confirm_extension_install', 'confirm_package_install', 'decline_package_install',
  ];

  function count(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  // ---- Routine disclosure: the one vocabulary for a schedule that arrives.
  //
  // A routine in an incoming agent's frontmatter is something the install
  // starts: the scheduler picks it up through ordinary agent discovery the
  // moment the file lands. "Adds three agents you can talk to" and "adds
  // three agents, one of which runs itself every morning" are different
  // consent questions, so every surface that offers the agents states the
  // routine in plain words: its cadence, and when it first runs. The
  // schedule grammar is already words (every day at 08:00), never a cron
  // string, and the sentence differs honestly by what will actually happen:
  // an enabled routine runs itself, a disabled one arrives switched off, and
  // one with no readable schedule cannot run at all.

  // When the routine first fires, from the schedule's own words: a daily
  // schedule first fires at the next such time, a weekly one on the next
  // such day. A schedule outside the writable grammar that the scheduler
  // still reads is quoted as written rather than paraphrased wrongly.
  const SCHEDULE_SHAPE = /^every (day|monday|tuesday|wednesday|thursday|friday|saturday|sunday) at ([0-2]\d:[0-5]\d)$/;

  // EVERY REASON A PERSON READS IS A SENTENCE: a capital first and a full
  // stop last. A refusal can arrive in the words of the module that raised
  // it ("extension manifest refused: ..."), so the Packages page shows each
  // one through this, and the words stay whole.
  function sentence(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return t;
    const capital = t[0].toUpperCase() + t.slice(1);
    return /[.!?…]$/.test(capital) ? capital : `${capital}.`;
  }

  function routineSentence(subject, routine) {
    const named = `${subject} carries the routine "${routine.name}"`;
    if (!routine.enabled) {
      const scheduled = routine.schedule ? `, scheduled ${routine.schedule}` : '';
      return `${named}${scheduled}; it arrives switched off and runs nothing until it is turned on in Routines.`;
    }
    if (!routine.schedule) {
      return `${named} with no schedule; it cannot run until one is written in Routines.`;
    }
    const shape = SCHEDULE_SHAPE.exec(routine.schedule.trim().toLowerCase());
    if (!shape) {
      return `${named}: it will run itself on the schedule "${routine.schedule}", with no one at the keyboard.`;
    }
    const first = shape[1] === 'day'
      ? `at the first ${shape[2]}`
      : `on the first ${shape[1].charAt(0).toUpperCase()}${shape[1].slice(1)} at ${shape[2]}`;
    return `${named}: it will run itself ${routine.schedule}, with no one at the keyboard, beginning ${first} after it is added.`;
  }

  // The frontmatter an arriving agent or skill carries that acts without
  // asking, said in plain words. The planner names the keys; this names what
  // they do, because a key name means nothing to most people reading a card.
  const UNASKED_WORDS = {
    hooks: 'runs shell commands of its own, with no permission card',
    permissionMode: 'can switch off the asking',
    'allowed-tools': 'pre-approves tools, so they run without a card',
    mcpServers: 'starts servers of its own',
  };
  function unaskedSentence(plan) {
    const list = plan && Array.isArray(plan.unasked) ? plan.unasked : [];
    if (!list.length) return '';
    const parts = list.map((u) => `${u.slug} ${u.keys.map((k) => UNASKED_WORDS[k] || k).join(', and ')}`);
    return ` Not everything here asks first: ${parts.join('; ')}. Those settings act without a permission card, so read ${list.length === 1 ? 'it' : 'them'} before adding.`;
  }

  function routineSentences(routines) {
    return routines.map((routine) => routineSentence(routine.agent, routine)).join(' ');
  }

  // The routines a content plan's items carry, flattened with their owning
  // agent's name, so the offer and the review read the same derived facts
  // the planner parsed. An agent item carries the key only when routines
  // exist, and this reads that absence as the empty list it means.
  function planRoutines(items) {
    const routines = [];
    for (const item of items) {
      if (item.kind !== 'agent' || !item.agent || !Array.isArray(item.agent.routines)) continue;
      for (const routine of item.agent.routines) routines.push({ agent: item.slug, ...routine });
    }
    return routines;
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

  function submit(state, rawLink) {
    const link = String(rawLink || '').trim();
    if (!link) {
      return { state: { ...initial(), fieldError: 'Paste the GitHub link of the repository to read.' } };
    }
    return {
      // `reference` stays on the state even though nothing here sets it:
      // the trust step adopts the reference the server resolved from its
      // plan reply, so the field exists for that writer.
      state: { phase: 'classifying', link, reference: '', outstanding: { operation: 'plan', token: null } },
      // The link is the whole request. A reference the link itself names
      // travels inside it; the server derives everything else.
      send: { type: 'plan_package_install', url: link },
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

  // The raw words of a system error, which the server sends beside its plain
  // sentence (public/readable-error.js) for the failure card's Details.
  function detailOf(msg) {
    return msg && typeof msg.detail === 'string' && msg.detail ? msg.detail : null;
  }

  // The offer, from whichever step produced the plan: the first read of a
  // repository holding agents and skills, or the second step after an
  // extension from the same repository was installed. NOTHING IS SILENTLY
  // OVERWRITTEN: every colliding item starts decided skip, so a person who
  // reviews the list and moves on keeps what they already have, and
  // overwrite always requires a deliberate switch.
  function offerFrom(carry, token, plan, installed, displayName) {
    const items = plan.items;
    const decisions = {};
    for (const item of items) decisions[item.id] = item.collision ? 'skip' : 'add';
    // A starter file whose path is taken is KEPT, not a collision to decide:
    // nothing can replace one, so it is named on the offer and never opens
    // the review on its own.
    const collisions = items.filter((i) => i.collision && i.kind !== 'starter').map((i) => ({ id: i.id, kind: i.kind, slug: i.slug }));
    const offer = {
      phase: 'offer',
      ...carry,
      token: token || null,
      plan,
      installed: installed || null,
      displayName: typeof displayName === 'string' && displayName ? displayName : null,
      agents: items.filter((i) => i.kind === 'agent').length,
      skills: items.filter((i) => i.kind === 'skill').length,
      starters: items.filter((i) => i.kind === 'starter').map((i) => ({ path: i.slug, kept: i.collision })),
      routines: planRoutines(items),
      collisions,
      // Which surface this offer is: the plain confirm card, or the review
      // with decisions to make. The model says so; the view branches on
      // this and holds no rule of its own about collisions.
      //
      // A collision is not the only thing that asks a person to decide. A
      // package carrying its own default, landing in a workspace that
      // already has one, offers to attach its team to the existing leader,
      // and that is a decision whether or not a single file collides. It is
      // also the commonest shape of the case: a package of all-new agents
      // collides with nothing. Opening the review on collisions alone let
      // the plan compute that offer and the surface throw it away, which is
      // the computed-and-dropped defect the install rules forbid for a refusal and
      // which applies to an action with the same force.
      review: collisions.length > 0 || items.some((i) => i.agent && i.agent.attach),
      decisions,
      projection: null,
      // The id of the evaluate request this offer is currently waiting on,
      // if any. Set here rather than left implicit so a reply can be matched
      // to it: see askEvaluation and evaluationReply below.
      evaluateRequestId: null,
      outstanding: null,
    };
    // A plan with nothing to decide never asks for a projection. The limit
    // recorded here previously, that a default conflict among only-new
    // agents could not reach the blocked treatment, is closed above: such a
    // plan now opens the review, because the attach offer it carries IS the
    // decision. What remains outside is narrower and deliberate: a default
    // conflict with no dependants to re-point stamps no attach, so it still
    // takes the plain card. Nothing is mis-parented in that case, since
    // there is nothing to parent; the item is refused at apply instead.
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
      // Refusals about the link's own reference land on the field, with the
      // link kept, rather than a dead end: a branch, which an extension is
      // never installed from, or a dash-leading reference in the link
      // (unpinned-reference), and a
      // repository the server could not derive a pin for (no version tags
      // and no readable fetched commit).
      if (msg.code === 'unpinned-reference' || msg.code === 'no-tags' || msg.code === 'unorderable-tags') {
        return { state: { ...initial(), ...carry, fieldError: msg.message } };
      }
      return { state: { phase: 'failed', ...carry, message: msg.message || 'The package could not be read.', detail: detailOf(msg) } };
    }
    if (msg.type === 'extension_install_plan') {
      // Provenance is the server's: the canonical url and the reference it
      // acquired at travel on the reply, and the trust card names those, so
      // an update begun from a managed row that typed no link still says
      // where the bytes came from, and a retry from there re-plans it.
      const source = msg.source && typeof msg.source.url === 'string'
        ? { link: msg.source.url, reference: msg.source.reference || carry.reference, commit: typeof msg.source.commit === 'string' ? msg.source.commit : null }
        : carry;
      return {
        state: {
          phase: 'trust', ...source, token: msg.token,
          manifest: msg.manifest, facts: msg.facts, replaces: msg.replaces || null,
        },
      };
    }
    // A projection or apply result sharing no field with a plan reply is
    // refused before it reaches here, by the correlation rule at the entry:
    // a reply belongs to this flow only when it names the operation the flow
    // is waiting on, its token once one is issued, and its request id when
    // the ask carried one. This phase waits on the plan, so nothing else
    // arrives to be dereferenced.
    //
    // A second check here was restored by a scope revert and then removed
    // again, deliberately, because the mutation harness proved it inert:
    // deleting it turned no test red, which is the definition of a guard
    // nothing notices. Keeping a rule that cannot fail is the defect class
    // this project finds most often, and it reads in a diff exactly like
    // the fix. The correlation rule is the one guard, stated once.
    return offerFrom(carry, msg.token || null, msg.plan, null, msg.displayName);
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
    // A starter file is never overwritten, so a taken one has only skip,
    // which is how it opened.
    const allowed = item.collision ? (item.kind === 'starter' ? ['skip'] : ['overwrite', 'skip']) : ['add', 'skip'];
    // The attach and adopt decisions exist only where the plan carries their
    // offers: an incoming default with dependants, in a workspace that has a
    // leader.
    if (item.agent && item.agent.attach) allowed.push('attach');
    if (item.agent && item.agent.adopt) allowed.push('adopt');
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
  // Both kinds of stray reply are already refused at the entry, by the same
  // correlation rule: operation, token, and the request id the ask carried.
  // A second identity check here was restored by a scope revert and removed
  // again, deliberately, on the same evidence as the one in planReply: the
  // mutation harness deleted it and no test turned red. An inert guard is
  // worse than no guard, because it reads as protection.
  function evaluationReply(state, msg) {
    if (state.phase !== 'offer') return { state };
    const carry = carried(state);
    if (isError(msg)) {
      return { state: { phase: 'failed', ...carry, message: msg.message || 'The review could not be checked.', detail: detailOf(msg), canReplan: true } };
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
  // THE STARTER FILE SENTENCES, the consent wording for files of the
  // person's own. Each file is named by the path it lands at, because a count
  // is not something a person can check against their folders, and the
  // sentence says the two things that make them different from agents and
  // skills: they land only where nothing exists, and they belong to the
  // person from then on. A taken path is named as kept. No line at all when
  // the package carries none.
  function starterSentence(starters) {
    const list = starters || [];
    const arriving = list.filter((f) => !f.kept).map((f) => f.path);
    const kept = list.filter((f) => f.kept).map((f) => f.path);
    let line = '';
    if (arriving.length) {
      line += ` Starter files: ${arriving.join(', ')}. They're added only where you have nothing at that path, `
        + "and they're yours from then on: removing the package never removes them.";
    }
    if (kept.length) line += ` Already in your workspace, so yours is kept: ${kept.join(', ')}.`;
    return line;
  }

  function offerCopy(state) {
    // The routine sentence is added, never a fourth card part: it counts
    // what arrives and names each schedule in the one routine vocabulary.
    // An agent carrying no routine adds no line, so the absence is as
    // honest as the presence.
    const routines = state.routines || [];
    const routineLine = routines.length
      ? ` ${count(routines.length, 'routine')} ${routines.length === 1 ? 'arrives' : 'arrive'} with them: ${routineSentences(routines)}`
      : '';
    return {
      headline: state.installed
        ? `${displayNameOf(state.installed)} ${state.installed.version} is installed. Add its agents and skills too?`
        : (state.displayName ? `Ready to add ${state.displayName}` : 'Ready to add'),
      body: `Rundock found ${count(state.agents, 'agent')} and ${count(state.skills, 'skill')} built for Claude Code. `
        + "They're not sandboxed: once added they act with the same access your own agents have. "
        + `Nothing runs until you add them.${routineLine}${starterSentence(state.starters)}${unaskedSentence(state.plan)}`,
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
      // The manifest and the update it belongs to ride into the wait, so the
      // managed row can show which extension is installing, and say so if
      // the install fails.
      return {
        state: {
          phase: 'installing', ...carried(state), token: state.token, outstanding: { operation: 'install', token: state.token },
          manifest: state.manifest,
        },
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
    kept: 'neutral',
  };

  // Where each evaluator bucket reaches this surface is not restated here
  // as prose: the bucket walk in the suite renders a state that populates
  // each bucket beside one that leaves it empty and asserts the difference,
  // so a bucket added to the evaluator without a rendered home fails there.
  function reviewRowClass(state, item) {
    const blocked = !!(state.projection
      && state.projection.blocked.some((b) => b.id === item.id));
    if (blocked) return 'blocked';
    // A taken starter file is kept, whatever else is decided: its own class,
    // with no control, because there is no choice to make about it.
    if (item.kind === 'starter' && item.collision) return 'kept';
    if (item.collision) return 'collision';
    // Attach is a skip with a re-point riding on the dependants, so the
    // deciding item renders in the skipped class; its note says the rest.
    const decision = state.decisions[item.id];
    return decision === 'skip' || decision === 'attach' ? 'skippedNew' : 'willAdd';
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
    // A taken starter file is skipped by the evaluator, and it is counted as
    // what it is to the person: kept, not a choice they made to skip.
    const kept = new Set(state.plan.items.filter((i) => i.kind === 'starter' && i.collision).map((i) => i.id));
    return {
      adds: p.writes.filter((id) => !colliding.has(id)).length,
      overwrites: p.writes.filter((id) => colliding.has(id)).length,
      unchanged: p.unchanged.length,
      skips: p.skipped.filter((id) => !kept.has(id)).length,
      kept: p.skipped.filter((id) => kept.has(id)).length,
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
    if (counts.kept) parts.push(`keep ${counts.kept} of yours`);
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

  function andList(names) {
    if (names.length === 1) return names[0];
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  // Whether skipping this blocked leader would leave specialists behind that
  // name it. They declare it in their own frontmatter, so with it absent the
  // name resolves to nothing and they attach at the top level: the package's
  // own design contradicted, and a dangling reportsTo left on disk that would
  // silently re-parent them if an agent of that name ever appeared.
  //
  // Read from the live decisions rather than from the plan, because it stops
  // being true the moment those specialists are skipped too. A package that
  // contributes nothing is a coherent outcome and stays available.
  function skipWouldOrphan(state, item) {
    const attach = item.agent && item.agent.attach;
    if (!attach || !attach.dependants.length) return false;
    return attach.dependants.some((slug) => state.decisions[`agent:${slug}`] !== 'skip');
  }

  // What skipping a blocked item actually does, which is not one sentence.
  //
  // The original copy promised that skipping "keeps your workspace exactly
  // as it is", and that is true only when the blocked default brings nobody
  // with it. When it has dependants they still land, still naming a leader
  // that is not being added, so the name resolves to nothing and they
  // attach at the top level. The sentence therefore talked a person into
  // precisely the outcome the attach action exists to prevent, which is the
  // prose-against-behavior class rather than a wording preference. Observed
  // in use: the note was read, skip was chosen, and the chart came out wrong.
  //
  // The dependants are named rather than counted, because "its team" is not
  // something a person can check against what they are about to get.
  function skipConsequence(state, item) {
    const attach = item.agent && item.agent.attach;
    if (!skipWouldOrphan(state, item)) {
      return 'Skipping this item keeps your workspace exactly as it is and clears the conflict.';
    }
    // The skip control carries the re-point in this case, so the sentence
    // explains why rather than warning about an outcome that can no longer
    // happen. Naming the specialists matters more than naming the rule:
    // they are what the decision is actually about.
    return `${andList(attach.dependants)} name it as their leader, so skipping it would leave `
      + `them without one. They will report to ${attach.leader} instead, unless you skip them too.`;
  }

  // What choosing adopt actually does, stated whole before confirm. The
  // agents are named, never called "its team", because a consequence a
  // person cannot check against what they are getting is not disclosed. The
  // last sentence is not optional polish: adoption rewrites three
  // frontmatter facts and nothing else, and an author's body prose ("you
  // talk to this agent first") is out of bounds, so the copy has to own
  // that the adopted agent's own instructions may still claim the lead.
  function adoptConsequence(item) {
    const dependants = item.agent.attach.dependants;
    const keeps = dependants.length === 1 ? 'keeps' : 'keep';
    return `${item.slug} joins as a specialist reporting to ${item.agent.adopt.leader}, `
      + `and ${andList(dependants)} ${keeps} reporting to ${item.slug}. `
      + `${item.slug}'s own instructions may still describe it as the workspace's lead.`;
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
      // A colliding plan never reaches the plain offer card, so the review
      // is where a carried routine must be named or a package with one
      // collision would start its schedule undisclosed. The note is a fact
      // of the incoming item, said in the one routine vocabulary, and an
      // agent carrying none carries no note.
      const routines = item.kind === 'agent' && item.agent && Array.isArray(item.agent.routines)
        ? item.agent.routines : [];
      return {
        id: item.id,
        name: item.slug,
        // The kind as the person reads it. A starter file is called that
        // everywhere a person sees it.
        kind: item.kind === 'starter' ? 'starter file' : item.kind,
        rowClass,
        keptNote: rowClass === 'kept'
          ? 'Already in your workspace, so yours is kept. A starter file never replaces anything.' : null,
        tone: REVIEW_TONES[rowClass],
        decision: state.decisions[item.id],
        colliding: item.collision,
        routineNote: routines.length
          ? routines.map((routine) => routineSentence('This agent', routine)).join(' ')
          : null,
        // Said from the projection's own `unchanged` membership: the bytes
        // already match, so whatever is decided, nothing is written here.
        unchanged: !!(state.projection && state.projection.unchanged.indexOf(item.id) !== -1),
        compare: !item.collision || rowClass === 'kept' ? null : {
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
            + skipConsequence(state, item),
        // Withdrawn where skipping could only end somewhere wrong. A choice
        // whose single outcome contradicts the package it came from is not a
        // choice, and warning about it was already proven insufficient: the
        // warning was shown, read, and chosen through.
        // Skipping is always a way out. What it MEANS depends on whether the
        // blocked leader has specialists still arriving that name it.
        //
        // With none, skipping is the ordinary thing: this item is not added
        // and nothing else moves. With some, leaving them to resolve a
        // leader that never arrives would put them at the top level, which
        // contradicts the package and leaves a dangling reportsTo. So
        // skipping the leader carries them to the workspace's own leader,
        // and the label says so rather than letting it happen quietly: this
        // is the one control on the review that reaches past its own row.
        //
        // Two decision values behind one control, because the evaluator and
        // the writer genuinely do different work for each. Only the
        // presentation collapses; the contract is unchanged.
        blockedAction: rowClass !== 'blocked' ? null
          : (skipWouldOrphan(state, item)
            ? {
              // The first version of this label carried the whole consequence
              // and wrapped onto two centred lines, which reads as a sentence
              // rather than a control. The blocked note directly above names
              // every specialist in full, so the button states the action and
              // where the team lands, and leaves the roll call to the prose.
              // Measured against the width a lone button gets in this card,
              // at the longest agent slug in the product rather than a short
              // placeholder. See Design/Packages-Copy-Pass.md.
              label: `Skip; team reports to ${item.agent.attach.leader}`,
              decision: 'attach',
            }
            : { label: 'Skip this item', decision: 'skip' }),
        // The first way out, first because it preserves the package author's
        // design: add the blocked default itself as a specialist under the
        // workspace's existing leader, its own dependants untouched.
        adoptAction: rowClass !== 'blocked' || !item.agent || !item.agent.adopt ? null
          // The row's heading is already the agent's name, so the label
          // does not repeat it; what it must carry is that this ADDS the
          // agent, as a specialist, under somebody.
          : { label: `Add as a specialist under ${item.agent.adopt.leader}`, decision: 'adopt' },
        // Once chosen, the added row states the whole consequence: who
        // reports to whom, by name, and that the adopted agent's own
        // instructions were not rewritten, so they may still claim the lead.
        adoptNote: state.decisions[item.id] !== 'adopt' || !item.agent || !item.agent.adopt ? null
          : adoptConsequence(item),
        // The second way out, beside skipping and only where the plan
        // carries the offer: skip the blocked default AND re-point its
        // dependants at the workspace's existing leader, named here so the
        // person knows exactly whose team grows.
        // No separate attach control: it WAS the skip control all along. A
        // second button reading "skip and attach" beside one reading "skip"
        // asked a person to distinguish two things where only one of them
        // ever ended anywhere correct.
        // Once chosen, the skipped row says where the team went instead.
        attachNote: state.decisions[item.id] !== 'attach' || !item.agent || !item.agent.attach ? null
          : `Skipped: its team reports to ${item.agent.attach.leader} instead.`,
      };
    });
    return {
      title: 'Review this package',
      // The same disclosure the plain offer carries, because a colliding plan
      // never reaches that card and must not arrive here undisclosed.
      unaskedNote: unaskedSentence(state.plan).trim() || null,
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
      return { state: { phase: 'failed', ...carry, message: msg.message || 'The import could not be applied.', detail: detailOf(msg) } };
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
      return {
        state: {
          phase: 'failed', ...carry, message: msg.message || 'The extension could not be installed.', detail: detailOf(msg),
          manifest: state.manifest || null,
        },
      };
    }
    if (msg.content && msg.content.plan) return offerFrom(carry, msg.content.token, msg.content.plan, msg.record);
    return { state: { phase: 'done', ...carry, installed: msg.record, written: [], blocked: [], receipt: null } };
  }

  function doneCopy(state) {
    const ext = state.installed;
    const parts = state.written.map((w) => ({ label: w.id.split(':')[1], kind: w.kind, destination: w.destination }));
    return {
      headline: ext ? `Installed ${displayNameOf(ext)} ${ext.version}`
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
      return { state: { phase: 'failed', ...carry, message: 'The connection dropped while adding. The import may or may not have completed: check your team and the receipts in .rundock/receipts to see what arrived, then read the package again if it did not.', canReplan: true } };
    }
    if (state.phase === 'installing') {
      return { state: { phase: 'failed', ...carry, message: 'The connection dropped while installing. Check Settings for whether it arrived, then read the package again if it did not.', canReplan: true } };
    }
    return { state };
  }

  function retry(state) {
    if (!state.link) return { state: initial() };
    return submit(initial(), state.link);
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
    messages: ['ready', 'resize', 'error', 'open', 'save', 'change', 'openExternal', 'saveSource', 'changeSource', 'ask', 'setState'],
    // The messages that act outside the view, honoured only after a real
    // click inside it, one per click across every view, and otherwise put to
    // the person in Rundock's own bar (extension-host.js, requestStanding).
    clickGated: ['open', 'openExternal', 'ask'],
    init: ['path', 'content', 'theme', 'sources', 'state'],
    // The most view state the host and the server keep per note
    // (extension-host.js, VIEW_STATE_MAX_BYTES). Every extension may keep
    // it, with nothing to declare, so every card says so.
    viewStateBytes: 65536,
  };

  function listWords(items) {
    if (items.length < 2) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  // TWO NETWORK SENTENCES, ONE PER PLACE RUNDOCK RUNS, because what can be
  // enforced differs and the card may only say what is enforced. Measured
  // (docs/evidence/extension-confinement-evidence.md): in both, the frame's
  // policy refuses loads and requests, and the page's own frame policy stops
  // the frame replacing itself with a remote page. In the desktop app WebRTC
  // is also switched off; in a browser nothing tried could stop a peer
  // connection, so the browser sentence says so rather than promising it.
  //
  // The earlier sentence, "it cannot load or contact anything on the
  // network", was true of the policy string and false of the frame. That gap
  // is the whole reason this function takes an environment.
  function hostClaims(facts, env = {}) {
    const network = env.desktop
      ? `It cannot load pages, make requests or open peer-to-peer connections: the frame's own policy is ${facts.network}, and Rundock ends the view if it tries to leave.`
      : `It cannot load pages or make requests: the frame's own policy is ${facts.network}, and Rundock ends the view if it tries to leave. Peer-to-peer connections are only blocked in the desktop app.`;
    return [
      `Its view runs in a frame whose only sandbox grant is ${facts.sandbox}: an opaque origin with no access to Rundock's page, storage or scripts.`,
      network,
      `It can send Rundock only these messages: ${facts.messages.join(', ')}. The ${listWords(facts.clickGated)} messages are honoured only after you click inside the view, one per click; when Rundock cannot tell a request came from your click, it asks you first, above the view. Anything else is refused.`,
      // `sources` is said by its own sentence below, only for an extension
      // that declared it; for every other extension the list is empty.
      `It receives the opened file's ${listWords(facts.init.filter((f) => f !== 'sources' && f !== 'state'))}, read-only, ${env.sources ? 'and the named sources below, ' : ''}and nothing else about your workspace. Hidden files, files in hidden folders and linked files, such as your agents' instructions and your keys, are never given to it.`,
      // `state` is the view's own, handed back to it: said here, once, for
      // every extension, because none has to ask for it.
      `It can keep up to ${facts.viewStateBytes / 1024} KB of its own settings for each note it opens, in Rundock's folder, never in your notes. Uninstalling it removes them.`,
    ];
  }

  function orWords(items) {
    if (items.length < 2) return items.join('');
    return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
  }

  // Only for an extension that declared sources, which it can only do
  // with a marker. Each sentence is what the host and the server enforce.
  function sourcesClaims(facts) {
    if (facts.sources !== true || !facts.declares) return [];
    const lines = [`It can read the files a note marked "${facts.declares}" lists under sources:, while that note is open in it. `
      + 'You choose those files by writing them in the note. It cannot name, list or find any other file, and hidden files, '
      + 'linked files and anything outside your workspace are never given to it.'];
    if (facts.writes === true) {
      lines.push('It can change those listed files through Rundock, which writes only files the note lists, and it can never change the list.');
    }
    return lines;
  }

  // Each agent by the name the person knows it by where it is on the
  // team, and by its id where it is not.
  function askClaim(facts, env = {}) {
    const asks = Array.isArray(facts.asks) ? facts.asks : [];
    if (!asks.length) return null;
    const team = Array.isArray(env.agents) ? env.agents : [];
    const names = asks.map((id) => {
      const agent = team.find((a) => a && a.id === id && a.status === 'onTeam' && a.type !== 'platform');
      return agent && agent.displayName ? agent.displayName : id;
    });
    return `When you click inside it, it can start a new conversation with ${orWords(names)} and put a message in the box for you. `
      + 'Nothing is sent until you send it, and it never sees the conversation or the reply.';
  }

  // The write sentence is separate from hostClaims above because it is
  // not a claim about the host at all: those four are true of every
  // extension, and this one is true only of an extension that asked. Stated
  // where it is asked for and nowhere else, so a read-only extension's card
  // does not carry a sentence about writing that would quietly teach people
  // to skim the ones that do.
  //
  // Derived from the manifest fact, never from prose: the same value the
  // host gates the save message on, so the card cannot promise less than
  // the frame will be allowed, or more.
  function writeClaim(facts) {
    if (facts.writes !== true) return null;
    // With sources, "and nothing else" would be false: the sources sentence
    // says what else it may change.
    if (facts.sources === true && facts.declares) {
      return 'It can change the file it opens: it hands the new text to Rundock, which writes that one file.';
    }
    return 'It can change the file it opens, and nothing else: it hands the new '
      + 'text to Rundock, which writes that one file.';
  }

  // The consent screen's whole text, split the way PL4 splits it: what will
  // run (the view, inside the host's enforced boundary) and what you will
  // keep (agents and skills, which are ordinary files and not sandboxed).
  // The facts line says the list was read from the package, because derived
  // facts beat declared intentions and the reader should know which kind
  // these are. Each half states plainly what confirm does with it, and the
  // focused suite holds the filesystem to those two sentences.
  // `env.desktop` is whether this is the desktop app, passed in by the page
  // rather than read here so the model stays a pure function of its inputs.
  // An extension is only ever offered pinned to a tag or an exact commit: the
  // server refuses a branch before the trust step. A tag is a name, so the
  // card also says which commit it resolved to; a commit is named once, short.
  const EXACT_COMMIT = /^[0-9a-f]{40}$/i;
  function sourceLine(state) {
    const short = state.commit ? String(state.commit).slice(0, 7) : null;
    if (EXACT_COMMIT.test(String(state.reference || ''))) return `From ${state.link}, pinned to commit ${String(state.reference).slice(0, 7)}.`;
    if (!short) return `From ${state.link}, pinned to ${state.reference}.`;
    return `From ${state.link}, pinned to ${state.reference} (commit ${short}).`;
  }

  // What the extension claims. A fenced-language extension claims no file
  // at all, and a card reading "files matching: null" asked consent for
  // nothing it could name.
  function matchLine(f) {
    if (f.match && f.declares) return `It asks to render files matching: ${f.match}, and only those marked "${f.declares}" in their frontmatter.`;
    if (f.match) return `It asks to render files matching: ${f.match}`;
    if (f.draws) return `It draws \`\`\`${f.draws} blocks where they sit in a note, and claims no file type.`;
    return 'It claims no file type and draws nothing.';
  }

  // Same name, and whether it is the same repository. A package can declare
  // any name, so one from another repository taking an installed extension's
  // name is said plainly rather than read as an ordinary update.
  function replacesLine(state) {
    const r = state.replaces;
    if (!r) return null;
    if (r.sameSource === false) {
      return `An extension called ${state.manifest.name} is already installed from a different repository (${r.url}). Installing this replaces it with code from ${state.link}.`;
    }
    return `This replaces the installed ${r.version} (pinned at ${r.reference}).`;
  }

  // What a package is called on screen: the name its manifest gives, or its
  // slug title-cased ("csv-table" reads "Csv Table") when it gives none.
  function displayNameOf(manifest) {
    if (manifest && typeof manifest.displayName === 'string' && manifest.displayName.trim()) return manifest.displayName.trim();
    const slug = manifest && typeof manifest.name === 'string' ? manifest.name : '';
    return slug.split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  }

  function trustCopy(state, env = {}) {
    const f = state.facts;
    const name = state.manifest.name;
    const display = displayNameOf(state.manifest);
    const both = f.agents > 0 || f.skills > 0;
    // The routine sentence folds into "what you will keep" rather than
    // standing as a third part: the card's split is by reversibility, and a
    // routine belongs to the agents the person keeps. Decided on the PL6
    // review; the wording comes from the one routine vocabulary above.
    const routines = Array.isArray(f.routines) ? f.routines : [];
    const routineLine = routines.length ? ` ${routineSentences(routines)}` : '';
    return {
      headline: `Install ${display} ${state.manifest.version}?`,
      sourceLine: sourceLine(state),
      factsLead: 'Read from the package itself, not from its author:',
      files: f.files,
      // The marker narrows the sentence when the facts carry one: consent
      // to "*.md, and only those marked" is a different question from
      // consent to every markdown file, and the words must match the claim.
      matchLine: matchLine(f),
      runsHeading: 'What will run',
      // The four host claims, plus the write sentence only where the
      // package asked for it. Appended rather than woven in, so the
      // unconditional facts stay in one block a reader can learn once and
      // the exception stands out as an exception.
      runsLines: [
        ...hostClaims(HOST_FACTS, { ...env, sources: f.sources === true && !!f.declares }),
        ...(writeClaim(f) ? [writeClaim(f)] : []),
        ...sourcesClaims(f),
        ...(askClaim(f, env) ? [askClaim(f, env)] : []),
      ],
      keepsHeading: 'What you will keep',
      halves: {
        extension: `Install puts the view above under .rundock/extensions/${name}, where uninstall can remove it.`,
        content: both
          ? `The ${count(f.agents, 'agent')} and ${count(f.skills, 'skill')} in this repository are not added by this step. `
            + 'Once the extension is installed you are offered them separately, and nothing about them lands until you answer that. '
            + 'They are not sandboxed: once added they act with the same access your own agents have.'
            + routineLine
          : 'It adds no agents and no skills.',
      },
      reviewLine: 'Rundock does not review extensions; what you install is your choice.',
      replacesLine: replacesLine(state),
      replacesWarn: !!(state.replaces && state.replaces.sameSource === false),
      confirmLabel: 'Install it',
      declineLabel: 'No, remove what was fetched',
    };
  }

  return { initial, submit, reply, planReply, offerCopy, cancel, decline, confirm, applyReply, installReply, doneCopy,
    retry, connectionLost, allAddApproval, HOST_FACTS, hostClaims, trustCopy, OUTGOING,
    setDecision, reviewCopy, staleCopy, confirmLabel, reasonWords, REVIEW_TONES,
    // The disclosure sentences, shared with the package update review so an
    // update says what a routine or a new privilege does in the same words.
    routineSentence, writeClaim, sourcesClaims, askClaim, sentence, displayNameOf };
}));
