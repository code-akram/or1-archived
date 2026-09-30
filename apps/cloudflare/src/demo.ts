import { type Brief, emptyModel, type Model, type Op } from "@or1/core";
import type { PortableStore } from "@or1/store/portable";
import { applyChangesTool, createProject, forkRef, type ToolContext } from "@or1/tools";

export const DEMO_PROJECT_ID = "demo-workspace";
export const DEMO_VERSION = "cloud-demo-v1";

/** Public, entirely synthetic integer-mm rectangle. No imported project or client evidence. */
export function syntheticModel(): Model {
  const points = [
    { x: 0, y: 0 },
    { x: 4000, y: 0 },
    { x: 4000, y: 3000 },
    { x: 0, y: 3000 },
  ];
  return {
    ...emptyModel(),
    walls: points.map((start, index) => ({
      id: `W${index + 1}` as `W${number}`,
      start,
      end: points[(index + 1) % points.length] as { x: number; y: number },
      thickness: 200,
      locked: false,
      structural: false,
    })),
    openings: [
      {
        id: "O1",
        kind: "door",
        wall: "W1",
        offset: 1200,
        width: 1000,
        locked: false,
        hinge: "start",
        swing: "left",
        entrance: true,
      },
    ],
    spaces: [
      {
        id: "S1",
        anchor: { x: 2000, y: 1500 },
        program: "bedroom",
        requirementId: "bed",
        label: "Synthetic bedroom",
      },
    ],
    next: { wall: 5, opening: 2, space: 2 },
  };
}

export const syntheticBrief: Brief = {
  schemaVersion: 2,
  rooms: [{ id: "bed", program: "bedroom", quantity: 1, hard: true, targetAreaM2: 12 }],
  constraints: [],
};

function revision(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    value.ok !== true ||
    !("revisionId" in value) ||
    typeof value.revisionId !== "string"
  )
    throw new Error("Synthetic provisioning rejected; existing state is never overwritten");
  return value.revisionId;
}

export async function seedDemoV1(
  store: PortableStore,
): Promise<{ version: string; projectId: string }> {
  const ctx: ToolContext = { store, role: "owner", namespace: "cloud-demo-provisioner-v1" };
  const projectId = DEMO_PROJECT_ID;
  // Replay returns the original outcome, even if current heads advanced. Never rebuild a retry
  // from readState(): each base below is the frozen original create/fork response.
  const main = revision(
    (
      await createProject.execute(
        {
          projectId,
          ref: "main",
          baseRevision: null,
          requestId: `${DEMO_VERSION}:create`,
          body: { model: syntheticModel(), brief: syntheticBrief },
        },
        ctx,
      )
    ).data,
  );
  const variants: readonly [string, Op[]][] = [
    ["option-a", [{ op: "update_opening", id: "O1", offset: 800 }]],
    ["option-b", [{ op: "update_opening", id: "O1", offset: 2100, hinge: "end" }]],
    ["incomplete", [{ op: "tag_space", space: "S1", requirementId: null, program: null }]],
  ];
  for (const [ref, ops] of variants) {
    const fork = revision(
      (
        await forkRef.execute(
          {
            projectId,
            ref,
            baseRevision: main,
            requestId: `${DEMO_VERSION}:fork:${ref}`,
            body: { sourceRef: "main" },
          },
          ctx,
        )
      ).data,
    );
    revision(
      (
        await applyChangesTool.execute(
          {
            projectId,
            ref,
            baseRevision: fork,
            requestId: `${DEMO_VERSION}:apply:${ref}`,
            body: { ops, briefVersion: 1, baselineRevisionId: main },
          },
          ctx,
        )
      ).data,
    );
  }
  return { version: DEMO_VERSION, projectId };
}
