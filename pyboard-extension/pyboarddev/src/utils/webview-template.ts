import * as fs from 'node:fs';

import * as vscode from 'vscode';

export const createWebviewNonce = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
};

export const escapeJsonForHtml = (value: unknown): string => JSON.stringify(value)
  .replace(/&/g, '\\u0026')
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

export const loadWebviewTemplate = (extensionUri: vscode.Uri, templateName: string): string => {
  const templatePath = vscode.Uri.joinPath(extensionUri, 'dist', 'webviews', templateName, 'index.html');
  return fs.readFileSync(templatePath.fsPath, 'utf8');
};

export const getWebviewAssetUri = (
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  templateName: string,
  fileName: string
): vscode.Uri => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webviews', templateName, fileName));
