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
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else root.RundockPackagesDecide = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function decide(plan, decisions) {
    return {
      schema: plan.schema,
      source: plan.source,
      manifest: plan.manifest,
      items: plan.items.map((item) => {
        const decision = decisions[item.id];
        const skip = decision === 'skip';
        return {
          ...item,
          decision,
          approvedDigest: skip ? item.plannedDigest : item.approvedDigest,
          agent: item.agent === null ? null : {
            plannedDefault: item.agent.plannedDefault,
            approvedDefault: skip ? item.agent.plannedDefault : item.agent.approvedDefault,
          },
        };
      }),
    };
  }

  return { decide };
}));
