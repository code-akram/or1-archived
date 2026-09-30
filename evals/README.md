# evals

- `fixtures/` — committed public eval fixtures, labelled independently of agent runs.
- `importers/` — scripts that generate fixtures from openly licensed data.

Eval run outputs (transcripts, renders, scores) go to `~/.local/share/or1/eval-runs/`, never here. The held-out set lives in `~/.local/share/or1/evals/held-out/` and is never committed.

## Public synthetic fixture contract

Each synthetic fixture directory contains four standalone JSON documents, with no wrappers:

| File | Existing core type | Purpose |
| --- | --- | --- |
| `shell.json` | `Model`, schema version 2 | Starting geometry: four locked exterior walls, owner-preplaced locked entrance/windows, one untagged space, no interior partitions. |
| `brief.json` | `Brief`, schema version 2 | Required quantities and explicit requirement IDs; hard net-area, direct door-adjacency and daylight constraints. |
| `witness.json` | `Model`, schema version 2 | A constructed feasible solution, including interior walls, doors and requirement assignments. |
| `witness-ops.json` | `Op[]` | Deterministic validation batch: `applyChanges(shell, ops, "agent", brief)` must reproduce the witness exactly. |

**Live runs load only `shell.json` and `brief.json`.** Witness geometry, operations and the dimensional solution evidence below are validation material, never model prompt/context. The runner must not enumerate the fixture directory into a live model's context. Replay mode may explicitly load witness operations for deterministic testing; replay success is not a live agent success.

The two fixtures below are original, public, synthetic examples authored for this repository. They use no client data or imported layout. Their **feasible** labels follow from dimensioned constructions inside their own original locked shells, not an agent outcome. No outside-shell infeasibility claims are made. All coordinates/lengths are integer millimetres; both are orthogonal and single-floor. Exterior thickness is 200 mm; new partition thickness is 100 mm. Net dimensions are between wall faces: subtract 100 mm at an exterior centreline and 50 mm at a partition centreline. Doorways do not add their wall strips to the core's net room areas.

## `synthetic-hall-living-study` — feasible

Exterior centrelines enclose `(0, 0)` to `(10000, 7000)`; the unpartitioned shell has clear dimensions 9800 × 6800 mm = **66.64 m²**. The witness adds W5 at x = 2000 from y = 0 to 7000 and W6 at y = 4000 from x = 2000 to 10000.

Each of the three requirements has quantity 1 and is hard:

| Requirement / program | Clear width × height (mm) | Independently calculated net area (m²) | Hard minimum (m²) |
| --- | --- | --- | --- |
| `hall` / `hall` | (2000 − 50 − 100) × (7000 − 200) = 1850 × 6800 | 12.58 | 12 |
| `living` / `living` | (10000 − 100 − 2000 − 50) × (4000 − 50 − 100) = 7850 × 3850 | 30.2225 | 30 |
| `study` / `study` | 7850 × (7000 − 100 − 4000 − 50) = 7850 × 2850 | 22.3725 | 22 |

The witness totals **65.175 m²**: 66.64 − (100 × 6800 + 100 × 7850) / 1000000. It contains **3 spaces, 6 walls, 3 doors (including entrance), and 2 windows**. All three target areas equal the independent values above.

The owner entrance O1 is on W4 at offset 4800, width 900, swinging inward into the hall. Added O4 on W5 at offset 1500, width 900, connects hall ↔ living; O5 at offset 5000, width 800, connects hall ↔ study. Both interior leaves swing east, away from the hall. These are the two required direct door adjacencies, and both rooms are reachable from the entrance. Locked east windows O2 (offset 1500, width 1600) and O3 (offset 5000, width 1200) provide living/study daylight respectively.

The hall's clear width 1850 mm exceeds the default 900 mm circulation threshold. Interior doors meet the default 800 mm threshold; the entrance meets 900 mm. Each swing square fits inside its destination, away from other wall bodies. All nine scorecard gates pass against the original shell; area-fit and daylight scores are both 1. This is concept-design validation, not certification.

