import { runEvalCli } from "./eval-cli.ts";

try {
  process.exitCode = await runEvalCli(process.argv.slice(2));
} catch {
  // Auth/provider errors may contain token-bearing URLs or remote response bodies. Never print them.
  console.error(
    "Evaluation failed. Check --help, the fixture/mode/model, and interactive OAuth login. No provider error details are logged.",
  );
  process.exitCode = 1;
}
