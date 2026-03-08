    const vscode = acquireVsCodeApi();
    const initialStateElement = document.getElementById('initial-state');
    let initialState = {};
    try {
      initialState = initialStateElement ? JSON.parse(initialStateElement.textContent || '{}') : {};
    } catch {
      initialState = {};
    }
    const rows = Array.isArray(initialState.rows) ? initialState.rows : [];
    const status = initialState.statusMap && typeof initialState.statusMap === 'object'
      ? initialState.statusMap
      : {};
    const connectTimeoutMs = typeof initialState.connectAttemptTimeoutMs === 'number'
      ? initialState.connectAttemptTimeoutMs
      : 0;
    const i18n = initialState.i18n && typeof initialState.i18n === 'object' ? initialState.i18n : {};
    const msg = (key, fallback) => (typeof i18n[key] === 'string' ? i18n[key] : fallback);
    const unconnectedTbody = document.getElementById('unconnectedRows');
    const connectedTbody = document.getElementById('connectedRows');
    const connectAllButton = document.getElementById('connectAll');
    const disconnectAllButton = document.getElementById('disconnectAll');
    const probeDevicesButton = document.getElementById('probeDevices');
    const closeButton = document.getElementById('close');
    const probeModal = document.getElementById('probeModal');
    const probeTitle = document.getElementById('probeTitle');
    const probeStatus = document.getElementById('probeStatus');
    const probeProgressBar = document.getElementById('probeProgressBar');
    const cancelProbeButton = document.getElementById('cancelProbe');
    const connectingSinceById = new Map();
    let isBusy = false;
    let probeModalState = 'hidden';
    let modalOperation = 'probe';
    const passIconSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6484 5.64648C10.8434 5.45148 11.1605 5.45148 11.3555 5.64648C11.5498 5.84137 11.5499 6.15766 11.3555 6.35254L7.35547 10.3525C7.25747 10.4495 7.12898 10.499 7.00098 10.499C6.87299 10.499 6.74545 10.4505 6.64746 10.3525L4.64746 8.35254C4.45247 8.15754 4.45248 7.84148 4.64746 7.64648C4.84246 7.45148 5.15949 7.45148 5.35449 7.64648L7 9.29199L10.6465 5.64648H10.6484Z"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M8 1C11.86 1 15 4.14 15 8C15 11.86 11.86 15 8 15C4.14 15 1 11.86 1 8C1 4.14 4.14 1 8 1ZM8 2C4.691 2 2 4.691 2 8C2 11.309 4.691 14 8 14C11.309 14 14 11.309 14 8C14 4.691 11.309 2 8 2Z"></path></svg>';
    const warningIconSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.831 11.965L9.206 1.714C8.965 1.274 8.503 1 8 1C7.497 1 7.035 1.274 6.794 1.714L1.169 11.965C1.059 12.167 1 12.395 1 12.625C1 13.383 1.617 14 2.375 14H13.625C14.383 14 15 13.383 15 12.625C15 12.395 14.941 12.167 14.831 11.965ZM13.625 13H2.375C2.168 13 2 12.832 2 12.625C2 12.561 2.016 12.5 2.046 12.445L7.671 2.195C7.736 2.075 7.863 2 8 2C8.137 2 8.264 2.075 8.329 2.195L13.954 12.445C13.984 12.501 14 12.561 14 12.625C14 12.832 13.832 13 13.625 13ZM8.75 11.25C8.75 11.664 8.414 12 8 12C7.586 12 7.25 11.664 7.25 11.25C7.25 10.836 7.586 10.5 8 10.5C8.414 10.5 8.75 10.836 8.75 11.25ZM7.5 9V5.5C7.5 5.224 7.724 5 8 5C8.276 5 8.5 5.224 8.5 5.5V9C8.5 9.276 8.276 9.5 8 9.5C7.724 9.5 7.5 9.276 7.5 9Z"></path></svg>';
    const disconnectedIconSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 2.5C7 2.224 7.224 2 7.5 2C7.776 2 8 2.224 8 2.5V7.5C8 7.776 7.776 8 7.5 8C7.224 8 7 7.776 7 7.5V2.5ZM7.5 11.5C7.086 11.5 6.75 11.164 6.75 10.75C6.75 10.336 7.086 10 7.5 10C7.914 10 8.25 10.336 8.25 10.75C8.25 11.164 7.914 11.5 7.5 11.5ZM12.884 13.591L11.586 12.293C10.506 13.345 9.03 14 7.4 14C4.093 14 1.4 11.309 1.4 8C1.4 5.316 3.172 3.041 5.607 2.284C5.871 2.202 6.149 2.35 6.231 2.613C6.313 2.877 6.165 3.155 5.902 3.237C3.874 3.867 2.4 5.762 2.4 8C2.4 10.758 4.643 13 7.4 13C8.753 13 9.979 12.46 10.88 11.586L9.62 10.326C9.425 10.131 9.425 9.815 9.62 9.62C9.815 9.425 10.131 9.425 10.326 9.62L13.591 12.884C13.786 13.079 13.786 13.395 13.591 13.59C13.396 13.786 13.079 13.786 12.884 13.591Z"></path></svg>';
    const isConnectedRow = (row) => row.status === status.connected;
    const isDeviceRow = (row) => row.section === 'device' || isConnectedRow(row);
    const applyControlState = () => {
      for (const button of document.querySelectorAll('button[data-action]')) {
        button.disabled = isBusy;
      }
      const hasConnectableRows = rows.some((row) =>
        row.devicePath
        && (row.status === status.ready || row.status === status.error)
      );
      const hasConnectedRows = rows.some((row) => row.status === status.connected);
      connectAllButton.disabled = isBusy || !hasConnectableRows;
      disconnectAllButton.disabled = isBusy || !hasConnectedRows;
      probeDevicesButton.disabled = isBusy;
      closeButton.disabled = isBusy;
    };

    const operationTitle = (operation) => {
      if (operation === 'connectAll') {
        return msg('connectingDevices', 'Connecting devices');
      }
      if (operation === 'disconnectAll') {
        return msg('disconnectingDevices', 'Disconnecting devices');
      }
      return msg('probingDevices', 'Probing devices');
    };

    const updateProbeModal = (nextState, message, current, total, operation) => {
      if (typeof operation === 'string' && operation.length > 0) {
        modalOperation = operation;
      }
      probeModalState = nextState;
      if (nextState === 'hidden') {
        probeModal.classList.add('hidden');
        return;
      }
      probeModal.classList.remove('hidden');
      probeTitle.textContent = operationTitle(modalOperation);
      probeStatus.textContent = message || (nextState === 'cancelling'
        ? msg('cancelling', 'Cancelling...')
        : msg('probingDevices', 'Probing devices'));
      const ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
      probeProgressBar.style.width = (ratio * 100) + '%';
      if (nextState === 'cancelling') {
        cancelProbeButton.disabled = true;
        cancelProbeButton.textContent = msg('cancelling', 'Cancelling...');
      } else {
        cancelProbeButton.disabled = false;
        cancelProbeButton.textContent = msg('cancel', 'Cancel');
      }
    };

    const statusHtml = (row) => {
      if (row.status === status.connecting) {
        const startedAt = connectingSinceById.get(row.id);
        const remainingMs = typeof startedAt === 'number'
          ? Math.max(0, connectTimeoutMs - (Date.now() - startedAt))
          : connectTimeoutMs;
        const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
        return '<span class="status-wrap"><span class="spinner"></span><span>'
          + msg('connectingWithSeconds', 'Connecting... ({0}s)').replace('{0}', String(remainingSeconds))
          + '</span></span>';
      }
      if (row.status === status.connected) {
        return '<span class="status-actions">'
          + '<span class="status-wrap ok"><span class="icon">' + passIconSvg + '</span><span>' + msg('connected', 'Connected') + '</span></span>'
          + '<button type="button" class="link" data-action="disconnect" data-id="' + row.id + '">' + msg('disconnect', 'Disconnect') + '</button>'
          + '</span>';
      }
      if (row.status === status.error) {
        const errText = row.errorText ? ' - ' + row.errorText : '';
        return '<span class="status-actions">'
          + '<span class="status-wrap err"><span class="icon">' + warningIconSvg + '</span><span>' + msg('error', 'Error') + errText + '</span></span>'
          + '<button type="button" class="link" data-action="connect" data-id="' + row.id + '">' + msg('retry', 'Retry') + '</button>'
          + '</span>';
      }
      if (row.status === status.notConnected) {
        const notConnectedText = row.errorText || msg('notConnected', 'Not connected');
        return '<span class="status-wrap secondary-text"><span class="icon">' + disconnectedIconSvg + '</span><span>' + notConnectedText + '</span></span>';
      }
      return '<button type="button" class="link" data-action="connect" data-id="' + row.id + '">' + msg('connect', 'Connect') + '</button>';
    };

    const syncConnectingTimers = (incomingRows) => {
      const now = Date.now();
      const activeIds = new Set();
      for (const row of incomingRows) {
        if (row.status !== status.connecting) {
          continue;
        }
        activeIds.add(row.id);
        if (!connectingSinceById.has(row.id)) {
          connectingSinceById.set(row.id, now);
        }
      }
      for (const key of [...connectingSinceById.keys()]) {
        if (!activeIds.has(key)) {
          connectingSinceById.delete(key);
        }
      }
    };

    const sameRow = (a, b) => (
      a.id === b.id
      && a.devicePath === b.devicePath
      && a.serialPortName === b.serialPortName
      && a.deviceId === b.deviceId
      && a.deviceName === b.deviceName
      && (a.section || '') === (b.section || '')
      && a.status === b.status
      && (a.errorText || '') === (b.errorText || '')
      && (a.deviceInfo || '') === (b.deviceInfo || '')
      && (a.details || '') === (b.details || '')
    );

    const sameRows = (a, b) => {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        return false;
      }
      for (let i = 0; i < a.length; i += 1) {
        if (!sameRow(a[i], b[i])) {
          return false;
        }
      }
      return true;
    };

    const render = () => {
      syncConnectingTimers(rows);
      unconnectedTbody.innerHTML = '';
      connectedTbody.innerHTML = '';
      for (const row of rows) {
        const tr = document.createElement('tr');
        if (isDeviceRow(row)) {
          const nameHtml = row.deviceName
            ? row.deviceName
            : (isConnectedRow(row)
              ? ('<button type="button" class="link" data-action="set-name" data-id="' + row.id + '">' + msg('setDeviceName', 'Set device name') + '</button>')
              : '');
          tr.innerHTML =
            '<td class="name">' + nameHtml + '</td>' +
            '<td class="id">' + (row.deviceId || '') + '</td>' +
            '<td class="port">' + (row.serialPortName || '') + '</td>' +
            '<td class="deviceInfo">' + (row.deviceInfo || '') + '</td>' +
            '<td class="status" data-row-id="' + row.id + '">' + statusHtml(row) + '</td>';
          connectedTbody.appendChild(tr);
        } else {
          tr.innerHTML =
            '<td class="unconnectedPort">' + (row.serialPortName || '') + '</td>' +
            '<td class="unconnectedStatus status" data-row-id="' + row.id + '">' + statusHtml(row) + '</td>';
          unconnectedTbody.appendChild(tr);
        }
      }
      for (const button of document.querySelectorAll('button[data-action="connect"]')) {
        button.addEventListener('click', () => {
          if (isBusy) {
            return;
          }
          vscode.postMessage({ type: 'connect', rowId: button.dataset.id });
        });
      }
      for (const button of document.querySelectorAll('button[data-action="set-name"]')) {
        button.addEventListener('click', () => {
          if (isBusy) {
            return;
          }
          vscode.postMessage({ type: 'setName', rowId: button.dataset.id });
        });
      }
      for (const button of document.querySelectorAll('button[data-action="disconnect"]')) {
        button.addEventListener('click', () => {
          if (isBusy) {
            return;
          }
          vscode.postMessage({ type: 'disconnect', rowId: button.dataset.id });
        });
      }
      applyControlState();
    };

    const refreshConnectingCountdowns = () => {
      const connectingRows = rows.filter((row) => row.status === status.connecting);
      if (connectingRows.length === 0) {
        return;
      }
      syncConnectingTimers(rows);
      for (const row of connectingRows) {
        const cell = unconnectedTbody.querySelector('td.status[data-row-id="' + row.id + '"]');
        if (cell) {
          cell.innerHTML = statusHtml(row);
        }
      }
    };

    render();
    setInterval(refreshConnectingCountdowns, 1000);

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object') {
        return;
      }
      if (message.type === 'updateRow' && message.row && typeof message.row.id === 'string') {
        const index = rows.findIndex((item) => item.id === message.row.id);
        if (index >= 0) {
          if (sameRow(rows[index], message.row)) {
            return;
          }
          rows[index] = message.row;
        } else {
          rows.push(message.row);
        }
        render();
        return;
      }
      if (message.type === 'replaceRows' && Array.isArray(message.rows)) {
        if (sameRows(rows, message.rows)) {
          return;
        }
        rows.splice(0, rows.length, ...message.rows);
        render();
        return;
      }
      if (message.type === 'setBusy' && typeof message.busy === 'boolean') {
        isBusy = message.busy;
        applyControlState();
        return;
      }
      if (message.type === 'probeStatus' && typeof message.state === 'string') {
        updateProbeModal(
          message.state,
          typeof message.message === 'string' ? message.message : '',
          typeof message.current === 'number' ? message.current : 0,
          typeof message.total === 'number' ? message.total : 0,
          'probe'
        );
        return;
      }
      if (message.type === 'bulkStatus' && typeof message.state === 'string' && typeof message.operation === 'string') {
        updateProbeModal(
          message.state,
          typeof message.message === 'string' ? message.message : '',
          typeof message.current === 'number' ? message.current : 0,
          typeof message.total === 'number' ? message.total : 0,
          message.operation
        );
      }
    });

    connectAllButton.addEventListener('click', () => {
      if (isBusy) {
        return;
      }
      vscode.postMessage({ type: 'connectAll' });
    });
    probeDevicesButton.addEventListener('click', () => {
      if (isBusy) {
        return;
      }
      vscode.postMessage({ type: 'probeDevices' });
    });
    disconnectAllButton.addEventListener('click', () => {
      if (isBusy) {
        return;
      }
      vscode.postMessage({ type: 'disconnectAll' });
    });
    cancelProbeButton.addEventListener('click', () => {
      if (probeModalState !== 'running') {
        return;
      }
      updateProbeModal('cancelling', 'Cancelling...', 0, 0);
      if (modalOperation === 'probe') {
        vscode.postMessage({ type: 'cancelProbe' });
        return;
      }
      vscode.postMessage({ type: 'cancelBulk' });
    });
    closeButton.addEventListener('click', () => {
      if (isBusy) {
        return;
      }
      vscode.postMessage({ type: 'close' });
    });
