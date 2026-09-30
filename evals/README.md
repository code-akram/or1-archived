# evals

- `fixtures/` — committed eval fixtures: `shell.json`, `brief.json` and, for derived fixtures, `witness.json` (the real layout that proves the brief is feasible). Each fixture is labelled feasible or infeasible independently of any agent run.
- `importers/` — scripts that generate fixtures from openly licensed data.

Eval run outputs (transcripts, renders, scores) go to `~/.local/share/or1/eval-runs/`, never here. The held-out set lives in `~/.local/share/or1/evals/held-out/` and is never committed.
