# V0 geometry contract

This specifies the implemented schema-version-2 core, not the future editor or store. Sources:
`src/model.ts`, `contract.ts`, `geometry.ts`, `grid.ts`, `derive.ts`, `identity.ts`, and
`apply-changes.ts`. Hard fixtures live in `test/geometry-contract.test.ts` and
`test/identity.test.ts`; fast-check sequences live in `test/random-operations.test.ts`.

## Coordinates, tolerances, and supported arrangements

- One floor; straight horizontal or vertical wall **centrelines**, with positive thickness.
  Coordinates, thicknesses, opening offsets, and opening widths are integer millimetres. X points
  right and Y points up. Negative coordinates and reversed wall directions are supported.
- Thickness is an **even integer from 50 to 1000 mm inclusive**. Half-thicknesses and wall faces
  therefore stay on integer coordinates.
- Every centreline segment **between junctions** is at least **100 mm**, not merely the whole wall.
  Every opening is at least **100 mm** wide. These are geometric minima, not design/compliance minima.
- Unjoined segment bodies must have at least **200 mm Euclidean clear distance**. Segments sharing
  a graph node, segments of the same wall, and a continuously covered collinear wall run are exempt
  from that pairwise clearance check. These bodies include the same joined-end extensions used for
  clear-floor derivation, but only at authoritative wall endpoints, not at internal graph stations.
  Equality at a minimum is accepted.
- There is **no automatic snapping or near-point merging**. A join requires exact centreline contact.
  Stopping at another wall's face is not a join. Near-coincident input is rejected, not silently fixed.
  Collinear positive-length overlap, diagonal walls, and zero-length walls are rejected.
- End nodes, collinear joints (including thickness changes), L, T, and X junctions are supported.
  Crossings subdivide the derived graph without splitting the authoritative wall or issuing new IDs.

Geometry constants are exported as `GEOMETRY`; the conservative execution envelope is `LIMITS`.
Coordinates are bounded to ±1,000,000 mm, dimensions to 2,000,000 mm, IDs/counters to 1,000,000,
and models to 128 walls, 256 openings and 256 spaces. Batches contain at most 256 operations.
Post-operation draft coordinates and counters are checked before reconciliation. Grids are bounded
to 65,536 cells before allocation, graphs to 512 segments before pairwise clearance, and bounded
faces to 256 before identity allocation. Width checks reserve work before enumeration, with at most
2,000,000 candidate rectangles across the **entire scorecard** (all width constraints and circulation
spaces), not a fresh allowance per space/constraint. Standalone `narrowPart` has the same per-call cap.
This keeps intermediate mm² arithmetic safely below JavaScript's exact-integer limit. These are
first-workflow safety bounds, not promised production capacity. Rejection is `limit_exceeded`;
synchronous allocation is not left to a run timeout. Shared schemas and semantic validation are
mandatory at every integration boundary, including internal agent tools.

## Faces, clear floor, openings, and slab

Walls and hosted openings are authoritative. Each bounded centreline face has exactly one persistent
space record; the unbounded component is `exterior`. A compressed coordinate grid, rather than a
fixed-resolution raster, derives faces and exact areas. Island enclosures, holes, L-shaped rooms, and
free-ended spurs are supported. A gap in a partition makes one space; a hosted door does **not** merge
its two spaces. An empty or partly entered shell is geometrically valid and may have no spaces;
the scorecard separately checks suitability as a layout.

Wall, opening, and space IDs must each be unique within their respective kind. Schema validation
alone does not enforce this; geometry validation reports `duplicate_id`. On an invalid imported
model, derivation retains the first accepted space association for an ID, never aliases distinct
faces under that ID, and reports bounded faces left without a space record.

- `grossArea` is centreline-face area in mm², excluding centreline holes.
- `netArea` subtracts the union of wall bodies from that face, including spurs and island walls.
  Wall bodies widen centrelines by half-thickness and extend their ends by the half-thickness of the
  thickest perpendicular wall joined there. Openings do not cut floor-area voids through these bodies.
- `outline` and `clear` are implicitly closed rings: the first vertex is not repeated. Outer rings
  are counter-clockwise, holes clockwise; redundant collinear vertices are removed.
- `slab` is the union of bounded faces and the **whole bodies** of walls touching a bounded face.
  It includes their protruding ends; wholly exterior walls are excluded. It is derived, never edited.
- `adjacencies` report distinct faces across each wall and their shared centreline length. Door
  connectivity is a separate graph. Windows may be internal, but only exterior windows give daylight.

An opening is hosted by one wall, measured from its start toward its end. Its interval must fit
entirely between two consecutive graph stations, clearing each station by half the thickest
perpendicular meeting wall's thickness. Exact contact with this limit is allowed. Opening intervals
on one host cannot overlap (edge contact is allowed). Missing hosts and openings on spurs with the
same face on both sides are invalid. `left`/`right`, door swing, and hinge refer to the host's directed
start → end orientation. Doors default to hinge `start`, swing `left`, entrance `false`.

`spaceAt` queries **clear floor**: a space ID, `exterior`, or `undefined` inside a wall body. Boundary
queries follow the grid's half-open intervals. Persistent `anchor` is an internal centreline-face
locator, rewritten after edits; it is **not** a clear-floor label position and may lie in a wall body.

## Space identity

Old and new centreline faces are compared on a common grid. Identity assignment is deterministic,
one-to-one, and greedy; it is not a global optimal matching:

