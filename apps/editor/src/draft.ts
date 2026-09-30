import {
  applyChanges,
  type Brief,
  type Constraint,
  emptyModel,
  InputError,
  type Model,
  type Op,
  validateBrief,
} from "@or1/core";

/**
 * Editable owner inputs for a new project. They compile to the core's own model and brief through
 * core validation (applyChanges and validateBrief), so the browser never invents geometry rules.
 */
export type Side = "south" | "east" | "north" | "west";
export const SIDES: readonly Side[] = ["south", "east", "north", "west"];
export type OpeningDraft = { side: Side; offset: number; width: number };
export type ShellDraft = {
  width: number;
  depth: number;
  thickness: number;
  entrance: OpeningDraft;
  windows: OpeningDraft[];
};
export type RoomDraft = {
  id: string;
  program: string;
  quantity: number;
  hard: boolean;
  minAreaM2: number | null;
  targetAreaM2: number | null;
  daylight: boolean;
  /** Requirement IDs this room must share a door with. */
  doorTo: string[];
};
export type BriefDraft = { name: string; rooms: RoomDraft[] };
export type ProjectDraft = { shell: ShellDraft; brief: BriefDraft };

/** Shell walls are W1 south, W2 east, W3 north, W4 west, running anticlockwise. */
const WALL: Record<Side, "W1" | "W2" | "W3" | "W4"> = {
  south: "W1",
  east: "W2",
  north: "W3",
  west: "W4",
};

/**
 * Offsets in the form are measured from the west end (south/north walls) or the south end
 * (east/west walls), whichever way the host wall runs; this converts to the core's host offset.
 */
function hostOffset(shell: ShellDraft, opening: OpeningDraft): number {
  if (opening.side === "north") return shell.width - opening.offset - opening.width;
  if (opening.side === "west") return shell.depth - opening.offset - opening.width;
  return opening.offset;
}

export type Compiled<T> = { ok: true; value: T } | { ok: false; message: string };

export function compileShell(shell: ShellDraft): Compiled<Model> {
  const { width, depth, thickness } = shell;
  if (![width, depth, thickness].every((value) => Number.isSafeInteger(value) && value > 0))
    return {
      ok: false,
      message: "Width, depth and wall thickness must be positive whole millimetres.",
    };
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: depth },
    { x: 0, y: depth },
  ];
  const opening = (item: OpeningDraft) => ({
    wall: WALL[item.side],
    offset: hostOffset(shell, item),
    width: item.width,
    locked: true,
  });
  const ops: Op[] = [
    ...corners.map(
      (start, index): Op => ({
        op: "add_wall",
        start,
        end: corners[(index + 1) % 4] as { x: number; y: number },
        thickness,
        locked: true,
      }),
    ),
    { op: "add_door", ...opening(shell.entrance), entrance: true },
    ...shell.windows.map((item): Op => ({ op: "add_window", ...opening(item) })),
  ];
  try {
    const result = applyChanges(emptyModel(), ops, "owner");
    return result.ok
      ? { ok: true, value: result.model }
      : { ok: false, message: `${result.rejection.reason}: ${result.rejection.detail}` };
  } catch (error) {
    return { ok: false, message: error instanceof InputError ? error.message : "Invalid shell" };
  }
}

/** Constraints are emitted grouped by kind (areas, doors, daylight) in room order. */
export function compileBrief(draft: BriefDraft): Compiled<Brief> {
  const target = (id: string) => ({ kind: "requirement" as const, id });
  const constraints: Constraint[] = [
    ...draft.rooms.flatMap((room): Constraint[] =>
      room.minAreaM2 === null
        ? []
        : [{ kind: "min_area", target: target(room.id), areaM2: room.minAreaM2, hard: true }],
    ),
    ...draft.rooms.flatMap((room) =>
      room.doorTo.map(
        (other): Constraint => ({
          kind: "adjacent",
          a: target(room.id),
          b: target(other),
          via: "door",
          hard: true,
        }),
      ),
    ),
    ...draft.rooms.flatMap((room): Constraint[] =>
      room.daylight ? [{ kind: "daylight", target: target(room.id), hard: true }] : [],
    ),
  ];
  const brief: Brief = {
    schemaVersion: 2,
    ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
    rooms: draft.rooms.map((room) => ({
      id: room.id,
      program: room.program,
      quantity: room.quantity,
      hard: room.hard,
      ...(room.targetAreaM2 !== null ? { targetAreaM2: room.targetAreaM2 } : {}),
      ...(room.daylight ? { habitable: true } : {}),
    })),
    constraints,
  };
  try {
    validateBrief(brief);
    return { ok: true, value: brief };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof InputError ? error.message : "Invalid brief",
    };
  }
}

