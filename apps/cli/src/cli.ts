import { tools } from "@or1/tools";

const HELP = `usage: or1 <command>

commands:
  tools      list registry tools
  help       show this help`;

/** Returns the output for a CLI invocation. The CLI defaults to the agent role. */
export function run(args: readonly string[]): { code: number; output: string } {
  const [command = "help"] = args;
  switch (command) {
    case "tools":
      return {
        code: 0,
        output: tools.map((tool) => `${tool.name}\t${tool.description}`).join("\n"),
      };
    case "help":
    case "--help":
      return { code: 0, output: HELP };
    default:
      return { code: 1, output: `unknown command: ${command}\n\n${HELP}` };
  }
}
