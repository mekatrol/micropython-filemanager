import * as vscode from 'vscode';

import { ConnectRow, ConnectStatus } from './connect-state';
import { createWebviewNonce, escapeJsonForHtml, getWebviewAssetUri, loadWebviewTemplate } from '../utils/webview-template';

const statusMap = {
  ready: ConnectStatus.Ready,
  connecting: ConnectStatus.Connecting,
  connected: ConnectStatus.Connected,
  notConnected: ConnectStatus.NotConnected,
  error: ConnectStatus.Error
} as const;

export const renderConnectHtml = (
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  rows: ConnectRow[],
  connectAttemptTimeoutMs: number
): string => {
  const nonce = createWebviewNonce();
  const template = loadWebviewTemplate(extensionUri, 'connect');
  const cssUri = getWebviewAssetUri(webview, extensionUri, 'connect', 'index.css');
  const scriptUri = getWebviewAssetUri(webview, extensionUri, 'connect', 'index.js');
  const initialState = escapeJsonForHtml({
    rows,
    statusMap,
    connectAttemptTimeoutMs
  });

  return template
    .replaceAll('__CSP_SOURCE__', webview.cspSource)
    .replaceAll('__NONCE__', nonce)
    .replace('__CSS_URI__', cssUri.toString())
    .replace('__SCRIPT_URI__', scriptUri.toString())
    .replace('__INITIAL_STATE__', initialState);
};
