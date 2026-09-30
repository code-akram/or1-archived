import type { Brief, Derived, Model, Scorecard } from "@or1/core";
import type { Rejection } from "@or1/store/portable";

/** Browser-safe contracts: this module has no runtime imports or registry dependencies. */
export type CloudSession = {
  mode: "cloud";
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
