# V0 brief and scorecard

This describes `src/brief.ts` and `src/scorecard.ts`. The pure API is
`scorecard(model, brief, base)`: `base` is the option's fork model, not its latest parent or the option
itself. Neither model nor brief is mutated. Shared runtime schema, semantic and resource validation
is mandatory for agent and external data. Invalid inputs raise `InputError`; adapters return its
structured code, never silently score an invalid brief.

## Brief schema (version 2)

The brief requires `schemaVersion: 2`, `rooms`, and `constraints`; `name` is optional. All schema
objects reject unknown properties. Programs are case-sensitive snake_case keys (up to 64 characters),
matched against persistent space **program tags**, not labels or inferred room shapes.

- A room requirement has required `id`, `program`, `hard`, and `quantity` (positive integer), optional
  `targetAreaM2` (positive number), and optional `habitable` (default false).
- Presence means **at least** the requested quantity. Extra rooms are allowed. `hard: true` makes
  presence a gate; false makes it a soft score. Target area is **always soft**, even for hard rooms;
  use a hard `min_area`/`max_area` constraint for a non-negotiable bound.
- Constraints explicitly carry `hard`. An empty target fails a constraint, rather than passing
  vacuously. Constraints apply to **every** matching space, including surplus spaces.
- Lengths are integer millimetres; brief areas are square metres of clear floor (net area).
  Area comparisons convert integer net mm² to m² before comparing, without rounded display values or
  an epsilon. Exact limits pass; a difference of 1 mm² can fail. Diagnostic areas display two decimals.
- Optional `circulation` replaces the default programs **`corridor`, `hall`**. Optional `unreachable`
  replaces the default exemption **`shaft`**. Empty arrays remove the respective defaults.
- Optional `thresholds` overrides individual design minima; omitted fields retain the defaults below.
  Overrides must be positive integer millimetres. They do not override the geometry contract.

The first-workflow envelope allows at most 128 requirements, quantities from 1 to 128 with total
quantity at most 256, and 256 constraints. Requirement IDs are case-sensitive, at most 64 characters,
begin with an ASCII letter, and otherwise contain letters, digits, underscores or hyphens.
Target/constraint areas are at most 4,000,000 m²; constraint widths and threshold overrides are at
most 2,000,000 mm. Each circulation/exemption list has at most 128 entries. Invalid schema or bounds
raise `InputError` (`invalid_input` or `limit_exceeded`); the geometry contract also bounds aggregate
scorecard width work. These are execution limits, not promised feasible sizes or design minima.

Each space has at most one persistent `requirementId`, set through `tag_space`. Counts, area-fit and
habitable daylight use only explicitly assigned spaces with matching programs. Unassigned spaces
are allowed but cannot satisfy quantities. Separate same-program requirements may have different
constraints. Unknown references and mismatched assignments are errors. The registry supplies the
current brief on mutations; incomplete quantities remain editable.

IDs identify logical requirements within a project's brief lineage, not programs or space IDs.
Reordering/editing preserves IDs; deleted IDs must not be reused. Semantic validation rejects
duplicate IDs and exact duplicate specifications excluding their own ID, normalizing default
habitable=false, object/constraint order, repeated identical constraints, and self references.
Quantity, hardness, target area, habitable status and targeted constraints participate in comparison.

A constraint target is `{kind: "program", program}` or `{kind: "requirement", id}`. Program targets
include all same-program spaces, including unassigned ones; requirement targets include all matching
assigned spaces, including surplus. Adjacency's `a` and `b` are such targets: every A needs a different
B, but many A may share one B. This is not one-to-one pairing or all-to-all adjacency. A hard constraint
on a soft requirement still makes absence fail. Constraint indices are meaningful with the exact
immutable brief version; requirement results include stable IDs, quantities, counts and space IDs.

### Explicit historical migration

