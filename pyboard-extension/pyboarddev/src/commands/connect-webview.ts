import * as vscode from 'vscode';

import { ConnectRow, ConnectStatus } from './connect-state';
import { createWebviewNonce, escapeJsonForHtml, getWebviewAssetUri, loadWebviewTemplate } from '../utils/webview-template';
import { t } from '../utils/i18n';

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
    connectAttemptTimeoutMs,
    i18n: {
      connectingDevices: t('Connecting devices'),
      disconnectingDevices: t('Disconnecting devices'),
      probingDevices: t('Probing devices'),
      cancelling: t('Cancelling...'),
      preparingProbe: t('Preparing probe...'),
      connectingWithSeconds: t('Connecting... ({0}s)'),
      connected: t('Connected'),
      disconnect: t('Disconnect'),
      error: t('Error'),
      retry: t('Retry'),
      notConnected: t('Not connected'),
      connect: t('Connect'),
      setDeviceName: t('Set device name'),
      cancel: t('Cancel')
    }
  });

  return template
    .replaceAll('__CSP_SOURCE__', webview.cspSource)
    .replaceAll('__NONCE__', nonce)
    .replace('__CSS_URI__', cssUri.toString())
    .replace('__SCRIPT_URI__', scriptUri.toString())
    .replace('__INITIAL_STATE__', initialState)
    .replaceAll('__TITLE__', t('Device connect'))
    .replace('__HINT__', t('Connect individual rows or use Connect all.'))
    .replace('__UNCONNECTED_PORTS_TITLE__', t('Unconnected serial ports'))
    .replace('__CONNECTED_PORTS_TITLE__', t('Connected serial ports'))
    .replaceAll('__SERIAL_PORT__', t('Serial Port'))
    .replaceAll('__STATUS__', t('Status'))
    .replace('__DEVICE_NAME__', t('Device Name'))
    .replace('__DEVICE_ID__', t('Device ID'))
    .replace('__DEVICE_INFO__', t('Device Info'))
    .replace('__PROBE_DEVICES__', t('Probe devices'))
    .replace('__CONNECT_ALL__', t('Connect all'))
    .replace('__DISCONNECT_ALL__', t('Disconnect all'))
    .replace('__CLOSE__', t('Close'))
    .replace('__PROBE_STATUS_ARIA__', t('Probe devices status'))
    .replace('__PROBING_DEVICES__', t('Probing devices'))
    .replace('__PREPARING_PROBE__', t('Preparing probe...'))
    .replace('__CANCEL__', t('Cancel'));
};
