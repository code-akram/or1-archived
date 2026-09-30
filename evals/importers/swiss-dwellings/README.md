# Swiss Dwellings importer (stub)

Generates fixtures from Swiss Dwellings v3.0.0 (CC BY 4.0, Archilyse AG). The raw dataset stays outside the repo, by default in `~/code/datasets/swiss-dwellings/`.

Planned steps:

1. Select orthogonal, single-floor apartments. Record the selection criteria and seed so reruns are identical.
2. Convert WKT in metres to integer millimetres.
3. Shell: exterior walls, core, windows and entrance, with interior walls removed; locked.
4. Brief: the apartment's rooms, areas and door-connected adjacencies.
5. Witness: the real layout, proving the brief is feasible.
6. Validate every fixture against `@or1/core` before writing it to `evals/fixtures/sd-<id>/`.
