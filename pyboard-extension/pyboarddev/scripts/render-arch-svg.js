const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function hasOnPath(cmd) {
  const check = process.platform === "win32" ? "where" : "which";
  return spawnSync(check, [cmd], { stdio: "ignore" }).status === 0;
}

function findWindowsDot() {
  const direct = "C:\\Program Files\\Graphviz\\bin\\dot.exe";
  if (fs.existsSync(direct)) {
    return direct;
  }

  const roots = ["C:\\Program Files", "C:\\Program Files (x86)"];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }

    const candidates = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("Graphviz"))
      .map((entry) => path.join(root, entry.name, "bin", "dot.exe"));

    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) {
      return found;
    }
  }

  return null;
}

const dotCmd = hasOnPath("dot")
  ? "dot"
  : process.platform === "win32"
    ? findWindowsDot()
    : null;

if (!dotCmd) {
  console.error("Graphviz \"dot\" not found. Install Graphviz or run: npm run arch:html");
  process.exit(1);
}

const result = spawnSync(
  dotCmd,
  ["-Tsvg", "docs/architecture/deps.dot", "-o", "docs/architecture/deps.svg"],
  { stdio: "inherit" }
);

process.exit(result.status ?? 1);
