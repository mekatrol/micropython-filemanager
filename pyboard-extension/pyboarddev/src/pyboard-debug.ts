import * as path from 'path';
import * as vscode from 'vscode';
import {
  beginBoardExecution,
  endBoardExecution,
  getConnectedBoard,
  getConnectedBoards
} from './commands/connect-board-command';
import { logChannelOutput } from './output-channel';
import { getDeviceHostFolderMappings, loadConfiguration } from './utils/configuration';
import { toRelativePath } from './utils/device-filesystem';

const debugType = 'pyboarddev';
const deviceDocumentScheme = 'pyboarddev-device';
const defaultTimeoutMs = 60000;

interface DapRequest {
  seq: number;
  type: 'request';
  command: string;
  arguments?: Record<string, unknown>;
}

interface DapResponse {
  seq: number;
  type: 'response';
  request_seq: number;
  command: string;
  success: boolean;
  message?: string;
  body?: unknown;
}

interface DapEvent {
  seq: number;
  type: 'event';
  event: string;
  body?: unknown;
}

interface PyboardLaunchConfiguration extends vscode.DebugConfiguration {
  program?: string;
  timeoutMs?: number;
}

class PyboardDebugAdapter implements vscode.DebugAdapter {
  private readonly messageEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.messageEmitter.event;
  private sequence = 1;
  private terminateRequested = false;
  private launchDeviceId: string | undefined;

  dispose(): void {
    this.messageEmitter.dispose();
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const request = message as unknown as DapRequest;
    if (request.type !== 'request') {
      return;
    }

    void this.handleRequest(request);
  }

  private async handleRequest(request: DapRequest): Promise<void> {
    switch (request.command) {
      case 'initialize':
        this.sendResponse(request, {
          supportsConfigurationDoneRequest: true
        });
        this.sendEvent('initialized');
        return;
      case 'launch':
        this.sendResponse(request);
        await this.handleLaunch(request.arguments ?? {});
        return;
      case 'threads':
        this.sendResponse(request, {
          threads: [{ id: 1, name: 'main' }]
        });
        return;
      case 'setBreakpoints':
        this.sendResponse(request, {
          breakpoints: []
        });
        return;
      case 'setExceptionBreakpoints':
      case 'configurationDone':
      case 'stackTrace':
      case 'scopes':
      case 'variables':
      case 'disconnect':
      case 'terminate':
        this.sendResponse(request);
        if (request.command === 'disconnect' || request.command === 'terminate') {
          this.terminateRequested = true;
          this.sendEvent('terminated');
        }
        return;
      default:
        this.sendResponse(request);
    }
  }

