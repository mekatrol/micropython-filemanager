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
    const toClass = (action) => action === 'create' ? 'action-create' : (action === 'modify' ? 'action-modify' : 'action-delete');
    const noteText = 'this path is configured to be excluded by default';

    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'empty';
      td.textContent = 'Nothing needs synchronisation';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const row of rows) {
        const tr = document.createElement('tr');
        tr.dataset.path = row.relativePath;

        const checkTd = document.createElement('td');
        checkTd.className = 'check';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!row.checked;
        checkbox.dataset.id = row.id;
        checkbox.dataset.path = row.relativePath;
        checkbox.dataset.dir = row.isDirectory ? 'true' : 'false';
        checkTd.appendChild(checkbox);
        tr.appendChild(checkTd);

        const actionTd = document.createElement('td');
        actionTd.className = 'action';
        const actionSpan = document.createElement('span');
        actionSpan.className = toClass(row.action);
        actionSpan.textContent = row.actionIcon;
        actionSpan.title = row.action;
        actionTd.appendChild(actionSpan);
        tr.appendChild(actionTd);

        const pathTd = document.createElement('td');
        pathTd.className = 'path';
        pathTd.textContent = row.relativePath;
        tr.appendChild(pathTd);

        const noteTd = document.createElement('td');
        noteTd.className = 'note';
        noteTd.textContent = row.excluded ? noteText : '';
        tr.appendChild(noteTd);

        const statusTd = document.createElement('td');
        statusTd.className = 'status status-pending';
        statusTd.textContent = row.checked ? 'pending' : 'skipped';
        statusTd.dataset.status = 'pending';
        statusTd.dataset.id = row.id;
        tr.appendChild(statusTd);

        const errorTd = document.createElement('td');
        errorTd.className = 'error';
        errorTd.textContent = '';
        errorTd.dataset.id = row.id;
        tr.appendChild(errorTd);

        tbody.appendChild(tr);
      }
    }

    const isDescendant = (child, parent) => parent && child.startsWith(parent + '/');
    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"][data-id]'));
    for (const checkbox of checkboxes) {
      checkbox.addEventListener('change', () => {
        if (checkbox.dataset.dir === 'true' && checkbox.checked === false) {
          const parentPath = checkbox.dataset.path || '';
          for (const other of checkboxes) {
            if (other === checkbox) continue;
            const childPath = other.dataset.path || '';
            if (isDescendant(childPath, parentPath)) {
              other.checked = false;
            }
          }
        }
        const id = checkbox.dataset.id;
        const statusCell = document.querySelector('td.status[data-id="' + id + '"]');
        if (statusCell) {
          statusCell.textContent = checkbox.checked ? 'pending' : 'skipped';
          statusCell.className = 'status ' + (checkbox.checked ? 'status-pending' : 'status-skipped');
        }
      });
    }

    document.getElementById('continue').addEventListener('click', () => {
      const selectedIds = checkboxes.filter((cb) => cb.checked).map((cb) => cb.dataset.id);
      vscode.postMessage({ type: 'continue', selectedIds });
    });

    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    document.getElementById('close').addEventListener('click', () => {
      vscode.postMessage({ type: 'close' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object') {
        return;
      }

      if (message.type === 'lock') {
        for (const checkbox of checkboxes) {
          checkbox.disabled = true;
        }
        document.getElementById('continue').disabled = true;
        document.getElementById('cancel').disabled = true;
      }

      if (message.type === 'update') {
        const statusCell = document.querySelector('td.status[data-id="' + message.id + '"]');
        const errorCell = document.querySelector('td.error[data-id="' + message.id + '"]');
        if (statusCell) {
          statusCell.textContent = message.status;
          statusCell.className = 'status status-' + message.status;
        }
        if (errorCell) {
          errorCell.textContent = message.errorText || '';
        }
      }

      if (message.type === 'finish') {
        const summary = document.getElementById('summary');
        summary.textContent = message.summary || '';
        summary.style.display = 'block';
        document.getElementById('continue').style.display = 'none';
        document.getElementById('cancel').style.display = 'none';
        document.getElementById('close').style.display = 'inline-block';
      }
    });
