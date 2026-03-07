# Mekatrol Pydevice

Mekatrol Pydevice is a VS Code extension for developing against MicroPython devices with a synced computer workspace, sync tooling, and side-by-side device/computer workflows.

## Core Functions (Quick Summary)

| Core Function | What It Does | Details |
|---|---|---|
| File / Folder Synchronisation | Syncs files and folders between connected device storage and your computer sync, in both directions with preview and selection. | [File / Folder Synchronisation](#file--folder-synchronisation-device--computer) |
| Library Mapping | Maps device library roots to dedicated computer folders so library code can be managed independently from a device’s main mapped folder. | [Library Mapping](#library-mapping-computer-folder--device-library-root) |
| File Difference Comparison | Compares a device file against its computer sync file using VS Code diff view. | [File Difference Comparison](#file-difference-comparison) |
| Excluding Files | Excludes selected device paths from sync operations to protect **passwords** and **secrets** stored on a device. | [Exclude Files From Sync](#exclude-files-from-sync) |
| Computer / Device Explorer View | Shows a dual-tree explorer (COMPUTER + DEVICE) with context actions for open, sync, compare, and mapping. | [Computer / Device Explorer View](#computer--device-explorer-view) |
| Multi-Device Connections | Connects and manages multiple boards at the same time, with per-device status and operations. | [Multi-Device Connections](#multi-device-connections) |
| REPL Window | Provides an interactive REPL panel with per-device command history and quick switching between connected devices. | [REPL Window](#repl-window) |

## Tutorial

Follow the [tutorial](./tutorial.md) to help understand the variaous functions within this vscpode extension.

## Screenshots

Real feature screenshots are not yet included in this repository. The extension currently ships icons only under `images/`.

Recommended screenshot slots (add captures to these paths):

- `images/screenshot-explorer-overview.png` (Computer/Device tree)
- `images/screenshot-sync-preview.png` (sync preview dialog)
- `images/screenshot-library-mapping.png` (device library mapping node)
- `images/screenshot-diff-view.png` (device vs computer compare)
- `images/screenshot-exclusion.png` (excluded path state)

When you add them, embed like this:

```md
![Explorer Overview](images/screenshot-explorer-overview.png)
![Sync Preview](images/screenshot-sync-preview.png)
![Library Mapping](images/screenshot-library-mapping.png)
![Diff View](images/screenshot-diff-view.png)
![Sync Exclusion](images/screenshot-exclusion.png)
```

## File / Folder Synchronisation (Device <-> Computer)

The extension supports two-way sync between device storage and computer sync files.

### Sync directions

- **Device -> Computer**: Pull device content to the mapped computer folders.
- **Computer -> Device**: Push local computer changes to the connected device.

### How sync works

- Compares source and destination file sets and computes create/modify/delete operations.
- Opens a sync preview so operations can be reviewed and selectively unchecked.
- Honors sync exclusions for protected paths.
- Supports syncing from root or from a selected node/path.

### Why this matters

- Keeps device and local project trees aligned.
- Reduces manual copy/upload steps.
- Makes it practical to treat device code like normal project code.

## Library Mapping (Computer Folder -> Device Library Root)

Library mapping lets you maintain reusable libraries in dedicated computer folders while mapping each folder to a device library root.

### Key behavior

- A device can have library folders mapped from computer to device library roots.
- Library-mapped paths are handled separately from the device’s primary mapped folder.
- Device-node sync preview includes mapped library operations and allows selective syncing.

### Why this matters

- Separates app code from shared library code.
- Prevents library content from being mixed into unrelated mapped-folder sync paths.
- Supports cleaner project structure and better reuse.

## File Difference Comparison

You can compare a device file with its computer sync file directly in VS Code diff.

### Compare behavior

- Opens `Computer <-> Device` diff for selected file.
- For device files:
  - Compare action is hidden if the device path is not mapped.
  - Compare action is disabled when mapped but host file is missing.

### Why this matters

- Quickly inspect drift between device runtime files and local source files.
- Validate sync results before/after changes.

## Exclude Files From Sync

Paths can be excluded from synchronization to avoid overwriting/deleting specific files/folders.

### Supported operations

- Exclude selected file/folder from sync.
- Remove exclusion from previously excluded file/folder.
- Exclusions affect sync preview and execution.

### Typical use cases

- Temporary/generated files.
- Device-specific runtime artifacts.
- Paths managed externally.

## Computer / Device Explorer View

The extension provides a dual explorer model with **COMPUTER** and **DEVICE** roots.

### Explorer capabilities

- Browse host sync and device filesystem in one view.
- Open computer files and pull/open device files.
- Run per-node actions: sync, compare, exclude, create, rename, delete.
- Manage device mappings and library mappings from context menus.

### Why this matters

- Single operational surface for day-to-day workflow.
- Faster navigation and fewer command palette round-trips.

## Multi-Device Connections

The extension supports connecting to multiple devices simultaneously.

### Key behavior

- Multiple boards can be connected in parallel from the same VS Code session.
- Connection state is tracked per device ID and serial port.
- You can connect another board without disconnecting the current one.
- Device-level operations (sync, reboot, close connection, REPL activity) are scoped to the selected/active device.

### Why this matters

- Develop and validate across multiple boards in one workspace.
- Compare behavior between devices without repeatedly reconnecting.
- Keep separate device sessions active while troubleshooting.

## REPL Window

The REPL view provides an interactive command console for connected boards.

### REPL capabilities

- Open REPL from the Pydevice panel and run commands interactively.
- Maintain per-device REPL output lines and command history.
- Switch between connected devices in the REPL UI.
- Clear REPL output and clear REPL history with dedicated commands/actions.
- Persist command history (bounded by the configured history limit).

### Why this matters

- Fast ad-hoc inspection and debugging without leaving VS Code.
- Device-specific interactive sessions with command history reuse.
- Practical workflow for iterative testing of small MicroPython snippets.

## Requirements

- VS Code `^1.98.0`
- Node environment compatible with extension dependencies
- Serial access permissions to your board/device

## Extension Settings

This extension contributes these main settings:

- `mekatrol.pydevice.autoReconnectLastDevice`: Reconnect previously connected device on startup.
- `mekatrol.pydevice.verboseReplTransportLogs`: Enable low-level REPL transport logging.
- `mekatrol.pydevice.deviceFileOpenWaitForConnectionMs`: Wait time before device file open/save fails.
- `mekatrol.pydevice.mountHostInWorkspaceExplorer`: Mount host sync in native VS Code Explorer.
- `mekatrol.pydevice.mountDeviceInWorkspaceExplorer`: Mount device filesystem in native Explorer.
- `mekatrol.pydevice.replHistoryLimit`: Per-device REPL history length.

## Known Issues

- Real screenshots are not yet committed; add captures using the screenshot slots above.
- Device connectivity and throughput depend on board firmware, USB drivers, and serial reliability.

## Release Notes

See `CHANGELOG.md` for version-by-version changes.