  private async handleLaunch(args: Record<string, unknown>): Promise<void> {
    let exitCode = 0;
    this.terminateRequested = false;
    this.launchDeviceId = undefined;

    try {
      const programValue = typeof args.program === 'string' ? args.program : undefined;
      const targetUri = this.resolveProgramUri(programValue);
      if (!targetUri) {
        throw new Error('No runnable file selected. Open a Python file and run again.');
      }

      const targetDeviceId = await this.resolveTargetDeviceId(targetUri);
      const board = getConnectedBoard(targetDeviceId);
      if (!board || !targetDeviceId) {
        throw new Error('No matching connected board for the active file. Connect the owning device and run again.');
      }

      this.launchDeviceId = targetDeviceId;
      beginBoardExecution(targetDeviceId);

      const content = await vscode.workspace.fs.readFile(targetUri);
      const script = Buffer.from(content).toString('utf8');
      const timeoutMs = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) ? args.timeoutMs : defaultTimeoutMs;

      const command = this.buildExecutionCommand(script, this.displayPath(targetUri));
      const { stdout, stderr } = await board.execRawCapture(command, timeoutMs);
      const normalisedStdout = this.normaliseLineEndings(stdout);
      const normalisedStderr = this.normaliseLineEndings(stderr);

      if (normalisedStdout.length > 0) {
        logChannelOutput(normalisedStdout, true);
        this.sendEvent('output', {
          category: 'console',
          output: this.ensureTrailingNewline(normalisedStdout)
        });
      }

      if (normalisedStderr.length > 0) {
        exitCode = 1;
        logChannelOutput(normalisedStderr, true);
        this.sendEvent('output', {
          category: 'console',
          output: this.ensureTrailingNewline(normalisedStderr)
        });
      }

      logChannelOutput(`Run on device ${targetDeviceId} completed: ${this.displayPath(targetUri)}`, true);
    } catch (error) {
      exitCode = 1;
      const message = error instanceof Error ? error.message : String(error);
      this.sendEvent('output', {
        category: 'stderr',
        output: this.ensureTrailingNewline(message)
      });
      logChannelOutput(`Run on device failed: ${message}`, true);
    } finally {
      if (this.launchDeviceId) {
        endBoardExecution(this.launchDeviceId);
      }

      if (this.terminateRequested && this.launchDeviceId) {
        await softRebootConnectedBoard(
          this.launchDeviceId,
          `Device ${this.launchDeviceId} soft rebooted after debug session stop.`,
          `Failed to soft reboot device ${this.launchDeviceId} after debug session stop`
        );
      }

      this.sendEvent('exited', { exitCode });
      this.sendEvent('terminated');
      this.launchDeviceId = undefined;
    }
  }

  private sendResponse(request: DapRequest, body?: unknown, success: boolean = true, message?: string): void {
    const response: DapResponse = {
      seq: this.sequence++,
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success
    };

    if (body !== undefined) {
      response.body = body;
    }

    if (message !== undefined) {
      response.message = message;
    }

    this.messageEmitter.fire(response as unknown as vscode.DebugProtocolMessage);
  }

  private sendEvent(event: string, body?: unknown): void {
    const payload: DapEvent = {
      seq: this.sequence++,
      type: 'event',
      event
    };

    if (body !== undefined) {
      payload.body = body;
    }

    this.messageEmitter.fire(payload as unknown as vscode.DebugProtocolMessage);
  }

  private resolveProgramUri(program: string | undefined): vscode.Uri | undefined {
    if (!program) {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active && (active.scheme === 'file' || active.scheme === deviceDocumentScheme)) {
        return active;
      }
      return undefined;
    }

    if (/^[a-zA-Z]:[\\/]/.test(program)) {
      return vscode.Uri.file(program);
    }

    if (program.startsWith('/') || program.startsWith('./') || program.startsWith('../')) {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder && !path.isAbsolute(program)) {
        return vscode.Uri.file(path.join(folder.uri.fsPath, program));
      }
      return vscode.Uri.file(program);
    }

    const parsed = vscode.Uri.parse(program, true);
    if (parsed.scheme.length > 0) {
      return parsed;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }

    return vscode.Uri.file(path.join(folder.uri.fsPath, program));
  }

  private async resolveTargetDeviceId(targetUri: vscode.Uri): Promise<string | undefined> {
    if (targetUri.scheme === deviceDocumentScheme) {
      const segments = toRelativePath(targetUri.path.replace(/^\/+/, '')).split('/').filter(Boolean);
      if (segments.length > 1) {
        try {
          return decodeURIComponent(segments[0]);
        } catch {
          return segments[0];
        }
      }

      return getConnectedBoards()[0]?.deviceId;
    }

    if (targetUri.scheme === 'file') {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const config = await loadConfiguration();
        const mappings = Object.entries(getDeviceHostFolderMappings(config))
          .map(([deviceId, folder]) => ({ deviceId, folder: toRelativePath(folder) }))
          .filter((item) => item.folder.length > 0);
        const workspaceRelative = toRelativePath(path.relative(workspaceFolder.uri.fsPath, targetUri.fsPath));
        if (workspaceRelative && !workspaceRelative.startsWith('..')) {
          const mappedMatches = mappings.filter(
            (item) => workspaceRelative === item.folder || workspaceRelative.startsWith(`${item.folder}/`)
          );
          if (mappedMatches.length === 1) {
            return mappedMatches[0].deviceId;
          }

          if (mappedMatches.length > 1) {
            const connectedById = new Map(getConnectedBoards().map((item) => [item.deviceId, item]));
            const options = mappedMatches
              .map((item) => connectedById.get(item.deviceId))
              .filter((item): item is NonNullable<typeof item> => Boolean(item));
            if (options.length === 1) {
              return options[0].deviceId;
            }

            if (options.length > 1) {
              const selected = await vscode.window.showQuickPick(
                options.map((item) => ({
                  label: item.deviceId,
                  description: `${item.devicePath} @ ${item.baudRate}`
                })),
                {
                  placeHolder: 'Multiple mapped devices match this computer folder. Select target device.',
                  canPickMany: false,
                  ignoreFocusOut: true
                }
              );
              return selected?.label;
            }
          }
        }

      }
    }

    return getConnectedBoards()[0]?.deviceId;
  }

  private displayPath(uri: vscode.Uri): string {
    if (uri.scheme === 'file') {
      return uri.fsPath;
    }

    return uri.path;
  }

  private buildExecutionCommand(script: string, fileName: string): string {
    return [
      `__pyboarddev_code = ${JSON.stringify(script)}`,
      `__pyboarddev_file = ${JSON.stringify(fileName)}`,
      "__pyboarddev_globals = {'__name__': '__main__', '__file__': __pyboarddev_file}",
      'exec(compile(__pyboarddev_code, __pyboarddev_file, "exec"), __pyboarddev_globals)'
    ].join('\n');
  }

  private ensureTrailingNewline(value: string): string {
    return value.endsWith('\n') ? value : `${value}\n`;
  }

  private normaliseLineEndings(value: string): string {
    return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }
}