export function compileProject(draft: ProjectDraft): Compiled<{ model: Model; brief: Brief }> {
  const model = compileShell(draft.shell);
  if (!model.ok) return model;
  const brief = compileBrief(draft.brief);
  if (!brief.ok) return brief;
  return { ok: true, value: { model: model.value, brief: brief.value } };
}

const room = (partial: Partial<RoomDraft> & Pick<RoomDraft, "id" | "program">): RoomDraft => ({
  quantity: 1,
  hard: true,
  minAreaM2: null,
  targetAreaM2: null,
  daylight: false,
  doorTo: [],
  ...partial,
});

/** Editable starting points; the first two reproduce the public synthetic eval fixtures. */
export const PRESETS: readonly { id: string; label: string; draft: ProjectDraft }[] = [
  {
    id: "hall-living-study",
    label: "Hall, living & study · 10 × 7 m",
    draft: {
      shell: {
        width: 10_000,
        depth: 7_000,
        thickness: 200,
        entrance: { side: "west", offset: 1_300, width: 900 },
        windows: [
          { side: "east", offset: 1_500, width: 1_600 },
          { side: "east", offset: 5_000, width: 1_200 },
        ],
      },
      brief: {
        name: "Synthetic hall, living room and study",
        rooms: [
          room({ id: "hall", program: "hall", minAreaM2: 12, targetAreaM2: 12.58 }),
          room({
            id: "living",
            program: "living",
            minAreaM2: 30,
            targetAreaM2: 30.2225,
            daylight: true,
            doorTo: ["hall"],
          }),
          room({
            id: "study",
            program: "study",
            minAreaM2: 22,
            targetAreaM2: 22.3725,
            daylight: true,
            doorTo: ["hall"],
          }),
        ],
      },
    },
  },
  {
    id: "asymmetric-bedrooms",
    label: "Two bedrooms · 11 × 8 m",
    draft: {
      shell: {
        width: 11_000,
        depth: 8_000,
        thickness: 200,
        entrance: { side: "west", offset: 1_800, width: 900 },
        windows: [
          { side: "east", offset: 1_600, width: 1_600 },
          { side: "north", offset: 8_000, width: 1_200 },
          { side: "north", offset: 4_400, width: 1_600 },
        ],
      },
      brief: {
        name: "Synthetic asymmetric bedrooms with distinct access",
        rooms: [
          room({ id: "hall", program: "hall", minAreaM2: 15.9, targetAreaM2: 15.99 }),
          room({
            id: "living",
            program: "living",
            minAreaM2: 37,
            targetAreaM2: 37.6275,
            daylight: true,
            doorTo: ["hall"],
          }),
          room({
            id: "bedroom_large",
            program: "bedroom",
            minAreaM2: 16,
            targetAreaM2: 16.415,
            daylight: true,
            doorTo: ["hall"],
          }),
          room({
            id: "bedroom_small",
            program: "bedroom",
            minAreaM2: 12,
            targetAreaM2: 12.2275,
            daylight: true,
            doorTo: ["living"],
          }),
        ],
      },
    },
  },
  {
    id: "one-bed",
    label: "One-bed flat · 9 × 6 m",
    draft: {
      shell: {
        width: 9_000,
        depth: 6_000,
        thickness: 200,
        entrance: { side: "south", offset: 600, width: 1_000 },
        windows: [
          { side: "north", offset: 1_000, width: 1_800 },
          { side: "north", offset: 5_800, width: 1_500 },
          { side: "east", offset: 2_000, width: 1_200 },
        ],
      },
      brief: {
        name: "One-bed flat",
        rooms: [
          room({ id: "hall", program: "hall", minAreaM2: 4 }),
          room({
            id: "living",
            program: "living",
            minAreaM2: 22,
            targetAreaM2: 24,
            daylight: true,
            doorTo: ["hall"],
          }),
          room({
            id: "bedroom",
            program: "bedroom",
            minAreaM2: 11,
            targetAreaM2: 13,
            daylight: true,
            doorTo: ["hall"],
          }),
          room({ id: "bathroom", program: "bathroom", minAreaM2: 4, doorTo: ["hall"] }),
        ],
      },
    },
  },
];

export function blankRoom(existing: readonly RoomDraft[]): RoomDraft {
  let n = existing.length + 1;
  while (existing.some((r) => r.id === `room_${n}`)) n++;
  return room({ id: `room_${n}`, program: "room", minAreaM2: 8 });
}
