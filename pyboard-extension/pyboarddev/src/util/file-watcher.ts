/**
 * Module overview:
 * Watches file events from VS Code and direct disk changes, then publishes a
 * unified event stream for host and device paths.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { logChannelOutput } from '../output-channel';

export type FileWatcherScope = 'host' | 'device';
export type FileWatcherSource = 'vscode' | 'disk' | 'device-source' | 'manual';
export type FileWatcherChangeType = 'created' | 'modified' | 'deleted';
export type FileWatcherEntityType = 'file' | 'folder' | 'unknown';

export interface FileWatcherEvent {
  scope: FileWatcherScope;
  source: FileWatcherSource;
  changeType: FileWatcherChangeType;
  entityType: FileWatcherEntityType;
  uri: vscode.Uri;
  workspaceRelativePath: string;
  timestamp: number;
}

export interface FileWatcherOptions {
  workspaceFolder?: vscode.WorkspaceFolder;
  excludedPaths?: string[];
  enableHostVsCodeWatcher?: boolean;
  enableHostDiskWatcher?: boolean;
  enableDeviceVsCodeWatcher?: boolean;
  logEvents?: boolean;
}

const defaultOptions: Required<Omit<FileWatcherOptions, 'workspaceFolder' | 'excludedPaths'>> = {
  enableHostVsCodeWatcher: true,
  enableHostDiskWatcher: true,
  enableDeviceVsCodeWatcher: true,
  logEvents: true
};

export class FileWatcher implements vscode.Disposable {
  private static readonly duplicateEventWindowMs = 250;
  private static readonly caseInsensitiveComparisons = process.platform === 'win32';
  private readonly options: Required<Omit<FileWatcherOptions, 'workspaceFolder' | 'excludedPaths'>>;
  private readonly workspaceFolder: vscode.WorkspaceFolder | undefined;
  private readonly eventEmitter = new vscode.EventEmitter<FileWatcherEvent>();
  private readonly subscriptions = new Set<(event: FileWatcherEvent) => void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly recentEventTimestamps = new Map<string, number>();
  private hostDiskWatcher: fs.FSWatcher | undefined;
  private excludedPathPrefixes: string[] = [];
  private started = false;

  readonly onDidEvent: vscode.Event<FileWatcherEvent> = this.eventEmitter.event;

  constructor(options: FileWatcherOptions = {}) {
    this.workspaceFolder = options.workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
    this.options = {
      ...defaultOptions,
      enableHostVsCodeWatcher: options.enableHostVsCodeWatcher ?? defaultOptions.enableHostVsCodeWatcher,
      enableHostDiskWatcher: options.enableHostDiskWatcher ?? defaultOptions.enableHostDiskWatcher,
      enableDeviceVsCodeWatcher: options.enableDeviceVsCodeWatcher ?? defaultOptions.enableDeviceVsCodeWatcher,
      logEvents: options.logEvents ?? defaultOptions.logEvents
    };
    this.setExcludedPaths(options.excludedPaths ?? []);
  }

  subscribe(listener: (event: FileWatcherEvent) => void): vscode.Disposable {
    this.subscriptions.add(listener);
    return new vscode.Disposable(() => {
      this.subscriptions.delete(listener);
    });
  }

  setExcludedPaths(paths: string[]): void {
    this.excludedPathPrefixes = [...new Set(paths
      .map((item) => this.normaliseRelativePath(item))
      .map((item) => this.toComparisonPath(item))
      .filter((item) => item.length > 0))];
  }

  addExcludedPath(value: string): void {
    const normalised = this.toComparisonPath(this.normaliseRelativePath(value));
    if (!normalised || this.excludedPathPrefixes.includes(normalised)) {
      return;
    }
    this.excludedPathPrefixes.push(normalised);
  }

  removeExcludedPath(value: string): void {
    const normalised = this.toComparisonPath(this.normaliseRelativePath(value));
    this.excludedPathPrefixes = this.excludedPathPrefixes.filter((item) => item !== normalised);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    if (!this.workspaceFolder) {
      this.log('FileWatcher start skipped: no workspace folder available.');
      return;
    }

    if (this.options.enableHostVsCodeWatcher) {
      this.startHostVsCodeWatcher();
    }
    if (this.options.enableHostDiskWatcher) {
      this.startHostDiskWatcher();
    }
    if (this.options.enableDeviceVsCodeWatcher) {
      this.startDeviceVsCodeWatcher();
    }
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;

    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }

    if (this.hostDiskWatcher) {
      this.hostDiskWatcher.close();
      this.hostDiskWatcher = undefined;
    }
  }

  addDeviceEventSource(onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>): vscode.Disposable {
    const disposable = onDidChangeFile((events) => {
      for (const event of events) {
        const changeType = this.toFileWatcherChangeType(event.type);
        if (!changeType) {
          continue;
        }

        void this.publishDeviceEvent(changeType, event.uri, 'device-source');
      }
    });
    this.disposables.push(disposable);
    return disposable;
  }

  publishDeviceEvent(
    changeType: FileWatcherChangeType,
    uri: vscode.Uri,
    source: FileWatcherSource = 'manual',
    entityType: FileWatcherEntityType = 'unknown'
  ): Promise<void> {
    if (uri.scheme !== 'pydevice-device') {
      return Promise.resolve();
    }

    const workspaceRelativePath = this.toWorkspaceRelativePath(uri, 'device');
    if (!workspaceRelativePath || this.isExcluded(workspaceRelativePath)) {
      return Promise.resolve();
    }
    if (this.isDuplicateEvent('device', source, changeType, workspaceRelativePath)) {
      return Promise.resolve();
    }

    const doPublish = async (): Promise<void> => {
      const resolvedEntityType = entityType === 'unknown'
        ? await this.resolveEntityType(changeType, uri)
        : entityType;

      await this.publishEvent({
        scope: 'device',
        source,
        changeType,
        entityType: resolvedEntityType,
        uri,
        workspaceRelativePath,
        timestamp: Date.now()
      });
    };

    return doPublish();
  }

  dispose(): void {
    this.stop();
    this.eventEmitter.dispose();
    this.subscriptions.clear();
  }

  private startHostVsCodeWatcher(): void {
    const relativePattern = new vscode.RelativePattern(this.workspaceFolder!, '**/*');
    const watcher = vscode.workspace.createFileSystemWatcher(relativePattern, false, false, false);

    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => void this.publishFromUri('host', 'vscode', 'created', uri)),
      watcher.onDidChange((uri) => void this.publishFromUri('host', 'vscode', 'modified', uri)),
      watcher.onDidDelete((uri) => void this.publishFromUri('host', 'vscode', 'deleted', uri)),
      vscode.workspace.onDidCreateFiles((event) => {
        for (const uri of event.files) {
          void this.publishFromUri('host', 'vscode', 'created', uri);
        }
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        for (const uri of event.files) {
          void this.publishFromUri('host', 'vscode', 'deleted', uri);
        }
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        for (const entry of event.files) {
          void this.publishFromUri('host', 'vscode', 'deleted', entry.oldUri);
          void this.publishFromUri('host', 'vscode', 'created', entry.newUri);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.publishFromUri('host', 'vscode', 'modified', document.uri);
      })
    );
  }

  private startHostDiskWatcher(): void {
    const rootPath = this.workspaceFolder?.uri.fsPath;
    if (!rootPath) {
      return;
    }

    try {
      this.hostDiskWatcher = fs.watch(rootPath, { recursive: true }, (eventType, relativePath) => {
        if (!relativePath || typeof relativePath !== 'string') {
          return;
        }

        const relative = this.normaliseRelativePath(relativePath);
        if (!relative || this.isExcluded(relative)) {
          return;
        }

        const absolutePath = path.join(rootPath, relative);
        const uri = vscode.Uri.file(absolutePath);
        const exists = fs.existsSync(absolutePath);
        const changeType: FileWatcherChangeType = exists
          ? (eventType === 'rename' ? 'created' : 'modified')
          : 'deleted';

        void this.publishFromUri('host', 'disk', changeType, uri);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`FileWatcher host disk watcher failed to start: ${message}`);
    }
  }

  private startDeviceVsCodeWatcher(): void {
    this.disposables.push(
      vscode.workspace.onDidCreateFiles((event) => {
        for (const uri of event.files.filter((item) => item.scheme === 'pydevice-device')) {
          void this.publishDeviceEvent('created', uri, 'vscode');
        }
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        for (const uri of event.files.filter((item) => item.scheme === 'pydevice-device')) {
          void this.publishDeviceEvent('deleted', uri, 'vscode');
        }
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        for (const entry of event.files) {
          if (entry.oldUri.scheme === 'pydevice-device') {
            void this.publishDeviceEvent('deleted', entry.oldUri, 'vscode');
          }
          if (entry.newUri.scheme === 'pydevice-device') {
            void this.publishDeviceEvent('created', entry.newUri, 'vscode');
          }
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === 'pydevice-device') {
          void this.publishDeviceEvent('modified', document.uri, 'vscode');
        }
      })
    );
  }

  private async publishFromUri(
    scope: FileWatcherScope,
    source: FileWatcherSource,
    changeType: FileWatcherChangeType,
    uri: vscode.Uri
  ): Promise<void> {
    if (scope === 'host' && uri.scheme !== 'file') {
      return;
    }
    
    if (scope === 'device') {
      await this.publishDeviceEvent(changeType, uri, source);
      return;
    }

    const workspaceRelativePath = this.toWorkspaceRelativePath(uri, scope);
    if (!workspaceRelativePath || this.isExcluded(workspaceRelativePath)) {
      return;
    }
    if (this.isDuplicateEvent(scope, source, changeType, workspaceRelativePath)) {
      return;
    }

    const entityType = await this.resolveEntityType(changeType, uri);

    await this.publishEvent({
      scope,
      source,
      changeType,
      entityType,
      uri,
      workspaceRelativePath,
      timestamp: Date.now()
    });
  }

  private async publishEvent(event: FileWatcherEvent): Promise<void> {
    this.eventEmitter.fire(event);
    for (const listener of this.subscriptions) {
      listener(event);
    }

    this.log(
      `[FileWatcher] ${event.scope} ${event.source} ${event.changeType} ${event.entityType}: ${event.workspaceRelativePath}`
    );
  }

  private async resolveEntityType(changeType: FileWatcherChangeType, uri: vscode.Uri): Promise<FileWatcherEntityType> {
    if (changeType === 'deleted') {
      return 'unknown';
    }

    if (uri.scheme === 'file') {
      try {
        const stats = fs.statSync(uri.fsPath);
        return stats.isDirectory() ? 'folder' : 'file';
      } catch {
        return 'unknown';
      }
    }

    try {
      const stats = await vscode.workspace.fs.stat(uri);
      return stats.type === vscode.FileType.Directory ? 'folder' : 'file';
    } catch {
      return 'unknown';
    }
  }

  private toWorkspaceRelativePath(uri: vscode.Uri, scope: FileWatcherScope): string {
    if (scope === 'host') {
      const workspacePath = this.workspaceFolder?.uri.fsPath;
      if (!workspacePath || !uri.fsPath) {
        return '';
      }

      const relativePath = path.relative(workspacePath, uri.fsPath);
      if (!relativePath || relativePath.startsWith('..')) {
        return '';
      }

      return this.normaliseRelativePath(relativePath);
    }

    return this.normaliseRelativePath(uri.path.replace(/^\/+/, ''));
  }

  private normaliseRelativePath(value: string): string {
    const replaced = value.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!replaced || replaced === '.') {
      return '';
    }

    return replaced
      .split('/')
      .filter((item) => item.length > 0)
      .join('/');
  }

  private isExcluded(relativePath: string): boolean {
    if (this.excludedPathPrefixes.length === 0) {
      return false;
    }

    const comparePath = this.toComparisonPath(relativePath);
    return this.excludedPathPrefixes.some((prefix) => {
      return comparePath === prefix || comparePath.startsWith(`${prefix}/`);
    });
  }

  private toFileWatcherChangeType(type: vscode.FileChangeType): FileWatcherChangeType | undefined {
    if (type === vscode.FileChangeType.Created) {
      return 'created';
    }
    if (type === vscode.FileChangeType.Changed) {
      return 'modified';
    }
    if (type === vscode.FileChangeType.Deleted) {
      return 'deleted';
    }

    return undefined;
  }

  private isDuplicateEvent(
    scope: FileWatcherScope,
    source: FileWatcherSource,
    changeType: FileWatcherChangeType,
    workspaceRelativePath: string
  ): boolean {
    // VS Code can emit the same operation via multiple watcher APIs in quick succession.
    const key = `${scope}|${source}|${changeType}|${this.toComparisonPath(workspaceRelativePath)}`;
    const now = Date.now();
    const previous = this.recentEventTimestamps.get(key);
    this.recentEventTimestamps.set(key, now);

    if (this.recentEventTimestamps.size > 2000) {
      for (const [mapKey, timestamp] of this.recentEventTimestamps) {
        if (now - timestamp > FileWatcher.duplicateEventWindowMs * 4) {
          this.recentEventTimestamps.delete(mapKey);
        }
      }
    }

    return previous !== undefined && now - previous <= FileWatcher.duplicateEventWindowMs;
  }

  private toComparisonPath(relativePath: string): string {
    if (FileWatcher.caseInsensitiveComparisons) {
      return relativePath.toLowerCase();
    }

    return relativePath;
  }

  private log(message: string): void {
    if (!this.options.logEvents) {
      return;
    }

    logChannelOutput(message, false);
  }
}
