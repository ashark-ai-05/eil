import { readFileSync } from "node:fs";
import { REGISTRY } from "../ts/tools.js";

const names = Object.keys(REGISTRY);
const files = ["README.md", "docs/mcp.md"];
const errors: string[] = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const name of names)
    if (!text.includes(`\`${name}\``)) errors.push(`${file}: missing ${name}`);
  if (!text.includes(`${names.length} tools`) && !text.includes("six tools"))
    errors.push(`${file}: missing tool count ${names.length}`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`tool docs: up to date (${names.length} tools)`);