Brief and Model v1 schemas remain available to `migrateV1`, not to current mutation evaluation.
Migration never edits its inputs or persisted history. For one row per program, it generates IDs
once (`r1`, `r2`, ...), translates count/default 1 to quantity, assigns existing same-program spaces,
and preserves program-wide constraints as program targets. Persist the migrated result as new data,
not a rewrite of historical revisions. Repeated-program v1 briefs return `review_required`, even for
identical rows: summing/collapsing rows or inferring disjoint allocation changes v1 meaning. The
reviewed v2 document must be supplied explicitly; there is no silent migration fallback. Schema
version is distinct from successive stored brief content versions.

| Constraint | Meaning |
|---|---|
| `min_area {target, areaM2}` | Every matching space has net area ≥ the limit. |
| `max_area {target, areaM2}` | Every matching space has net area ≤ the limit. |
| `min_width {target, width}` | No positive clear-floor area fails the width policy below. |
| `adjacent {a, b, via}` | Every A space touches at least one **different** B space through a shared wall (`wall`) or hosted door (`door`). This requirement is directed A → B, though each wall/door connection is undirected. A space cannot count itself when A = B. |
| `daylight {target}` | Every matching space has at least one hosted window facing the exterior. Internal windows do not count. |

## Hard gates and default thresholds

All nine gates are reported in this order, with `passed`, `basis` and failure findings (`detail`, `subjects`).
There is no early exit, weight, aggregate validity score, or compensating soft score:
**`valid` is true only when every gate passes**.

| Gate | Passing condition |
|---|---|
| `topology` | `derive(model).problems` is empty under the [geometry contract](geometry-contract.md). A partial/empty shell can pass topology; it is not thereby a valid test-fit. |
| `protected_intact` | Base locked/structural walls and base protected openings are structurally equal JSON records in the candidate; no new openings were added to a base protected host. Removing protection flags also fails. Space tags are not protected records. |
| `requirement_bindings` | Every assigned space references an existing requirement with the same program. |
| `required_rooms` | Every hard requirement has at least its quantity of explicitly assigned matching spaces. |
| `reachable` | At least one marked entrance door connects a space to **exterior**. From all such entrance spaces, every non-exempt space is reachable through internal doors. Internal doors marked entrance do not seed reachability; windows, bare wall contact, and paths through exterior do not connect rooms. Untagged spaces must be reachable too. Exempt spaces are not barriers to traversal. |
| `corridor_width` | Every space with a circulation program has zero narrow area at **900 mm**, unless overridden by `thresholds.corridorWidth`. |
| `door_width` | Every door's structural opening width is ≥ **800 mm**, or ≥ **900 mm** if marked entrance. Overrides: `thresholds.doorWidth`, `thresholds.entranceDoorWidth`. Windows are excluded. |
| `door_clearance` | A width × width square extending from the host face on the specified swing side has no **positive-area overlap** with another wall body. Boundary contact passes. The host is excluded. |
| `hard_constraints` | Every constraint marked hard is met. Each constraint also has its own indexed result. |

The exported defaults are `DEFAULT_THRESHOLDS`, `DEFAULT_CIRCULATION`, and `DEFAULT_UNREACHABLE`.
They are concept-design heuristics, **not jurisdictional building-code certification**. Geometry's
100 mm opening minimum is independent of the scorecard's 800/900 mm door minima. Width equality
passes: 899 mm corridor fails the default, 900 mm passes.

Corridor width and door clearance remain **blocking configured concept-design heuristics**;
their results are labelled `basis: concept_design_heuristic`. They are not advisory-only warnings.
Scorecards explicitly report `certification: none` and `evaluatorVersion: 2.0`. A valid result means
only that configured concept-design checks pass, not code compliance or certification. Persisted
results must also pin the model revision, exact brief content version and fork baseline; changed
inputs make an old result stale rather than silently relabeling it.

