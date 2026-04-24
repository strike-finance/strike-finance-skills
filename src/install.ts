import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import pc from "picocolors";
import {
  detectAvailableAgents,
  AGENT_LABELS,
  type Agent,
} from "./utils/detect-agents.js";
import { installSkillForAgent } from "./utils/install-for-agent.js";

function getSkillsDirectory(): string {
  // Skills are bundled in dist/skills/ at build time
  return resolve(import.meta.dirname, "skills");
}

export async function runInstall(options: {
  yes?: boolean;
  agents?: string[];
}): Promise<void> {
  const skillsDir = getSkillsDirectory();

  if (!existsSync(skillsDir)) {
    console.error(pc.red("Error: Skills directory not found at " + skillsDir));
    process.exit(1);
  }

  const skillNames = readdirSync(skillsDir).filter((name) =>
    existsSync(join(skillsDir, name, "SKILL.md"))
  );

  if (skillNames.length === 0) {
    console.error(pc.red("Error: No skills found"));
    process.exit(1);
  }

  console.log(
    pc.bold(`\n  Strike Finance Skills`) +
      pc.dim(` — ${skillNames.length} skills\n`)
  );

  // Detect or use specified agents
  let selectedAgents: Agent[];

  if (options.agents && options.agents.length > 0) {
    selectedAgents = options.agents as Agent[];
  } else {
    const detected = detectAvailableAgents();

    if (detected.length === 0) {
      console.log(pc.yellow("  No supported AI agents detected in PATH."));
      console.log(pc.dim("  Supported: claude, codex, cursor, copilot, gemini, opencode, droid, pi\n"));
      console.log(pc.dim("  Installing for all agents anyway...\n"));
      selectedAgents = ["claude", "codex", "cursor", "copilot"] as Agent[];
    } else if (options.yes) {
      selectedAgents = detected;
    } else {
      console.log(pc.dim("  Detected agents:"));
      detected.forEach((a) =>
        console.log(pc.green(`    ✓ ${AGENT_LABELS[a]}`))
      );
      console.log();
      selectedAgents = detected;
    }
  }

  const projectRoot = process.cwd();
  let installed = 0;

  for (const agent of selectedAgents) {
    console.log(pc.dim(`  Installing for ${AGENT_LABELS[agent]}...`));

    for (const skillName of skillNames) {
      const skillSource = join(skillsDir, skillName);
      installSkillForAgent(projectRoot, agent, skillSource, skillName);
      installed++;
    }
  }

  console.log(
    pc.green(
      `\n  ✓ Installed ${skillNames.length} skills for ${selectedAgents.length} agent(s)\n`
    )
  );

  console.log(pc.dim("  Skills installed:"));
  skillNames.forEach((s) => console.log(pc.dim(`    • ${s}`)));
  console.log();

  console.log(pc.dim("  Agents:"));
  selectedAgents.forEach((a) =>
    console.log(pc.dim(`    • ${AGENT_LABELS[a]}`))
  );
  console.log();
}
