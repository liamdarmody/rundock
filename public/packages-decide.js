'use strict';
/**
 * THE one decision contract for package import, shared byte-for-byte between
 * the server (lib/packages/import-plan.js requires and re-exports it) and the
 * browser (a script tag loads it before the install flow's model). It exists
 * as its own module because a decision contract that is implemented twice is
 * a decision contract that will disagree, and the whole point of the plan and
 * apply digests is that nothing gets to disagree.
 *
 * Attach one decision per item and produce exactly the approval object the
 * evaluator accepts. A skip approves the reviewed pre-state itself, so its
 * approved digest and default state collapse onto the planned ones.
 *
 * The fourth decision, `attach`, belongs to an incoming default whose plan
 * carries an attach offer: the item itself is skipped exactly as a skip is,
 * and each dependant that named it (and is itself arriving) is re-pointed at
 * the workspace's existing leader by selecting the plan's own re-pointed
 * digest and carrying the leader's name for the writer's transform. The
 * fan-out lives HERE, once, because it is a decision rule: expressed again
 * in a view or a handler it would be a second contract waiting to disagree.
 *
 * The fifth decision, `adopt`, belongs to the same incoming default: the
 * item itself is WRITTEN, transformed into a specialist under the existing
 * leader, by selecting the plan's own adopted digest and carrying the
 * leader's name for the writer's transform. Its dependants are left exactly
 * as decided, because they already name it, so no fan-out happens and no
 * re-point is selected: the adopted bytes are non-default by the transform's
 * own postcondition, which is why approvedDefault reads false here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else root.RundockPackagesDecide = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function decide(plan, decisions) {
    const attached = plan.items
      .filter((item) => decisions[item.id] === 'attach')
      .map((item) => item.id);
    return {
      schema: plan.schema,
      source: plan.source,
      manifest: plan.manifest,
      items: plan.items.map((item) => {
        const decision = decisions[item.id];
        const skip = decision === 'skip' || decision === 'attach';
        const adopt = decision === 'adopt' && item.agent && item.agent.adopt
          ? item.agent.adopt : null;
        const repoint = !skip && !adopt && item.agent && item.agent.repoint
          && attached.indexOf(item.agent.repoint.of) !== -1 ? item.agent.repoint : null;
        const agent = item.agent === null ? null : {
          plannedDefault: item.agent.plannedDefault,
          approvedDefault: skip ? item.agent.plannedDefault : item.agent.approvedDefault,
        };
        if (repoint) agent.attachTo = repoint.to;
        if (adopt) {
          agent.approvedDefault = false;
          agent.adoptUnder = adopt.to;
        }
        return {
          ...item,
          decision: decision === 'attach' ? 'skip'
            : adopt ? (item.collision ? 'overwrite' : 'add') : decision,
          approvedDigest: skip ? item.plannedDigest
            : adopt ? adopt.approvedDigest
              : repoint ? repoint.approvedDigest : item.approvedDigest,
          agent,
        };
      }),
    };
  }

  return { decide };
}));
