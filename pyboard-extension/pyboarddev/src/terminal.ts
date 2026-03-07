/**
 * Module overview:
 * This file is part of the Pydevice extension runtime and contains
 * feature-specific logic isolated for maintainability and unit testing.
 */
import * as vscode from 'vscode';
import {
  getConnectedBoard,
  getConnectedBoardRuntimeInfo,
  onBoardConnectionStateChanged,
  onConnectedBoardRuntimeInfoChanged
} from './commands/connect-board-command';
import { Pydevice } from './utils/pydevice';

const openReplCommandId = 'mekatrol.pydevice.openrepl';
const replPrompt = '>>> ';
const promptFallbackDelayMs = 1200;
const formatForTerminal = (text: string): string => text.replace(/\n/g, '\r\n');
const formatInputForEcho = (text: string): string => text.replace(/\r/g, '\r\n');

const getDisconnectedHint = (): string => {
  return '\r\n[device not connected; use the Pydevice side panel to scan/connect]\r\n';
};

class ReplTerminalManager implements vscode.Disposable {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private readonly pty: vscode.Pseudoterminal;
  private terminal: vscode.Terminal | undefined;
  private boardStateDisposable: vscode.Disposable | undefined;
  private boardRuntimeInfoDisposable: vscode.Disposable | undefined;
  private isPtyOpen = false;
  private currentLine = '';
  private hasRenderedConnectedIntro = false;
  private promptFallbackTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.pty = {
      onDidWrite: this.writeEmitter.event,
      onDidClose: this.closeEmitter.event,
      open: () => {
        this.isPtyOpen = true;
        this.writeEmitter.fire('Pydevice REPL\r\n');
        this.renderConnectionStatus();
      },
      close: () => {
        this.isPtyOpen = false;
      },
      handleInput: async (data: string) => {
        const board = getConnectedBoard();
        if (!board) {
          return;
        }

        // Handle line editing locally and execute on Enter.
        if (data === '\x7f') {
          if (this.currentLine.length > 0) {
            this.currentLine = this.currentLine.slice(0, -1);
          }
          this.writeEmitter.fire('\b \b');
          return;
        }

        if (data === '\r') {
          this.writeEmitter.fire('\r\n');
          const command = this.currentLine;
          this.currentLine = '';

          if (command.trim().length === 0) {
            this.emitPrompt();
            return;
          }

          try {
            const result = await board.execRawCapture(`${command}\n`);
            const combinedOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
            if (result.stdout && result.stdout.length > 0) {
              this.writeEmitter.fire(formatForTerminal(result.stdout));
            }

            if (result.stderr && result.stderr.length > 0) {
              this.writeEmitter.fire(formatForTerminal(result.stderr));
            }

            if (combinedOutput.length > 0 && !combinedOutput.endsWith('\n') && !combinedOutput.endsWith('\r')) {
              this.writeEmitter.fire('\r\n');
            }
            this.emitPrompt();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.writeEmitter.fire(`\r\n[execution failed] ${message}\r\n`);
            this.emitPrompt();
          }

          return;
        }

        this.currentLine += data;
        this.writeEmitter.fire(formatInputForEcho(data));
      }
    };

    this.boardStateDisposable = onBoardConnectionStateChanged((connected) => {
      if (connected) {
        this.hasRenderedConnectedIntro = false;
        this.show();
      } else {
        this.hasRenderedConnectedIntro = false;
        this.clearPromptFallbackTimer();
      }
      this.renderConnectionStatus();
    });

    this.boardRuntimeInfoDisposable = onConnectedBoardRuntimeInfoChanged(() => {
      this.renderConnectionStatus();
    });
  }

  dispose(): void {
    this.boardStateDisposable?.dispose();
    this.boardRuntimeInfoDisposable?.dispose();
    this.clearPromptFallbackTimer();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  show(): void {
    if (!this.terminal) {
      this.terminal = vscode.window.createTerminal({ name: 'Pydevice REPL', pty: this.pty });
    }

    this.terminal.show(true);
  }

  private renderConnectionStatus(): void {
    if (!this.isPtyOpen) {
      return;
    }

    const board = getConnectedBoard();
    if (board) {
      if (this.hasRenderedConnectedIntro) {
        return;
      }

      const runtimeInfo = getConnectedBoardRuntimeInfo();
      if (runtimeInfo) {
        this.clearPromptFallbackTimer();
        this.writeEmitter.fire(`\r\n${runtimeInfo.banner}\r\n`);
        this.writeEmitter.fire('Type "help()" for more information.\r\n');
        this.emitPrompt();
        this.hasRenderedConnectedIntro = true;
      } else {
        this.ensurePromptFallbackTimer();
      }
    } else {
      this.writeEmitter.fire(getDisconnectedHint());
    }
  }

  private emitPrompt(): void {
    this.writeEmitter.fire(replPrompt);
  }

  private ensurePromptFallbackTimer(): void {
    if (this.promptFallbackTimer || this.hasRenderedConnectedIntro) {
      return;
    }

    this.promptFallbackTimer = setTimeout(() => {
      this.promptFallbackTimer = undefined;
      if (!this.isPtyOpen || !getConnectedBoard() || this.hasRenderedConnectedIntro) {
        return;
      }

      this.emitPrompt();
      this.hasRenderedConnectedIntro = true;
    }, promptFallbackDelayMs);
  }

  private clearPromptFallbackTimer(): void {
    if (!this.promptFallbackTimer) {
      return;
    }

    clearTimeout(this.promptFallbackTimer);
    this.promptFallbackTimer = undefined;
  }
}

export const initTerminal = (context: vscode.ExtensionContext): void => {
  const manager = new ReplTerminalManager();

  context.subscriptions.push(manager);
  context.subscriptions.push(
    vscode.commands.registerCommand(openReplCommandId, () => {
      manager.show();
    })
  );
};
