// Keeps the plugin's skills/agent-hours/SKILL.md in sync with the single
// source of truth in src/install.ts (runs as part of `npm run build`).
import { SKILL_MD } from "../dist/install.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, "skills", "agent-hours");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "SKILL.md"), SKILL_MD);
console.log("synced skills/agent-hours/SKILL.md");
