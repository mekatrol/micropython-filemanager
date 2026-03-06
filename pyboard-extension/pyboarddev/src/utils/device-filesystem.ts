/**
 * Module overview:
 * This file is part of the Pyboard extension runtime and contains
 * feature-specific logic isolated for maintainability and unit testing.
 */
import { Buffer } from 'buffer';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Pyboard } from './pyboard';

const beginMarker = '__PYBOARDDEV_BEGIN__';
const endMarker = '__PYBOARDDEV_END__';

export interface FileEntry {
  relativePath: string;
  isDirectory: boolean;
  size?: number;
  sha1?: string;
}

export type SyncState = 'synced' | 'out_of_sync' | 'device_only' | 'computer_only';

const toPosixRelative = (input: string): string => {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
};

const toDeviceAbsolutePath = (relativePath: string): string => {
  const clean = toPosixRelative(relativePath);
  return clean.length === 0 ? '/' : `/${clean}`;
};

const wrapScript = (body: string): string => {
  return `${body}\n`;
};

const extractMarkedBlock = (stdout: string): string => {
  const start = stdout.indexOf(beginMarker);
  const end = stdout.indexOf(endMarker);

  if (start < 0 || end < 0 || end < start) {
    throw new Error('Failed to parse device response. Missing output markers.');
  }

  return stdout.slice(start + beginMarker.length, end).trim();
};

const runDeviceScript = async (board: Pyboard, body: string): Promise<string> => {
  const wrapped = wrapScript(body);
  const { stdout, stderr } = await board.execRawCapture(wrapped);

  if (stderr && stderr.trim().length > 0) {
    throw new Error(`Device error: ${stderr.trim()}`);
  }

  return stdout;
};

export const listDeviceEntries = async (board: Pyboard): Promise<FileEntry[]> => {
  const script = `
import os
try:
  import ujson as json
except:
  import json
try:
  import ubinascii as binascii
except:
  import binascii
try:
  import uhashlib as hashlib
except:
  hashlib = None

BEGIN = '${beginMarker}'
END = '${endMarker}'


def file_sha1(p):
  if hashlib is None:
    return None
  try:
    h = hashlib.sha1()
    with open(p, 'rb') as f:
      while True:
        chunk = f.read(256)
        if not chunk:
          break
        h.update(chunk)
    return binascii.hexlify(h.digest()).decode()
  except:
    return None


def is_dir(p):
  try:
    os.listdir(p)
    return True
  except:
    return False


def walk(root):
  out = [{'path': '/', 'type': 'dir'}]

  def rec(base):
    try:
      names = os.listdir(base)
    except:
      return

    for n in names:
      p = (base + '/' + n) if base != '/' else ('/' + n)
      if is_dir(p):
        out.append({'path': p, 'type': 'dir'})
        rec(p)
      else:
        size = None
        try:
          size = os.stat(p)[6]
        except:
          size = None
        out.append({'path': p, 'type': 'file', 'size': size, 'sha1': file_sha1(p)})

  rec(root)
  return out

print(BEGIN)
print(json.dumps(walk('/')))
print(END)
`;

  const stdout = await runDeviceScript(board, script);
  const jsonContent = extractMarkedBlock(stdout);
  const parsed = JSON.parse(jsonContent) as Array<{ path: string; type: 'file' | 'dir'; size?: number; sha1?: string | null }>;

  return parsed.map((entry) => ({
    relativePath: toPosixRelative(entry.path),
    isDirectory: entry.type === 'dir',
    size: entry.size,
    sha1: entry.sha1 ?? undefined
  }));
};

export const readDeviceFile = async (board: Pyboard, relativePath: string): Promise<Buffer> => {
  const absolutePath = toDeviceAbsolutePath(relativePath);
  const script = `
import ubinascii
BEGIN = '${beginMarker}'
END = '${endMarker}'
with open(${JSON.stringify(absolutePath)}, 'rb') as f:
  data = f.read()
print(BEGIN)
print(ubinascii.b2a_base64(data).decode().strip())
print(END)
`;

  const stdout = await runDeviceScript(board, script);
  const base64 = extractMarkedBlock(stdout);
  return Buffer.from(base64, 'base64');
};

export const writeDeviceFile = async (board: Pyboard, relativePath: string, content: Buffer): Promise<void> => {
  const absolutePath = toDeviceAbsolutePath(relativePath);
  const base64Payload = content.toString('base64');

  const script = `
import os
import ubinascii

path = ${JSON.stringify(absolutePath)}
payload = ${JSON.stringify(base64Payload)}

parts = path.split('/')
current = ''
for segment in parts[:-1]:
  if not segment:
    continue
  current += '/' + segment
  try:
    os.mkdir(current)
  except:
    pass

with open(path, 'wb') as f:
  f.write(ubinascii.a2b_base64(payload))

print('${beginMarker}')
print('OK')
print('${endMarker}')
`;

  await runDeviceScript(board, script);
};