const softRebootConnectedBoard = async (deviceId: string, successMessage: string, failurePrefix: string): Promise<void> => {
  const board = getConnectedBoard(deviceId);
  if (!board) {
    return;
  }

  try {
    await board.softReboot();
    logChannelOutput(successMessage, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logChannelOutput(`${failurePrefix}: ${message}`, true);
  }
};

class PyboardDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new PyboardDebugAdapter());
  }
}

class PyboardDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  provideDebugConfigurations(): vscode.ProviderResult<vscode.DebugConfiguration[]> {
    return [
      {
        type: debugType,
        request: 'launch',
        name: 'Pyboard Dev: Run Current File',
        program: '${file}',
        timeoutMs: defaultTimeoutMs
      }
    ];
  }

  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    debugConfiguration: vscode.DebugConfiguration
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    const config = debugConfiguration as PyboardLaunchConfiguration;
    if (!config.type && !config.request && !config.name) {
      return this.buildDefaultConfig();
    }

    if (config.type === debugType && !config.program) {
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      if (activeUri && (activeUri.scheme === 'file' || activeUri.scheme === deviceDocumentScheme)) {
        config.program = activeUri.toString();
      }
    }

    if (config.type === debugType && config.program === '${file}') {
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      if (activeUri && (activeUri.scheme === 'file' || activeUri.scheme === deviceDocumentScheme)) {
        config.program = activeUri.toString();
      }
    }

    return config;
  }

  private buildDefaultConfig(): vscode.DebugConfiguration | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (!activeUri || (activeUri.scheme !== 'file' && activeUri.scheme !== deviceDocumentScheme)) {
      vscode.window.showErrorMessage('Open a computer or device Python file before running.');
      return undefined;
    }

    return {
      type: debugType,
      request: 'launch',
      name: 'Pyboard Dev: Run Current File',
      program: activeUri.toString(),
      timeoutMs: defaultTimeoutMs
    };
  }
}

export const initPyboardDebug = (context: vscode.ExtensionContext): void => {
  const configProvider = new PyboardDebugConfigurationProvider();
  const adapterFactory = new PyboardDebugAdapterDescriptorFactory();

  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(debugType, configProvider));
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(debugType, adapterFactory));
};
