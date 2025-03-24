import * as vscode from 'vscode';

const statusBarSelectDeviceCommandId = 'mekatrol.pyboarddev.selectdevice';

let statusBarItem: vscode.StatusBarItem | undefined = undefined;

export const initStatusBar = (context: vscode.ExtensionContext): void => {
  // Register select device command handler
  context.subscriptions.push(
    vscode.commands.registerCommand(statusBarSelectDeviceCommandId, () => {
      const n = getNumberOfSelectedLines(vscode.window.activeTextEditor);
      vscode.window.showInformationMessage(`Yeah, ${n} line(s) selected... Keep going!`);
    })
  );

  // Create select device status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = statusBarSelectDeviceCommandId;
  context.subscriptions.push(statusBarItem);

  // Register listeners for file updates
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusBarItem));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(updateStatusBarItem));

  // Update status bar item once at start
  updateStatusBarItem();
};

export const updateStatusBarItem = (): void => {
  if (!statusBarItem) {
    return;
  }

  const n = getNumberOfSelectedLines(vscode.window.activeTextEditor);
  if (n > 0) {
    statusBarItem.text = `$(megaphone) ${n} line(s) selected`;
    statusBarItem.show();
  } else {
    statusBarItem.hide();
  }
};

const getNumberOfSelectedLines = (editor: vscode.TextEditor | undefined): number => {
  let lines = 0;
  if (editor) {
    lines = editor.selections.reduce((prev, curr) => prev + (curr.end.line - curr.start.line), 0);
  }
  return lines;
};