1. A candidate old/new pair must overlap by **positive gross area**.
2. Count their shared wall-side keys: the same wall ID on the same geometric side (positive or
   negative X/Y side, independent of wall direction). Count keys, not shared lengths.
3. If there are **no shared keys**, permit the pair only when overlap is **strictly more than 50% of
   each face's gross area**. Exactly 50% or majority in only one direction is insufficient. This is
   the fallback for walls removed and redrawn with fresh IDs.
4. Rank by shared-key count descending, overlap area descending, old numeric space ID ascending,
   then new face scan order (lowest Y, then leftmost X). Assign if neither face is already matched.
5. Matched faces retain the old ID, label, program, and requirement assignment. Unmatched new faces get fresh IDs in scan
   order, with **no inherited tags**. Unmatched old records retire.

Boundary continuity beats floor overlap, so moving a partition can preserve both room IDs even
when most of one room's former floor changes sides. With equal boundary-key counts, an ordinary
split keeps the old ID on its larger part; an equal split prefers the lowest/leftmost part. A merge
keeps the better-ranked old identity; an equal merge prefers the lower old numeric ID. “Largest
part wins” is not a general rule when boundary-key counts differ. A face moved without any overlap
does not retain identity, even if wall IDs survive.

`space_created.from` and `space_retired.into` report the largest positive-overlap predecessor or
successor, if any; equal-overlap lineage ties use common-grid scan order. These fields are explanatory,
not promises of identity retention or tag transfer. Retirement reports the lost label/program/requirementId.
Disappearance into the exterior has no successor. Reappearance gets a **new ID**: no resurrection.
Wall, opening, and space counters are monotonic. Explicit wall/opening IDs must be at least the next
counter and advance it; deleted IDs and skipped suffixes cannot be reused in that model lineage.

## Edit operations and atomicity

`applyChanges(model, ops, role, brief?)` validates each op with the shared TypeBox schema, executes ops in
order on a private draft, checks role policy on the complete candidate, reconciles space identity,
checks geometry, and finally applies space tags. It never mutates its inputs. A failed op, forbidden
indirect effect, invalid candidate geometry, or failed tag rejects the **whole batch**, including ID
allocation. Intermediate geometry may be invalid if the final candidate is valid, but per-op checks
(such as missing IDs, collapsed moves, or direction-changing resizes) still run immediately.
The registry must supply the current validated brief: final requirement bindings must exist and
match their program, but unmet quantities/constraints do not block intermediate editing. The pure
geometry-only API may omit the brief; scorecard validation still reports invalid bindings.

| Operation | Behavior and indirect effects |
|---|---|
| `add_wall` | Adds an orthogonal centreline; creates/splits faces as appropriate. Flags default false. |
| `remove_wall` | Deletes its hosted openings; can merge or retire spaces. |
| `move_wall` | Perpendicular translation: +X for vertical, +Y for horizontal. Carries its openings; stretches perpendicular neighbours whose endpoints lie on the old centreline. Neighbour openings stay at their world positions through offset adjustment. Through-crossing walls are not automatically translated. Collinear endpoint joints and collapsed/inverted neighbours are rejected. |
| `resize_wall` | Changes endpoints on the same line and in the same direction. Does not stretch neighbours; adjusts opening offsets to preserve world positions. |
| `update_wall` | Changes thickness or protection flags; rederives clear floor and opening clearance. |
| `add_door`, `add_window` | Adds an opening on an existing host. |
| `update_opening` | Changes placement, lock, or door attributes; cannot rehost or change kind. Door-only attributes on windows are rejected. |
| `remove_opening` | Deletes an opening; does not remove the separating wall or merge spaces. |
| `tag_space` | Resolves an ID or clear-floor point against **final** batch geometry, regardless of op position. Omitted tags keep values; null clears them. Retired IDs, exterior points, and wall-body points are rejected. |

Success returns the candidate model, derived geometry, and effects for additions, stretched walls,
cascaded opening removals, created/retired spaces, and retained spaces whose net area changed.
Rejection reasons are `invalid_op`, `not_found`, `forbidden`, `invalid_geometry`, `invalid_binding`,
`invalid_input`, and `limit_exceeded`, with diagnostics
and subjects where available. Effects describe execution/lineage, not a minimal persisted diff.

Roles come from credentials supplied by the adapter. `agent` and `external` have the same policy:
they cannot change locked/structural walls, locked openings, or openings in protected hosts; cannot
set protection or entrance flags; and cannot remove an entrance by deleting its door or host.
Unlocked neighbours may slide along protected walls if those protected records remain unchanged.
An owner can edit protection but must still satisfy geometry. Protection is checked after indirect
effects, not merely against the named element in each op.

Opening locks protect **host-relative records**, not world positions. Moving an unlocked host
perpendicularly carries its locked opening without changing that opening's record, so it is allowed.
Resizing the host's start to preserve the opening's world position changes its offset, so it is
forbidden to a non-owner. Lock the host as well when its physical placement must remain fixed.
World-position locking would be a different policy, not the current contract.

The pure core does not persist, authenticate, enforce base revisions, or deduplicate request IDs.
Those belong to the registry/store transaction around this evaluator, which must take a base revision,
request ID, and credential-derived role. Schema and resource validation precede derivation;
`checkModel` additionally checks geometric consistency. History and permissions remain transaction concerns.