export const createDeviceDirectory = async (board: Pyboard, relativePath: string): Promise<void> => {
  const absolutePath = toDeviceAbsolutePath(relativePath);
  const script = `
import os

path = ${JSON.stringify(absolutePath)}

parts = path.split('/')
current = ''
for segment in parts:
  if not segment:
    continue
  current += '/' + segment
  try:
    os.mkdir(current)
  except:
    pass

print('${beginMarker}')
print('OK')
print('${endMarker}')
`;

  await runDeviceScript(board, script);
};

export const renameDevicePath = async (board: Pyboard, fromRelativePath: string, toRelativePath: string): Promise<void> => {
  const fromAbsolutePath = toDeviceAbsolutePath(fromRelativePath);
  const toAbsolutePath = toDeviceAbsolutePath(toRelativePath);
  const script = `
import os

src = ${JSON.stringify(fromAbsolutePath)}
dst = ${JSON.stringify(toAbsolutePath)}

def exists(p):
  try:
    os.stat(p)
    return True
  except:
    return False

if not exists(src):
  raise Exception('Source path not found: ' + src)
if exists(dst):
  raise Exception('Target path already exists: ' + dst)

parts = dst.split('/')
current = ''
for segment in parts[:-1]:
  if not segment:
    continue
  current += '/' + segment
  try:
    os.mkdir(current)
  except:
    pass

os.rename(src, dst)

print('${beginMarker}')
print('OK')
print('${endMarker}')
`;

  await runDeviceScript(board, script);
};

export const deleteDevicePath = async (board: Pyboard, relativePath: string): Promise<void> => {
  const absolutePath = toDeviceAbsolutePath(relativePath);
  const script = `
import os

target = ${JSON.stringify(absolutePath)}

def exists(p):
  try:
    os.stat(p)
    return True
  except:
    return False

def is_dir(p):
  try:
    os.listdir(p)
    return True
  except:
    return False

def remove_recursive(p):
  if is_dir(p):
    for name in os.listdir(p):
      child = (p + '/' + name) if p != '/' else ('/' + name)
      remove_recursive(child)
    os.rmdir(p)
    return
  os.remove(p)

if not exists(target):
  raise Exception('Path not found: ' + target)
if target == '/':
  raise Exception('Deleting the device root is not allowed.')

remove_recursive(target)

print('${beginMarker}')
print('OK')
print('${endMarker}')
`;

  await runDeviceScript(board, script);
};

const walkComputerDirectory = async (basePath: string, currentRelativePath: string, entries: FileEntry[]): Promise<void> => {
  const currentPath = currentRelativePath.length === 0 ? basePath : path.join(basePath, currentRelativePath);
  const children = await fs.readdir(currentPath, { withFileTypes: true });

  for (const child of children) {
    const relative = toPosixRelative(path.posix.join(currentRelativePath, child.name));
    const absolute = path.join(basePath, relative);

    if (child.isDirectory()) {
      entries.push({ relativePath: relative, isDirectory: true });
      await walkComputerDirectory(basePath, relative, entries);
      continue;
    }

    if (!child.isFile()) {
      continue;
    }

    const data = await fs.readFile(absolute);
    const sha1 = createHash('sha1').update(data).digest('hex');
    entries.push({
      relativePath: relative,
      isDirectory: false,
      size: data.byteLength,
      sha1
    });
  }
};

export const scanComputerSyncEntries = async (syncRoot: string): Promise<FileEntry[]> => {
  const entries: FileEntry[] = [{ relativePath: '', isDirectory: true }];

  try {
    await fs.mkdir(syncRoot, { recursive: true });
    await walkComputerDirectory(syncRoot, '', entries);
  } catch {
    return entries;
  }

  return entries;
};

export const resolveSyncRootPath = async (workspaceFolder: vscode.WorkspaceFolder, syncFolder: string): Promise<string> => {
  const syncRoot = path.join(workspaceFolder.uri.fsPath, syncFolder);
  await fs.mkdir(syncRoot, { recursive: true });
  return syncRoot;
};

export const toRelativePath = toPosixRelative;

export const buildSyncStateMap = (
  computerEntries: FileEntry[],
  deviceEntries: FileEntry[]
): Map<string, SyncState> => {
  const computerFiles = new Map(computerEntries.filter((item) => !item.isDirectory).map((item) => [item.relativePath, item]));
  const deviceFiles = new Map(deviceEntries.filter((item) => !item.isDirectory).map((item) => [item.relativePath, item]));
  const allPaths = new Set<string>([...computerFiles.keys(), ...deviceFiles.keys()]);

  const status = new Map<string, SyncState>();
  for (const relativePath of allPaths) {
    const computer = computerFiles.get(relativePath);
    const device = deviceFiles.get(relativePath);

    if (!computer && device) {
      status.set(relativePath, 'device_only');
      continue;
    }

    if (computer && !device) {
      status.set(relativePath, 'computer_only');
      continue;
    }

    if (!computer || !device) {
      continue;
    }

    if (computer.sha1 && device.sha1 && computer.sha1 === device.sha1) {
      status.set(relativePath, 'synced');
      continue;
    }

    if (!device.sha1 && computer.size !== undefined && device.size !== undefined && computer.size === device.size) {
      status.set(relativePath, 'synced');
      continue;
    }

    status.set(relativePath, 'out_of_sync');
  }

  return status;
};

