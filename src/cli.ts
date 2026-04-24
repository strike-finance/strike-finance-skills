#!/usr/bin/env node

import { Command } from "commander";
import { runInstall } from "./install.js";

const program = new Command();

program
  .name("strike-finance-skills")
  .description(
    "Install Strike Finance AI coding assistant skills for trading bots and builder integrations"
  )
  .version("0.0.1");

program
  .command("install")
  .description("Install Strike Finance skills for detected AI agents")
  .option("-y, --yes", "Auto-install to all detected agents without prompting")
  .option(
    "--agents <agents...>",
    "Specify agents to install for (claude, codex, cursor, copilot, gemini, opencode, droid, pi)"
  )
  .action(async (options) => {
    await runInstall(options);
  });

program.parse();