**Width policy:** `narrowPart` measures clear-floor area not covered by any axis-aligned square of the
required width entirely inside the space. Zero narrow area passes. This checks narrow necks, spurs,
and L-shaped regions rather than their bounding boxes or average width. It is not a turning-circle,
wheelchair route, furniture-clearance, or door approach-clearance simulation.

**Door clearance policy:** the square conservatively bounds a leaf sweep; hinge is retained in the
model but does not alter this check. Exterior swings are allowed. Other door leaves, furniture,
opening voids in other walls, and detailed manoeuvring clearances are not evaluated.

The protected gate compares against **base**, even if an owner made the edits. It is a fork-invariant
check, not a substitute for credential-based write policy. Setting new protections on previously
unprotected elements is not itself a protected gate failure; non-owner writes are still rejected by
`applyChanges`. Changing the brief or protection baseline requires orchestration to mark options stale.

As in write policy, opening protection is host-relative record equality, not world-position equality.
Translating an unlocked host with a locked opening can pass this gate; resizing its start while
adjusting the protected opening's offset fails, even if the opening stays in the same world position.
Lock the host too when its physical placement must remain fixed.

## Soft scores

Scores are individual values in [0, 1], higher is better. They are also reported for invalid layouts,
but only valid layouts may be ranked as usable options. A score is omitted when the brief supplies no
corresponding input. There is no overall weighted score or built-in diversity metric.

| Score | Calculation |
|---|---|
| `area_fit` | For each target-bearing requirement, sort explicitly assigned matching spaces by capped relative deviation `min(1, abs(net_m2 - target_m2) / target_m2)`. Take the closest `quantity` instances; each missing instance has deviation 1. Ignore surplus spaces. Score = 1 − mean deviation over all requested instances across those rows. |
| `soft_rooms` | Fraction of soft **requirements** whose entire quantity is present, not fraction of individual rooms supplied. A partly filled requirement scores zero. |
| `soft_constraints` | Fraction of soft constraints met, with each row weighted equally. |
| `daylight` | Fraction of **existing spaces assigned to habitable requirements** that have a window to exterior. Includes surplus matching spaces. If habitable requirements are requested but none are assigned, score zero; missing instances are handled separately by presence/area scores. No window-area, orientation, sunlight, or lux model. |

For example, two living spaces of 16.53 and 28.13 m² against a 20 m² target have deviations 0.1735
and 0.4065. With `quantity: 3` plus one missing 5 m² study, deviations are 0.1735, 0.4065, 1, 1 and
`area_fit` is 0.355 when both spaces are assigned to that requirement. With only one living instance
requested, the closer assigned space scores 0.8265.

## Fixtures and limits of interpretation

`test/scorecard-fixtures.ts` contains public synthetic fixtures constructed through `applyChanges`:

- **Known feasible:** 8000 × 6000 mm centreline shell, 200 mm exterior walls, partition at X = 3000
  of thickness 100 mm, connected through an 800 mm door to a 900 mm entrance, with an exterior living
  window. Net corridor = 2850 × 5800 = **16.53 m²**; living = 4850 × 5800 = **28.13 m²**. All gates pass.
- **Known infeasible under that fixed shell:** the same brief additionally requires a 100 m² living
  room. The whole centreline shell is only 48 m², so even before subtracting walls the requested room
  cannot fit. `hard_constraints` fails independently of perfect area-fit/daylight scores.

`test/scorecard.test.ts` checks all gates, schema rejection, hard/soft separation, exact area limits,
threshold equality, connectivity, swing collision, daylight, missing/surplus counts, and scoring.
These are core unit fixtures, not the planned 20–30 scenario agent-eval suite or held-out dataset.

A failed scorecard proves **this candidate** violates a named gate; it does not prove the whole brief
infeasible. The core does not solve layouts, classify run outcomes (`options`, `infeasible`,
`not_found_within_budget`), or measure false refusals, diversity, cost, or workflow time. A run's
infeasibility claim needs separate evidence and an independently labelled fixture. Architect review
still decides design quality; this scorecard establishes validity and consistency only.
