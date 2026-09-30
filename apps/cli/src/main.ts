#!/usr/bin/env node
import { run } from "./cli.ts";

const { code, output } = run(process.argv.slice(2));
(code === 0 ? process.stdout : process.stderr).write(`${output}\n`);
process.exitCode = code;
