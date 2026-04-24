import { cpSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Agent, AGENT_SKILL_DIRS } from "./detect-agents.js";

export function installSkillForAgent(
  projectRoot: string,
  agent: Agent,
  skillSourceDir: string,
  skillName: string
): string {
  const targetPath = join(projectRoot, AGENT_SKILL_DIRS[agent], skillName);
  rmSync(targetPath, { recursive: true, force: true });
  mkdirSync(targetPath, { recursive: true });
  cpSync(skillSourceDir, targetPath, { recursive: true });
  return targetPath;
}
