    const vscode = acquireVsCodeApi();
    const initialStateElement = document.getElementById('initial-state');
    let initialState = {};
    try {
      initialState = initialStateElement ? JSON.parse(initialStateElement.textContent || '{}') : {};
    } catch {
      initialState = {};
    }
    const i18n = initialState.i18n && typeof initialState.i18n === 'object' ? initialState.i18n : {};
    const msg = (key, fallback) => (typeof i18n[key] === 'string' ? i18n[key] : fallback);
    let currentState = { devices: [], activeDeviceId: undefined };

    const tabsEl = document.getElementById('tabs');
    const contentEl = document.getElementById('content');
    const outputEl = document.getElementById('output');
    const promptRowEl = document.getElementById('promptRow');
    const inputEl = document.getElementById('commandInput');
    const busyIndicatorEl = document.getElementById('busyIndicator');
    const ctrlCButtonEl = document.getElementById('ctrlCButton');
    const ctrlDButtonEl = document.getElementById('ctrlDButton');
    const ctrlEButtonEl = document.getElementById('ctrlEButton');
    const reopenPortButtonEl = document.getElementById('reopenPortButton');
    const historyCursorByDevice = new Map();
    const historyDraftByDevice = new Map();
    const pendingEchoByDevice = new Map();
    let deferredState;

    const getActiveDevice = () => currentState.devices.find((item) => item.deviceId === currentState.activeDeviceId);

    const renderReopenPortButton = (active) => {
      if (!active) {
        reopenPortButtonEl.textContent = msg('reopenPort', 'Reopen Port');
        return;
      }

      const portLabel = active.portLabel || active.devicePath || msg('portLabelFallback', 'Port');
      if (active.isPortRestarting) {
        reopenPortButtonEl.innerHTML = '<span class="spinner"></span> '
          + msg('reopeningPortNamed', 'Reopening {0}...').replace('{0}', portLabel);
        return;
      }

      reopenPortButtonEl.textContent = msg('reopenPortNamed', 'Reopen {0}').replace('{0}', portLabel);
    };

    const resetHistoryCursor = (deviceId, nextLength) => {
      const active = currentState.devices.find((item) => item.deviceId === deviceId);
      const length = typeof nextLength === 'number' ? nextLength : (active?.history?.length ?? 0);
      historyCursorByDevice.set(deviceId, length);
      historyDraftByDevice.set(deviceId, '');
    };

    const navigateHistory = (direction) => {
      const active = getActiveDevice();
      if (!active) {
        return;
      }

      const history = Array.isArray(active.history) ? active.history : [];
      if (history.length === 0) {
        return;
      }

      const deviceId = active.deviceId;
      if (!historyCursorByDevice.has(deviceId)) {
        historyCursorByDevice.set(deviceId, history.length);
      }
      if (!historyDraftByDevice.has(deviceId)) {
        historyDraftByDevice.set(deviceId, inputEl.value);
      }

      let nextCursor = historyCursorByDevice.get(deviceId);
      if (direction < 0) {
        nextCursor = Math.max(0, nextCursor - 1);
      } else {
        nextCursor = Math.min(history.length, nextCursor + 1);
      }
      historyCursorByDevice.set(deviceId, nextCursor);

      if (nextCursor === history.length) {
        inputEl.value = historyDraftByDevice.get(deviceId) ?? '';
        return;
      }

      inputEl.value = history[nextCursor] ?? '';
    };

    const getRenderLines = (active) => {
      const lines = Array.isArray(active?.lines) ? [...active.lines] : [];
      const pending = pendingEchoByDevice.get(active?.deviceId);
      if (typeof pending === 'string' && pending.length > 0) {
        lines.push('>>> ' + pending);
      }
      return lines;
    };

    const hasActiveSelectionInConsole = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return false;
      }
      const anchor = selection.getRangeAt(0).commonAncestorContainer;
      return contentEl.contains(anchor);
    };

    const applyState = (nextState) => {
      currentState = nextState;
      if (!currentState.activeDeviceId && currentState.devices.length > 0) {
        currentState.activeDeviceId = currentState.devices[0].deviceId;
      }
      for (const device of currentState.devices) {
        const pending = pendingEchoByDevice.get(device.deviceId);
        if (typeof pending !== 'string' || pending.length === 0) {
          continue;
        }
        const commandLine = '>>> ' + pending;
        if (Array.isArray(device.lines) && device.lines.includes(commandLine)) {
          pendingEchoByDevice.delete(device.deviceId);
        }
      }
      const active = getActiveDevice();
      if (active) {
        const cursor = historyCursorByDevice.get(active.deviceId);
        const maxCursor = active.history.length;
        if (typeof cursor === 'number' && cursor > maxCursor) {
          historyCursorByDevice.set(active.deviceId, maxCursor);
        }
      }
      render();
    };

    const render = () => {
      tabsEl.innerHTML = '';
      if (currentState.devices.length === 0) {
        outputEl.textContent = msg('noConnectedDevices', 'No connected devices.');
        promptRowEl.classList.add('disabled');
        inputEl.disabled = true;
        busyIndicatorEl.classList.add('hidden');
        ctrlCButtonEl.disabled = true;
        ctrlDButtonEl.disabled = true;
        ctrlEButtonEl.disabled = true;
        reopenPortButtonEl.disabled = true;
        renderReopenPortButton(undefined);
        if (!hasActiveSelectionInConsole()) {
          contentEl.scrollTop = contentEl.scrollHeight;
        }
        return;
      }

      promptRowEl.classList.remove('disabled');
      inputEl.disabled = false;
      ctrlCButtonEl.disabled = false;
      ctrlDButtonEl.disabled = false;
      ctrlEButtonEl.disabled = false;
      reopenPortButtonEl.disabled = false;

      for (const device of currentState.devices) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'tab ' + (device.deviceId === currentState.activeDeviceId ? 'active' : '');
        tab.addEventListener('click', () => {
          vscode.postMessage({ type: 'switchTab', deviceId: device.deviceId });
        });

        const title = document.createElement('span');
        title.className = 'tab-title';
        title.textContent = device.displayName || device.deviceId;
        title.title = (device.displayName || device.deviceId) + ' (' + device.devicePath + ')';
        tab.appendChild(title);

        tabsEl.appendChild(tab);
      }

      const active = getActiveDevice();
      if (!active) {
        outputEl.textContent = msg('noActiveDevice', 'No active device.');
        promptRowEl.classList.add('disabled');
        inputEl.disabled = true;
        busyIndicatorEl.classList.add('hidden');
        ctrlCButtonEl.disabled = true;
        ctrlDButtonEl.disabled = true;
        ctrlEButtonEl.disabled = true;
        reopenPortButtonEl.disabled = true;
        renderReopenPortButton(undefined);
        return;
      }

      const isBusy = !!active.isExecuting || !!active.isPortRestarting;
      const isRestarting = !!active.isPortRestarting;
      inputEl.disabled = isBusy;
      if (isBusy) {
        busyIndicatorEl.classList.remove('hidden');
      } else {
        busyIndicatorEl.classList.add('hidden');
      }
      ctrlCButtonEl.disabled = isRestarting;
      ctrlDButtonEl.disabled = isRestarting;
      ctrlEButtonEl.disabled = isRestarting;
      reopenPortButtonEl.disabled = isRestarting;
      renderReopenPortButton(active);

      outputEl.textContent = getRenderLines(active).join('\\n');
      if (!hasActiveSelectionInConsole()) {
        contentEl.scrollTop = contentEl.scrollHeight;
      }
      if (!isBusy && !hasActiveSelectionInConsole() && document.activeElement !== inputEl) {
        inputEl.focus();
      }
    };

    const submitCommand = () => {
      const active = getActiveDevice();
      if (!active) {
        return;
      }
      if (active.isExecuting || active.isPortRestarting) {
        return;
      }

      const command = inputEl.value;
      const cleanedCommand = command.replace(/\u0003/g, '');
      const trimmedCommand = cleanedCommand.trimEnd();
      if (trimmedCommand.length > 0) {
        pendingEchoByDevice.set(active.deviceId, trimmedCommand);
      }
      vscode.postMessage({ type: 'submit', deviceId: active.deviceId, command: cleanedCommand });
      inputEl.value = '';
      const submitted = trimmedCommand.length > 0;
      const expectedNextLength = (Array.isArray(active.history) ? active.history.length : 0) + (submitted ? 1 : 0);
      resetHistoryCursor(active.deviceId, expectedNextLength);
      render();
    };

    inputEl.addEventListener('input', () => {
      const active = getActiveDevice();
      if (!active) {
        return;
      }
      historyCursorByDevice.set(active.deviceId, active.history.length);
      historyDraftByDevice.set(active.deviceId, inputEl.value);
    });

    inputEl.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        // Preserve native copy behavior and prevent accidental Ctrl-C passthrough.
        event.stopPropagation();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        navigateHistory(-1);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        navigateHistory(1);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        submitCommand();
      }
    });

    window.addEventListener('keydown', (event) => {
      const active = getActiveDevice();
      if (!active) {
        return;
      }
      if (active.isExecuting || active.isPortRestarting) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        // Keep Ctrl-C available for copy in REPL output/input.
        return;
      }

      if (event.target === inputEl) {
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        submitCommand();
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        inputEl.focus();
        navigateHistory(-1);
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        inputEl.focus();
        navigateHistory(1);
        return;
      }

      if (event.key === 'Backspace') {
        event.preventDefault();
        inputEl.focus();
        inputEl.value = inputEl.value.slice(0, -1);
        return;
      }

      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        inputEl.focus();
        inputEl.value += event.key;
      }
    });

    const sendControl = (control) => {
      const active = getActiveDevice();
      if (!active) {
        return;
      }
      vscode.postMessage({ type: 'sendControl', deviceId: active.deviceId, control });
    };

    ctrlCButtonEl.addEventListener('click', () => sendControl('interrupt'));
    ctrlDButtonEl.addEventListener('click', () => sendControl('softReset'));
    ctrlEButtonEl.addEventListener('click', () => sendControl('pasteMode'));
    reopenPortButtonEl.addEventListener('click', () => {
      const active = getActiveDevice();
      if (!active || active.isPortRestarting) {
        return;
      }
      vscode.postMessage({ type: 'reopenPort', deviceId: active.deviceId });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'state') {
        if (hasActiveSelectionInConsole()) {
          deferredState = message.value;
          return;
        }
        applyState(message.value);
      }
    });

    document.addEventListener('selectionchange', () => {
      if (!deferredState || hasActiveSelectionInConsole()) {
        return;
      }
      const nextState = deferredState;
      deferredState = undefined;
      applyState(nextState);
    });
