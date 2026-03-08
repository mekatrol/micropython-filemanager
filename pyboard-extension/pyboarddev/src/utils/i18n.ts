import * as vscode from 'vscode';

export const t = vscode.l10n.t;

export const showWarningMessage = (...args: unknown[]): Thenable<unknown> => {
  if (typeof args[0] === 'string') {
    args[0] = t(args[0]);
  }
  return (vscode.window.showWarningMessage as (...items: unknown[]) => Thenable<unknown>)(...args);
};

export const showInformationMessage = (...args: unknown[]): Thenable<unknown> => {
  if (typeof args[0] === 'string') {
    args[0] = t(args[0]);
  }
  return (vscode.window.showInformationMessage as (...items: unknown[]) => Thenable<unknown>)(...args);
};

export const showErrorMessage = (...args: unknown[]): Thenable<unknown> => {
  if (typeof args[0] === 'string') {
    args[0] = t(args[0]);
  }
  return (vscode.window.showErrorMessage as (...items: unknown[]) => Thenable<unknown>)(...args);
};
