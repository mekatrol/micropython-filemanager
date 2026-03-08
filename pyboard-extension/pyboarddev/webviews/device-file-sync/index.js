    const vscode = acquireVsCodeApi();
    const initialStateElement = document.getElementById('initial-state');
    let initialState = {};
    try {
      initialState = initialStateElement ? JSON.parse(initialStateElement.textContent || '{}') : {};
    } catch {
      initialState = {};
    }
    let rows = Array.isArray(initialState.rows) ? initialState.rows : [];
    const tbody = document.getElementById('rows');
    const labels = {
      match: {
        text: 'Files match',
        iconSvg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6484 5.64648C10.8434 5.45148 11.1605 5.45148 11.3555 5.64648C11.5498 5.84137 11.5499 6.15766 11.3555 6.35254L7.35547 10.3525C7.25747 10.4495 7.12898 10.499 7.00098 10.499C6.87299 10.499 6.74545 10.4505 6.64746 10.3525L4.64746 8.35254C4.45247 8.15754 4.45248 7.84148 4.64746 7.64648C4.84246 7.45148 5.15949 7.45148 5.35449 7.64648L7 9.29199L10.6465 5.64648H10.6484Z"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M8 1C11.86 1 15 4.14 15 8C15 11.86 11.86 15 8 15C4.14 15 1 11.86 1 8C1 4.14 4.14 1 8 1ZM8 2C4.691 2 2 4.691 2 8C2 11.309 4.691 14 8 14C11.309 14 14 11.309 14 8C14 4.691 11.309 2 8 2Z"></path></svg>'
      },
      mismatch: {
        text: 'Files differ',
        iconSvg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 2H2.5C1.673 2 1 2.673 1 3.5V12.5C1 13.327 1.673 14 2.5 14H5.5C6.327 14 7 13.327 7 12.5V3.5C7 2.673 6.327 2 5.5 2ZM2.5 3H5.5C5.775 3 6 3.224 6 3.5V5H2V3.5C2 3.224 2.225 3 2.5 3ZM5.5 13H2.5C2.225 13 2 12.776 2 12.5V6H6V12.5C6 12.776 5.775 13 5.5 13ZM13.5 2H10.5C9.673 2 9 2.673 9 3.5V12.5C9 13.327 9.673 14 10.5 14H13.5C14.327 14 15 13.327 15 12.5V3.5C15 2.673 14.327 2 13.5 2ZM10.5 3H13.5C13.775 3 14 3.224 14 3.5V8H10V3.5C10 3.224 10.225 3 10.5 3ZM13.5 13H10.5C10.225 13 10 12.776 10 12.5V10H14V12.5C14 12.776 13.775 13 13.5 13Z"></path></svg>'
      },
      missing_computer: {
        text: 'Missing on computer',
        iconSvg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.831 11.965L9.206 1.714C8.965 1.274 8.503 1 8 1C7.497 1 7.035 1.274 6.794 1.714L1.169 11.965C1.059 12.167 1 12.395 1 12.625C1 13.383 1.617 14 2.375 14H13.625C14.383 14 15 13.383 15 12.625C15 12.395 14.941 12.167 14.831 11.965ZM13.625 13H2.375C2.168 13 2 12.832 2 12.625C2 12.561 2.016 12.5 2.046 12.445L7.671 2.195C7.736 2.075 7.863 2 8 2C8.137 2 8.264 2.075 8.329 2.195L13.954 12.445C13.984 12.501 14 12.561 14 12.625C14 12.832 13.832 13 13.625 13ZM8.75 11.25C8.75 11.664 8.414 12 8 12C7.586 12 7.25 11.664 7.25 11.25C7.25 10.836 7.586 10.5 8 10.5C8.414 10.5 8.75 10.836 8.75 11.25ZM7.5 9V5.5C7.5 5.224 7.724 5 8 5C8.276 5 8.5 5.224 8.5 5.5V9C8.5 9.276 8.276 9.5 8 9.5C7.724 9.5 7.5 9.276 7.5 9Z"></path></svg>'
      },
      missing_device: {
        text: 'Missing on device',
        iconSvg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.831 11.965L9.206 1.714C8.965 1.274 8.503 1 8 1C7.497 1 7.035 1.274 6.794 1.714L1.169 11.965C1.059 12.167 1 12.395 1 12.625C1 13.383 1.617 14 2.375 14H13.625C14.383 14 15 13.383 15 12.625C15 12.395 14.941 12.167 14.831 11.965ZM13.625 13H2.375C2.168 13 2 12.832 2 12.625C2 12.561 2.016 12.5 2.046 12.445L7.671 2.195C7.736 2.075 7.863 2 8 2C8.137 2 8.264 2.075 8.329 2.195L13.954 12.445C13.984 12.501 14 12.561 14 12.625C14 12.832 13.832 13 13.625 13ZM8.75 11.25C8.75 11.664 8.414 12 8 12C7.586 12 7.25 11.664 7.25 11.25C7.25 10.836 7.586 10.5 8 10.5C8.414 10.5 8.75 10.836 8.75 11.25ZM7.5 9V5.5C7.5 5.224 7.724 5 8 5C8.276 5 8.5 5.224 8.5 5.5V9C8.5 9.276 8.276 9.5 8 9.5C7.724 9.5 7.5 9.276 7.5 9Z"></path></svg>'
      }
    };
    const libraryIconSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 3.24941C1 2.55938 1.55917 2 2.24895 2H2.74852C3.4383 2 3.99747 2.55938 3.99747 3.24941V12.745C3.99747 13.435 3.4383 13.9944 2.74852 13.9944H2.24895C1.55917 13.9944 1 13.435 1 12.745V3.24941ZM2.24895 2.99953C2.11099 2.99953 1.99916 3.11141 1.99916 3.24941V12.745C1.99916 12.883 2.11099 12.9948 2.24895 12.9948H2.74852C2.88648 12.9948 2.99831 12.883 2.99831 12.745V3.24941C2.99831 3.11141 2.88648 2.99953 2.74852 2.99953H2.24895ZM4.99663 3.24941C4.99663 2.55938 5.5558 2 6.24557 2H6.74515C7.43492 2 7.9941 2.55938 7.9941 3.24941V12.745C7.9941 13.435 7.43492 13.9944 6.74515 13.9944H6.24557C5.5558 13.9944 4.99663 13.435 4.99663 12.745V3.24941ZM6.24557 2.99953C6.10762 2.99953 5.99578 3.11141 5.99578 3.24941V12.745C5.99578 12.883 6.10762 12.9948 6.24557 12.9948H6.74515C6.88311 12.9948 6.99494 12.883 6.99494 12.745V3.24941C6.99494 3.11141 6.88311 2.99953 6.74515 2.99953H6.24557ZM11.9723 4.77682C11.7231 4.15733 11.0311 3.84331 10.4011 4.06385L9.81888 4.26764C9.14658 4.50297 8.80684 5.25222 9.07268 5.91326L12.0098 13.2166C12.2589 13.8361 12.9509 14.1502 13.581 13.9296L14.1632 13.7258C14.8355 13.4904 15.1752 12.7412 14.9093 12.0802L11.9723 4.77682ZM10.7311 5.00729C10.8571 4.96318 10.9955 5.02598 11.0453 5.14988L13.9824 12.4532C14.0356 12.5854 13.9676 12.7353 13.8332 12.7823L13.251 12.9862C13.1249 13.0303 12.9865 12.9675 12.9367 12.8436L9.99964 5.5402C9.94647 5.40799 10.0144 5.25815 10.1489 5.21108L10.7311 5.00729Z"></path></svg>';
    const folderIconSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 3h3.6c.26 0 .51.1.7.28l1.1 1.06c.19.18.44.28.7.28h6.4A1.75 1.75 0 0 1 16 6.38v5.87A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25V4.75A1.75 1.75 0 0 1 1.75 3Z"></path></svg>';

    const syncToDeviceButton = document.getElementById('syncToDevice');
    const syncFromDeviceButton = document.getElementById('syncFromDevice');

    const renderRows = (nextRows) => {
      tbody.textContent = '';
      if (nextRows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.className = 'empty';
        td.textContent = 'No files to sync';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      for (const row of nextRows) {
        const tr = document.createElement('tr');

        const pathTd = document.createElement('td');
        pathTd.className = 'path';
        pathTd.textContent = row.deviceRelativePath;
        tr.appendChild(pathTd);

        const scopeTd = document.createElement('td');
        scopeTd.className = 'scope';
        const scopeWrap = document.createElement('span');
        scopeWrap.className = 'scope-wrap';
        const scopeIcon = document.createElement('span');
        scopeIcon.className = 'scope-icon';
        scopeIcon.innerHTML = row.scopeIcon === 'library' ? libraryIconSvg : folderIconSvg;
        const scopeText = document.createElement('span');
        scopeText.textContent = row.scopeLabel || '';
        scopeWrap.appendChild(scopeIcon);
        scopeWrap.appendChild(scopeText);
        scopeTd.appendChild(scopeWrap);
        tr.appendChild(scopeTd);

        const statusTd = document.createElement('td');
        statusTd.className = 'status status-' + row.status;
        const wrap = document.createElement('span');
        wrap.className = 'status-wrap';
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.innerHTML = labels[row.status].iconSvg;
        const text = document.createElement('span');
        text.textContent = labels[row.status].text;
        wrap.appendChild(icon);
        wrap.appendChild(text);
        statusTd.appendChild(wrap);
        tr.appendChild(statusTd);

        const actionTd = document.createElement('td');
        actionTd.className = 'action';
        if (!row.isDirectory && row.status === 'mismatch') {
          const action = document.createElement('button');
          action.type = 'button';
          action.className = 'link';
          action.textContent = 'Compare';
          action.addEventListener('click', () => {
            vscode.postMessage({ type: 'compare', rowId: row.id });
          });
          actionTd.appendChild(action);
        }
        tr.appendChild(actionTd);

        tbody.appendChild(tr);
      }
    };
    const setSyncButtonsVisibility = (visible) => {
      if (syncToDeviceButton) {
        syncToDeviceButton.style.display = visible ? 'inline-block' : 'none';
      }
      if (syncFromDeviceButton) {
        syncFromDeviceButton.style.display = visible ? 'inline-block' : 'none';
      }
    };
    renderRows(rows);
    const initialHasDifferences = typeof initialState.hasDifferences === 'boolean'
      ? initialState.hasDifferences
      : rows.some((row) => row.status !== 'match');
    setSyncButtonsVisibility(initialHasDifferences);

    if (syncToDeviceButton) {
      syncToDeviceButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'sync_to_device' });
      });
    }

    if (syncFromDeviceButton) {
      syncFromDeviceButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'sync_from_device' });
      });
    }

    document.getElementById('close').addEventListener('click', () => {
      vscode.postMessage({ type: 'close' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object') {
        return;
      }
      if (message.type === 'refresh_rows') {
        const nextRows = Array.isArray(message.rows) ? message.rows : [];
        rows = nextRows;
        renderRows(rows);
        if (typeof message.hasDifferences === 'boolean') {
          setSyncButtonsVisibility(message.hasDifferences);
        } else {
          setSyncButtonsVisibility(rows.some((row) => row.status !== 'match'));
        }
      }
    });
