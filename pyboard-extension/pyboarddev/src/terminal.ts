import * as vscode from 'vscode';
import { getConnectedBoard, onBoardConnectionStateChanged } from './commands/connect-board-command';
import { Pyboard } from './utils/pyboard';

const openReplCommandId = 'mekatrol.pyboarddev.openrepl';
const formatForTerminal = (text: string): string => text.replace(/\n/g, '\r\n');
const formatInputForEcho = (text: string): string => text.replace(/\r/g, '\r\n');

class ReplTerminalManager implements vscode.Disposable {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private readonly pty: vscode.Pseudoterminal;
  private terminal: vscode.Terminal | undefined;
  private boardStateDisposable: vscode.Disposable | undefined;
  private isPtyOpen = false;
  private currentLine = '';

  constructor() {
    this.pty = {
      onDidWrite: this.writeEmitter.event,
      onDidClose: this.closeEmitter.event,
      open: () => {
        this.isPtyOpen = true;
        this.writeEmitter.fire('Pyboard Dev REPL\r\n');
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
            return;
          }

          try {
            const result = await board.execRawCapture(`${command}\n`);
            if (result.stdout && result.stdout.length > 0) {
              this.writeEmitter.fire(formatForTerminal(result.stdout));
            }

            if (result.stderr && result.stderr.length > 0) {
              this.writeEmitter.fire(formatForTerminal(result.stderr));
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.writeEmitter.fire(`\r\n[execution failed] ${message}\r\n`);
          }

          return;
        }

        this.currentLine += data;
        this.writeEmitter.fire(formatInputForEcho(data));
      }
    };

    this.boardStateDisposable = onBoardConnectionStateChanged((connected) => {
      if (connected) {
        this.show();
      }
      this.renderConnectionStatus();
    });
  }

  dispose(): void {
    this.boardStateDisposable?.dispose();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  show(): void {
    if (!this.terminal) {
      this.terminal = vscode.window.createTerminal({ name: 'Pyboard Dev REPL', pty: this.pty });
    }

    this.terminal.show(true);
  }

  private renderConnectionStatus(): void {
    if (!this.isPtyOpen) {
      return;
    }

    const board = getConnectedBoard();
    if (board) {
      this.writeEmitter.fire(`\r\n[connected ${board.device} @ ${board.baudrate}]\r\n`);
    } else {
      this.writeEmitter.fire('\r\n[device not connected; connect from status bar]\r\n');
    }
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
