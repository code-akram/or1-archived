import { derive, scorecard } from "@or1/core";
import type { PlanReview, ReviewOptionSuccess } from "@or1/tools";
import { connectedPlan, testFitBrief } from "../../../packages/core/test/scorecard-fixtures.ts";

/** Public synthetic core fixture, with actual derived geometry and scorecards. */
export function reviewFixture(ref = "option-a"): ReviewOptionSuccess {
  const main = connectedPlan().model;
  const option = connectedPlan(1900).model;
  const plan = (model: typeof main, revisionId: string): PlanReview => {
    const { spaces, openings, adjacencies, slab, problems } = derive(model);
    return {
      revisionId,
      model,
      derived: { spaces, openings, adjacencies, slab, problems },
      scorecard: scorecard(model, testFitBrief, main),
    };
  };
  return {
    ok: true,
    projectId: "synthetic-project",
    ref,
    briefVersion: 7,
    baselineRevisionId: "main-head-13",
    brief: testFitBrief,
    main: plan(main, "main-head-13"),
    option: plan(option, "option-head-29"),
    eligibility: { allowed: true },
  };
}
