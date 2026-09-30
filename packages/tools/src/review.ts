import type { Brief, Derived, Model, Scorecard } from "@or1/core";
import type { Rejection } from "@or1/store/portable";

/** Browser-safe contracts: this module has no runtime imports or registry dependencies. */
export type CloudSession = {
  mode: "cloud";
  /** Present only for the isolated, time-limited development review deployment. */
  authentication?: "development-bypass";
  principalId: string;
  /** Unix milliseconds. */
  expiresAt: number;
  projects: readonly {
    projectId: string;
    label: string;
    membership: "owner" | "viewer";
    /** Navigation suggestions, not a ref-level access restriction. */
    refs: readonly string[];
    permissions: { canReview: true; canAccept: false };
  }[];
};
export type ReviewOptionInput = { projectId: string; ref: string };
export type AcceptOptionInput = {
  projectId: string;
  ref: "main";
  baseRevision: string;
  requestId: string;
  body: {
    sourceRef: string;
    sourceRevisionId: string;
    briefVersion: number;
    baselineRevisionId: string;
    evaluatorVersion: string;
  };
};
export type PlanReview = {
  revisionId: string;
  model: Model;
  derived: Pick<Derived, "spaces" | "openings" | "adjacencies" | "slab" | "problems">;
  scorecard: Scorecard;
};
export type ReviewOptionSuccess = {
  ok: true;
  projectId: string;
  ref: string;
  briefVersion: number;
  baselineRevisionId: string;
  brief: Brief;
  main: PlanReview;
  option: PlanReview;
  eligibility:
    | { allowed: true }
    | {
        allowed: false;
        code: "stale_baseline" | "invalid_identity" | "invalid_option" | "score_too_large";
      };
};
export type ReviewOptionResult = ReviewOptionSuccess | Rejection;
export type AcceptanceReceipt = AcceptOptionInput["body"] & {
  schemaVersion: 1;
  projectId: string;
  previousMainRevisionId: string;
  requestId: string;
  actor: { role: "owner"; namespace: string };
  scorecard: Scorecard;
};
export type AcceptOptionSuccess = {
  ok: true;
  revisionId: string;
  briefVersion: number;
  effects: [];
  acceptance: AcceptanceReceipt;
};
export type AcceptOptionResult = AcceptOptionSuccess | Rejection;

/** Latest persisted progress of one agent run; spend is the runner's cumulative accounting. */
export type RunSummary = {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";
  outcome: "options" | "infeasible" | "not_found_within_budget" | null;
  strategySeed: unknown;
  retryCount: number;
  /** Fresh final score validity pinned with the outcome, or null before settlement. */
  valid: boolean | null;
  spend: {
    tokens?: number;
    toolCalls?: number;
    rejections?: number;
    elapsedMs?: number;
  } | null;
  /** Ledger kind of the latest turn, e.g. tool_intent or settled; and its tool name if any. */
  lastEvent: { kind: string; name?: string; reason?: string | null } | null;
};
export type RefOverview = {
  ref: string;
  forkBaseRevisionId: string | null;
  /** True when main has moved past this option's fork baseline (it can no longer be accepted). */
  stale: boolean;
  plan: PlanReview;
  runs: RunSummary[];
};
export type ProjectOverview = {
  ok: true;
  projectId: string;
  briefVersion: number;
  brief: Brief;
  main: PlanReview;
  options: RefOverview[];
};
export type ProjectOverviewResult = ProjectOverview | Rejection;
export type ProjectListing = {
  ok: true;
  projects: { projectId: string; createdAt: string; name: string | null; options: number }[];
};

/** A design direction given to one agent so that parallel options genuinely differ. */
export type Strategy = { id: string; label: string; direction: string };
export type StudioStatus = {
  ok: true;
  agent: { provider: string; id: string; name: string } | null;
  activeRuns: string[];
  strategies: readonly Strategy[];
};
export type GenerateInput = {
  projectId: string;
  count: number;
  note?: string;
  strategies?: string[];
};
export type GenerateResult =
  | { ok: true; runs: { ref: string; runId: string; strategy: Strategy }[] }
  | Rejection;
