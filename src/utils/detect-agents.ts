import { execSync } from "node:child_process";

export type Agent =
  | "claude"
  | "codex"
  | "cursor"
  | "copilot"
  | "gemini"
  | "opencode"
  | "droid"
  | "pi";

export const AGENT_LABELS: Record<Agent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
  gemini: "Gemini",
  opencode: "OpenCode",
  droid: "Factory Droid",
  pi: "Pi",
};

export const AGENT_SKILL_DIRS: Record<Agent, string> = {
  claude: ".claude/skills",
  codex: ".codex/skills",
  cursor: ".cursor/skills",
  copilot: ".copilot/skills",
  gemini: ".gemini/skills",
  opencode: ".opencode/skills",
  droid: ".droid/skills",
  pi: ".pi/skills",
};

const ALL_AGENTS: Agent[] = [
  "claude",
  "codex",
  "cursor",
  "copilot",
  "gemini",
  "opencode",
  "droid",
  "pi",
];

function isInPath(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function detectAvailableAgents(): Agent[] {
  return ALL_AGENTS.filter((agent) => isInPath(agent));
}
