import { ConnectRow, ConnectStatus } from './connect-state';

const statusMap = {
  resolving: ConnectStatus.Resolving,
  ready: ConnectStatus.Ready,
  connecting: ConnectStatus.Connecting,
  connected: ConnectStatus.Connected,
  notConnected: ConnectStatus.NotConnected,
  error: ConnectStatus.Error
} as const;

export const renderConnectHtml = (rows: ConnectRow[]): string => {
  const rowsJson = JSON.stringify(rows);
  const statusJson = JSON.stringify(statusMap);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Device connect</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    .wrap { max-width: 1100px; margin: 28px auto; padding: 0 20px 20px; }
    h2 { margin: 0 0 10px; font-size: 16px; }
    .hint { margin: 0 0 12px; opacity: 0.9; }
    table { width: 100%; border-collapse: collapse; border: 1px solid var(--vscode-editorWidget-border); table-layout: fixed; }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--vscode-editorWidget-border); vertical-align: middle; }
    th { text-align: left; font-weight: 600; }
    th.name, td.name { width: 200px; }
    th.id, td.id { width: 240px; }
    th.port, td.port { width: 140px; }
    th.deviceInfo, td.deviceInfo { width: 400px; }
    th.status, td.status { width: 190px; }
    td.id, td.port, td.deviceInfo { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .status-wrap { display: inline-flex; align-items: center; gap: 8px; }
    .icon { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; }
    .icon svg { width: 14px; height: 14px; fill: currentColor; }
    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .ok { color: var(--vscode-charts-green); font-weight: 600; }
    .err { color: var(--vscode-errorForeground); }
    .secondary-text { color: var(--vscode-descriptionForeground); }
    .link {
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      font: inherit;
    }
    .buttons { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 6px 14px;
      cursor: pointer;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h2>Device connect</h2>
    <p class="hint">Device IDs are probed in the background. Connect individual rows or use Connect all.</p>
    <table>
      <thead>
        <tr>
          <th class="name">Device Name</th>
          <th class="id">Device ID</th>
          <th class="port">Serial Port</th>
          <th class="deviceInfo">Device Info</th>
          <th class="status">Status</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="buttons">
      <button id="connectAll">Connect all</button>
      <button id="close" class="secondary">Close</button>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const rows = ${rowsJson};
    const status = ${statusJson};
    const tbody = document.getElementById('rows');
    const passIconSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6484 5.64648C10.8434 5.45148 11.1605 5.45148 11.3555 5.64648C11.5498 5.84137 11.5499 6.15766 11.3555 6.35254L7.35547 10.3525C7.25747 10.4495 7.12898 10.499 7.00098 10.499C6.87299 10.499 6.74545 10.4505 6.64746 10.3525L4.64746 8.35254C4.45247 8.15754 4.45248 7.84148 4.64746 7.64648C4.84246 7.45148 5.15949 7.45148 5.35449 7.64648L7 9.29199L10.6465 5.64648H10.6484Z"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M8 1C11.86 1 15 4.14 15 8C15 11.86 11.86 15 8 15C4.14 15 1 11.86 1 8C1 4.14 4.14 1 8 1ZM8 2C4.691 2 2 4.691 2 8C2 11.309 4.691 14 8 14C11.309 14 14 11.309 14 8C14 4.691 11.309 2 8 2Z"></path></svg>';
    const warningIconSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.831 11.965L9.206 1.714C8.965 1.274 8.503 1 8 1C7.497 1 7.035 1.274 6.794 1.714L1.169 11.965C1.059 12.167 1 12.395 1 12.625C1 13.383 1.617 14 2.375 14H13.625C14.383 14 15 13.383 15 12.625C15 12.395 14.941 12.167 14.831 11.965ZM13.625 13H2.375C2.168 13 2 12.832 2 12.625C2 12.561 2.016 12.5 2.046 12.445L7.671 2.195C7.736 2.075 7.863 2 8 2C8.137 2 8.264 2.075 8.329 2.195L13.954 12.445C13.984 12.501 14 12.561 14 12.625C14 12.832 13.832 13 13.625 13ZM8.75 11.25C8.75 11.664 8.414 12 8 12C7.586 12 7.25 11.664 7.25 11.25C7.25 10.836 7.586 10.5 8 10.5C8.414 10.5 8.75 10.836 8.75 11.25ZM7.5 9V5.5C7.5 5.224 7.724 5 8 5C8.276 5 8.5 5.224 8.5 5.5V9C8.5 9.276 8.276 9.5 8 9.5C7.724 9.5 7.5 9.276 7.5 9Z"></path></svg>';
    const disconnectedIconSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 2.5C7 2.224 7.224 2 7.5 2C7.776 2 8 2.224 8 2.5V7.5C8 7.776 7.776 8 7.5 8C7.224 8 7 7.776 7 7.5V2.5ZM7.5 11.5C7.086 11.5 6.75 11.164 6.75 10.75C6.75 10.336 7.086 10 7.5 10C7.914 10 8.25 10.336 8.25 10.75C8.25 11.164 7.914 11.5 7.5 11.5ZM12.884 13.591L11.586 12.293C10.506 13.345 9.03 14 7.4 14C4.093 14 1.4 11.309 1.4 8C1.4 5.316 3.172 3.041 5.607 2.284C5.871 2.202 6.149 2.35 6.231 2.613C6.313 2.877 6.165 3.155 5.902 3.237C3.874 3.867 2.4 5.762 2.4 8C2.4 10.758 4.643 13 7.4 13C8.753 13 9.979 12.46 10.88 11.586L9.62 10.326C9.425 10.131 9.425 9.815 9.62 9.62C9.815 9.425 10.131 9.425 10.326 9.62L13.591 12.884C13.786 13.079 13.786 13.395 13.591 13.59C13.396 13.786 13.079 13.786 12.884 13.591Z"></path></svg>';

    const statusHtml = (row) => {
      if (row.status === status.resolving) {
        return '<span class="status-wrap"><span class="spinner"></span><span class="secondary-text">Fetching ID...</span></span>';
      }
      if (row.status === status.connecting) {
        return '<span class="status-wrap"><span class="spinner"></span><span>Connecting...</span></span>';
      }
      if (row.status === status.connected) {
        return '<span class="status-wrap ok"><span class="icon">' + passIconSvg + '</span><span>Connected</span></span>';
      }
      if (row.status === status.error) {
        const errText = row.errorText ? ' - ' + row.errorText : '';
        return '<span class="status-wrap err"><span class="icon">' + warningIconSvg + '</span><span>Error' + errText + '</span></span>';
      }
      if (row.status === status.notConnected) {
        return '<span class="status-wrap secondary-text"><span class="icon">' + disconnectedIconSvg + '</span><span>Not connected</span></span>';
      }
      return '<button type="button" class="link" data-action="connect" data-id="' + row.id + '">Connect</button>';
    };

    const render = () => {
      tbody.innerHTML = '';
      for (const row of rows) {
        const nameHtml = row.deviceName
          ? row.deviceName
          : ('<button type="button" class="link" data-action="set-name" data-id="' + row.id + '">Set device name</button>');
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="name">' + nameHtml + '</td>' +
          '<td class="id">' + (row.deviceId || '') + '</td>' +
          '<td class="port">' + (row.serialPortName || '') + '</td>' +
          '<td class="deviceInfo">' + (row.deviceInfo || '') + '</td>' +
          '<td class="status">' + statusHtml(row) + '</td>';
        tbody.appendChild(tr);
      }
      for (const button of document.querySelectorAll('button[data-action="connect"]')) {
        button.addEventListener('click', () => {
          vscode.postMessage({ type: 'connect', rowId: button.dataset.id });
        });
      }
      for (const button of document.querySelectorAll('button[data-action="set-name"]')) {
        button.addEventListener('click', () => {
          vscode.postMessage({ type: 'setName', rowId: button.dataset.id });
        });
      }
    };

    render();

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object') {
        return;
      }
      if (message.type === 'updateRow' && message.row && typeof message.row.id === 'string') {
        const index = rows.findIndex((item) => item.id === message.row.id);
        if (index >= 0) {
          rows[index] = message.row;
        } else {
          rows.push(message.row);
        }
        render();
        return;
      }
      if (message.type === 'replaceRows' && Array.isArray(message.rows)) {
        rows.splice(0, rows.length, ...message.rows);
        render();
      }
    });

    document.getElementById('connectAll').addEventListener('click', () => {
      vscode.postMessage({ type: 'connectAll' });
    });
    document.getElementById('close').addEventListener('click', () => {
      vscode.postMessage({ type: 'close' });
    });
  </script>
</body>
</html>`;
};
