import { defineConfig } from "tsdown";
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

const __dirname = import.meta.dirname;

export default defineConfig({
  entry: ["./src/cli.ts"],
  format: "esm",
  target: "node18",
  shims: true,
  clean: true,
  dts: false,
  onSuccess: async () => {
    const skillsSource = resolve(__dirname, "skills");
    const skillsDist = join(__dirname, "dist", "skills");
    rmSync(skillsDist, { recursive: true, force: true });
    mkdirSync(skillsDist, { recursive: true });
    cpSync(skillsSource, skillsDist, { recursive: true });
  },
});