Area sensitivity is independently predictable: moving W6 by −28 mm makes living 7850 × 3822 = **30.0027 m²**, still above 30; moving it by −29 mm makes 7850 × 3821 = **29.99485 m²**, failing only the hard minimum.

## `synthetic-asymmetric-bedrooms` — feasible

Exterior centrelines enclose `(0, 0)` to `(11000, 8000)`; the unpartitioned shell has clear dimensions 10800 × 7800 mm = **84.24 m²**. The witness adds W5 at x = 2200 from y = 0 to 8000, W6 at y = 4500 from x = 2200 to 11000, and W7 at x = 7200 from y = 4500 to 8000.

Each of the four requirements has quantity 1 and is hard. The two `bedroom` requirements are deliberately asymmetric:

| Requirement / program | Clear width × height (mm) | Independently calculated net area (m²) | Hard minimum (m²) | Required direct door to |
| --- | --- | --- | --- | --- |
| `hall` / `hall` | (2200 − 50 − 100) × (8000 − 200) = 2050 × 7800 | 15.99 | 15.9 | — |
| `living` / `living` | (11000 − 100 − 2200 − 50) × (4500 − 50 − 100) = 8650 × 4350 | 37.6275 | 37 | `hall` |
| `bedroom_large` / `bedroom` | (7200 − 50 − 2200 − 50) × (8000 − 100 − 4500 − 50) = 4900 × 3350 | 16.415 | 16 | `hall` |
| `bedroom_small` / `bedroom` | (11000 − 100 − 7200 − 50) × 3350 = 3650 × 3350 | 12.2275 | 12 | `living` |

The witness totals **82.26 m²**: 84.24 − (100 × 7800 + 100 × 8650 + 100 × 3350) / 1000000. It contains **4 spaces, 7 walls, 4 doors (including entrance), and 3 windows**. All four target areas equal the independent values above. Swapping the bedroom requirement IDs preserves bedroom counts and valid program bindings, but assigns the large requirement only 12.2275 m² and violates both bedrooms' direct-access constraints.

The owner entrance O1 is on W4 at offset 5300, width 900, swinging inward into the hall. Added O5 on W5 (offset 1800, width 900) connects hall ↔ living; O6 on W5 (offset 5900, width 800) connects hall ↔ large bedroom. Both swing east. O7 on W6 (offset 6500, width 800) connects living ↔ small bedroom and swings north. Thus the small bedroom is reached through the living room, not directly from the hall. Locked O2 on W2 (offset 1600, width 1600) lights living; O3 on W3 (offset 1800, width 1200) lights the small bedroom; O4 on W3 (offset 5000, width 1600) lights the large bedroom. W3 runs westward from the northeast corner, so its offsets are measured in that direction.

The hall's clear width is 2050 mm. All doors meet the default widths and have unobstructed swing squares. All nine scorecard gates pass against the original shell; area-fit and daylight scores are both 1. This is concept-design validation, not certification.

Area sensitivity: moving W7 by −123 mm makes the large bedroom 4777 × 3350 = **16.00295 m²**, passing its 16 m² minimum; moving it by −124 mm makes 4776 × 3350 = **15.9996 m²**, failing only that minimum.

## Deterministic validation

`packages/core/test/eval-fixtures.test.ts` imports and validates all four files per fixture against the existing core contracts. It reconstructs each shell through `plans.ts` as owner, replays witness operations as agent, compares the exact resulting Model, and checks all scorecard gates using the original shell as base. Expected net areas, space quantities, door graph edges and wall/opening counts come from the dimensions above, not from scorecard outputs or witness area metadata.

Negative checks clear every requirement assignment while preserving program tags, remove every interior door and verify exactly which spaces lose entrance connectivity, swap the same-program bedroom assignments, reroute the small bedroom through the large bedroom (reachable but lacking its required direct living-room door), test 799 versus 800 mm door width, and straddle both area boundaries with a one-millimetre wall move. Exact minimum-area equality passes; requiring one additional square millimetre fails.

Run the fixture tests with `pnpm --filter @or1/core exec vitest run test/eval-fixtures.test.ts`; repository checks are `pnpm check` and `pnpm test`.
