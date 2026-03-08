# Build Instructions (Architecture Diagrams)

This project includes npm scripts to generate a code dependency/architecture diagram from `src` (excluding `src/test`).

Outputs are written to:
- `docs/architecture/deps.dot`
- `docs/architecture/deps.svg`
- `docs/architecture/deps.html`

## One-time setup

### Windows

1. Install Node.js (includes npm) if needed:
```powershell
winget install OpenJS.NodeJS.LTS
```

2. Install Graphviz (`dot` command) for SVG output:
```powershell
winget install Graphviz.Graphviz
```

3. Reopen terminal, then install project dependencies:
```powershell
npm install
```

4. Verify Graphviz is on PATH:
```powershell
dot -V
```

5. If `dot -V` fails, locate `dot.exe` and add it to your user PATH:
```powershell
$dot = Get-ChildItem "C:\Program Files\Graphviz*\bin\dot.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$dot.FullName
```

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  $env:Path + ";" + (Split-Path $dot.FullName),
  "User"
)
```

6. Close and reopen the terminal, then verify again:
```powershell
dot -V
```

### Linux

1. Install Node.js + npm (example for Debian/Ubuntu):
```bash
sudo apt update
sudo apt install -y nodejs npm
```

2. Install Graphviz (`dot` command):
```bash
sudo apt install -y graphviz
```

3. Install project dependencies:
```bash
npm install
```

4. Verify Graphviz:
```bash
dot -V
```

## Build commands

### Generate SVG diagram (preferred)
```bash
npm run arch:svg
```

### Auto mode (SVG if Graphviz exists, otherwise HTML)
```bash
npm run arch:auto
```

### HTML only
```bash
npm run arch:html
```

## Notes

- If `npm run arch:svg` says `dot` is not recognized, Graphviz is not installed or not on PATH.
- On fresh installs, reopen your terminal after installing Graphviz so PATH updates apply.
