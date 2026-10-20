'use strict';

const $ = function(elem) {
    return document.querySelector(elem);
};

const send = async function(action, args = []) {
    return await browser.runtime.sendMessage({ action: action, args: args });
};

const showTab = function(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`#tab-${name}`).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`a[href="#${name}"]`)?.parentElement.classList.add('active');
};

//--------------------------------------------------------------------------
// Settings
//--------------------------------------------------------------------------

const OPTION_FIELDS = {
    colorTheme: 'colorTheme',
    showLoginFormIcon: 'usernameIconsCheckBox',
    usePasswordGeneratorIcons: 'passwordIconsCheckBox',
    showOTPIcon: 'totpIconsCheckBox',
    autoFillSingleTotp: 'autoFillTotpCheckBox',
    showNotifications: 'notificationsCheckBox',
    useMonochromeToolbarIcon: 'monochromeCheckBox',
    autoFillSingleEntry: 'autoFillSingleCheckBox',
    autoCompleteUsernames: 'autocompleteCheckBox',
    autoSubmit: 'autoSubmitCheckBox',
    autoFillAndSend: 'autoFillAndSendCheckBox',
    showLoginNotifications: 'bannerCheckBox',
    useObserver: 'observerCheckBox'
};

const loadSettings = async function() {
    const response = await send('load_settings');
    if (!response) {
        return;
    }

    // Keep the native KeePassXC settings for content-script behavior
    const settings = response;

    for (const [ key, id ] of Object.entries(OPTION_FIELDS)) {
        const el = document.getElementById(id);
        if (el && settings[key] !== undefined) {
            el.checked = settings[key] === true || settings[key] === 'true';
        }
    }
    $('#colorTheme').value = settings.colorTheme || 'system';
    applyTheme($('#colorTheme').value);

    // Vault settings (from the vault manager)
    const vaultSettings = (await send('pwsave_get_settings')).data;
    if (vaultSettings) {
        $('#autoLockTimeout').value = String(vaultSettings.autoLockTimeout || 3600000);
        $('#genLength').value = vaultSettings.passwordGeneratorDefaults?.length || 20;
        $('#genSymbols').checked = vaultSettings.passwordGeneratorDefaults?.useSymbols !== false;
        $('#genNumbers').checked = vaultSettings.passwordGeneratorDefaults?.useNumbers !== false;
    }

    $('#genLength').addEventListener('change', saveVaultGeneratorSettings);
    $('#genSymbols').addEventListener('change', saveVaultGeneratorSettings);
    $('#genNumbers').addEventListener('change', saveVaultGeneratorSettings);

    // Wire the general settings listeners
    for (const [ key, id ] of Object.entries(OPTION_FIELDS)) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', async () => {
                settings[key] = el.checked;
                await send('save_settings', settings);
            });
        }
    }
    $('#colorTheme').addEventListener('change', async () => {
        settings.colorTheme = $('#colorTheme').value;
        applyTheme(settings.colorTheme);
        await send('save_settings', settings);
    });
    $('#autoLockTimeout').addEventListener('change', async () => {
        const timeout = Number($('#autoLockTimeout').value) || 3600000;
        await send('pwsave_update_settings', [ { autoLockTimeout: timeout } ]);
    });
};

const saveVaultGeneratorSettings = async function() {
    const length = Number($('#genLength').value) || 20;
    await send('pwsave_update_settings', [ {
        passwordGeneratorDefaults: {
            length,
            useUppercase: true,
            useLowercase: true,
            useNumbers: $('#genNumbers').checked,
            useSymbols: $('#genSymbols').checked,
            excludeAmbiguous: false,
            minDigits: 1,
            minSymbols: 1
        }
    } ]);
};

//--------------------------------------------------------------------------
// Vault
//--------------------------------------------------------------------------

const refreshVaultLockedState = async function() {
    const status = (await send('pwsave_get_status'));
    const locked = !status.unlocked;
    $('#vault-locked-alert').style.display = locked ? 'block' : 'none';
    $('#security-locked-alert').style.display = locked ? 'block' : 'none';
    $('#entries-locked-alert').style.display = locked ? 'block' : 'none';
    const disabled = locked;
    [ '#master-password-card', '#export-encrypted-button', '#export-csv-button',
        '#import-file', '#security-report-button', '#tab-entries' ].forEach(sel => {
        const el = $(sel);
        if (el) {
            el.style.opacity = disabled ? '0.5' : '1';
            el.style.pointerEvents = disabled ? 'none' : 'auto';
        }
    });
    return status;
};

const initVaultActions = function() {
    $('#change-password-button').addEventListener('click', async () => {
        const current = $('#change-current').value;
        const next = $('#change-new').value;
        const confirm = $('#change-confirm').value;
        const result = $('#change-password-result');

        if (!current || !next) {
            result.textContent = 'Please fill in both password fields.';
            result.className = 'small mt-2 text-danger';
            return;
        }
        if (next !== confirm) {
            result.textContent = 'New passwords do not match.';
            result.className = 'small mt-2 text-danger';
            return;
        }

        const response = await send('pwsave_change_master_password', [ current, next ]);
        if (response.success) {
            result.textContent = 'Master password changed.';
            result.className = 'small mt-2 text-success';
            $('#change-current').value = '';
            $('#change-new').value = '';
            $('#change-confirm').value = '';
        } else {
            result.textContent = response.error || 'Could not change password.';
            result.className = 'small mt-2 text-danger';
        }
    });

    $('#export-encrypted-button').addEventListener('click', async () => {
        const response = await send('pwsave_export_vault', [ 'encrypted' ]);
        if (!response.success) return;
        downloadFile(`pwsave-vault-${new Date().toISOString().slice(0, 10)}.json`, response.data, 'application/json');
    });

    $('#export-csv-button').addEventListener('click', async () => {
        const response = await send('pwsave_export_vault', [ 'csv' ]);
        if (!response.success) return;
        downloadFile(`pwsave-entries-${new Date().toISOString().slice(0, 10)}.csv`, response.data, 'text/csv');
    });

    $('#import-file').addEventListener('change', async () => {
        const file = $('#import-file').files[0];
        if (!file) return;
        const format = file.name.endsWith('.csv') ? 'csv' : 'json';
        const data = await file.text();
        const response = await send('pwsave_import_vault', [ format, data ]);
        const result = $('#import-result');
        if (response.success) {
            result.textContent = `Imported ${response.data} entries.`;
            result.className = 'small mt-1 text-success';
        } else {
            result.textContent = response.error || 'Import failed.';
            result.className = 'small mt-1 text-danger';
        }
    });
};

const downloadFile = function(name, content, mime) {
    const blob = new Blob([ content ], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

//--------------------------------------------------------------------------
// Drive Sync
//--------------------------------------------------------------------------

const refreshSyncStatus = async function() {
    const response = await send('pwsave_sync_get_status');
    const state = response.success ? response.data : null;
    const el = $('#sync-status');
    if (!state) {
        el.textContent = 'Unknown';
        return state;
    }
    if (state.connected) {
        el.innerHTML = `<span class="text-success"><i class="fa fa-check-circle" aria-hidden="true"></i> Connected${state.account ? ' as ' + state.account : ''}</span>`
            + (state.lastSyncedAt ? `<div class="small text-muted">Last synced: ${new Date(state.lastSyncedAt).toLocaleString()}</div>` : '');
    } else if (state.error) {
        el.innerHTML = `<span class="text-danger"><i class="fa fa-exclamation-circle" aria-hidden="true"></i> ${state.error}</span>`;
    } else {
        el.innerHTML = '<span class="text-muted">Not connected</span>';
    }
    return state;
};

const initSyncActions = function() {
    $('#sync-connect-button').addEventListener('click', async () => {
        const response = await send('pwsave_sync_setup');
        const result = $('#sync-action-result');
        if (response.success && response.data.connected) {
            result.textContent = 'Connected.';
            result.className = 'small mt-2 text-success';
        } else {
            result.textContent = 'Could not connect.';
            result.className = 'small mt-2 text-danger';
        }
        await refreshSyncStatus();
    });

    $('#sync-now-button').addEventListener('click', async () => {
        await send('pwsave_sync_now');
        await refreshSyncStatus();
    });

    $('#sync-disconnect-button').addEventListener('click', async () => {
        if (!window.confirm('Disconnect Google Drive sync?\n\nThis will lock and wipe the local vault (the Drive copy is kept and restored on next login).')) {
            return;
        }
        await send('pwsave_sync_disable');
        await refreshSyncStatus();
        await refreshVaultLockedState();
    });

    $('#sync-history-button').addEventListener('click', async () => {
        const response = await send('pwsave_sync_history');
        const list = $('#sync-history-list');
        list.innerHTML = '';
        if (!response.success) {
            list.innerHTML = `<div class="text-danger small">${response.error || 'Failed to load history'}</div>`;
            return;
        }
        if (response.data.length === 0) {
            list.innerHTML = '<div class="small text-muted">No history snapshots found.</div>';
            return;
        }
        for (const item of response.data) {
            const row = document.createElement('div');
            row.className = 'list-group-item d-flex justify-content-between align-items-center';
            const label = document.createElement('span');
            label.className = 'small';
            label.textContent = item.name.replace('pwsave-vault.history.', '').replace(/\.json$/, '');
            const restoreBtn = document.createElement('button');
            restoreBtn.className = 'btn btn-sm btn-outline-secondary';
            restoreBtn.textContent = 'Restore';
            restoreBtn.addEventListener('click', async () => {
                if (!window.confirm('Restore this snapshot? Your current local vault will be replaced.')) {
                    return;
                }
                const r = await send('pwsave_sync_restore', [ item.id ]);
                const msg = document.createElement('div');
                msg.className = 'small mt-2 ' + (r.success ? 'text-success' : 'text-danger');
                msg.textContent = r.success ? 'Restored.' : (r.error || 'Restore failed.');
                row.appendChild(msg);
            });
            row.append(label, restoreBtn);
            list.append(row);
        }
    });
};

//--------------------------------------------------------------------------
// Security
//--------------------------------------------------------------------------

const initSecurityActions = function() {
    $('#security-report-button').addEventListener('click', async () => {
        const response = await send('pwsave_get_security_report');
        const container = $('#security-report');
        if (!response.success) {
            container.innerHTML = `<div class="text-danger">${response.error || 'Failed to generate report'}</div>`;
            return;
        }
        const r = response.data;
        container.innerHTML = `
            <div class="row g-2">
              <div class="col-4"><div class="border rounded p-2 text-center"><div class="h4 mb-0">${r.overallScore}</div><div class="small text-muted">Score</div></div></div>
              <div class="col-4"><div class="border rounded p-2 text-center"><div class="h4 mb-0">${r.totalPasswords}</div><div class="small text-muted">Passwords</div></div></div>
              <div class="col-4"><div class="border rounded p-2 text-center"><div class="h4 mb-0">${r.uniqueCount}</div><div class="small text-muted">Unique</div></div></div>
              <div class="col-4"><div class="border rounded p-2 text-center"><div class="h4 mb-0 text-warning">${r.weakCount}</div><div class="small text-muted">Weak</div></div></div>
              <div class="col-4"><div class="border rounded p-2 text-center"><div class="h4 mb-0 text-warning">${r.reusedCount}</div><div class="small text-muted">Reused</div></div></div>
              <div class="col-4"><div class="border rounded p-2 text-center"><div class="h4 mb-0 text-danger">${r.compromisedCount}</div><div class="small text-muted">Compromised</div></div></div>
            </div>
        `;
    });
};

//--------------------------------------------------------------------------
// Entries
//--------------------------------------------------------------------------

const entriesState = {
    data: [],
    search: '',
    groupFilter: '',
    editingUuid: null,
    sort: { key: null, dir: 1 },
    selected: new Set(),
    totpOriginal: '',
    totpChangeRequested: false,
    totpRemoveRequested: false
};

const collectGroups = function() {
    const groups = new Set();
    for (const e of entriesState.data) {
        if (e.group) groups.add(e.group);
    }
    return Array.from(groups).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
};

const renderGroupFilter = function() {
    const select = $('#entry-group-filter');
    const groups = collectGroups();
    const current = entriesState.groupFilter;
    select.innerHTML = '<option value="">All groups</option>';
    for (const g of groups) {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = g;
        if (g === current) opt.selected = true;
        select.append(opt);
    }
};

const renderGroupOptions = function() {
    const datalist = $('#group-options');
    datalist.innerHTML = '';
    for (const g of collectGroups()) {
        const opt = document.createElement('option');
        opt.value = g;
        datalist.append(opt);
    }
};

const filteredEntries = function() {
    const q = entriesState.search.trim().toLowerCase();
    return entriesState.data.filter(e => {
        if (entriesState.groupFilter && e.group !== entriesState.groupFilter) return false;
        if (!q) return true;
        return (e.name || '').toLowerCase().includes(q)
            || (e.login || '').toLowerCase().includes(q)
            || (e.url || '').toLowerCase().includes(q)
            || (e.group || '').toLowerCase().includes(q);
    });
};

const refreshEntries = async function() {
    const status = await refreshVaultLockedState();
    const response = await send('pwsave_get_entries');
    entriesState.data = (response && response.success) ? response.data : [];
    renderGroupFilter();
    renderEntries();
    return status;
};

const sortEntries = function(entries) {
    const arr = entries.slice();
    const { key, dir } = entriesState.sort;
    if (!key) {
        arr.sort((a, b) => {
            const diff = (b.usageCount || 0) - (a.usageCount || 0);
            if (diff !== 0) return diff;
            return (b.lastUsedAt || b.updatedAt || 0) - (a.lastUsedAt || a.updatedAt || 0);
        });
        return arr;
    }
    arr.sort((a, b) => {
        const av = (a[key] || '');
        const bv = (b[key] || '');
        return dir * av.localeCompare(bv, undefined, { sensitivity: 'base' });
    });
    return arr;
};

const renderEntries = function() {
    const tbody = $('#entry-table-body');
    tbody.innerHTML = '';
    const list = sortEntries(filteredEntries());

    const selectedCount = entriesState.selected.size;
    const countEl = $('#entry-count');
    countEl.textContent = selectedCount > 0
        ? `${list.length} of ${entriesState.data.length} entries (${selectedCount} selected)`
        : `${list.length} of ${entriesState.data.length} entries`;

    $('#delete-selected-button').classList.toggle('d-none', selectedCount === 0);

    const selectAll = $('#entry-select-all');
    if (selectAll) {
        const visibleUuids = list.map(e => e.uuid);
        selectAll.checked = visibleUuids.length > 0 && visibleUuids.every(u => entriesState.selected.has(u));
        selectAll.indeterminate = !selectAll.checked && visibleUuids.some(u => entriesState.selected.has(u));
    }

    updateSortIcons();

    if (list.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="6" class="text-center text-muted py-3">No entries found.</td>';
        tbody.append(row);
        return;
    }

    for (const entry of list) {
        const tr = document.createElement('tr');
        tr.classList.toggle('table-active', entriesState.selected.has(entry.uuid));

        const checkTd = document.createElement('td');
        checkTd.className = 'entry-check-col';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'form-check-input entry-check';
        checkbox.checked = entriesState.selected.has(entry.uuid);
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSelected(entry.uuid, checkbox.checked);
        });
        checkTd.append(checkbox);

        const nameTd = document.createElement('td');
        nameTd.textContent = entry.name || '(unnamed)';

        const loginTd = document.createElement('td');
        loginTd.textContent = entry.login || '';

        const urlTd = document.createElement('td');
        urlTd.textContent = entry.url || '';

        const groupTd = document.createElement('td');
        groupTd.textContent = entry.group || '';

        const actionsTd = document.createElement('td');
        actionsTd.className = 'text-end text-nowrap';

        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-sm btn-outline-secondary me-1';
        editBtn.title = 'Edit';
        editBtn.innerHTML = '<i class="fa fa-pencil" aria-hidden="true"></i>';
        editBtn.addEventListener('click', () => openEntryModal(entry));

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-sm btn-outline-danger';
        deleteBtn.title = 'Delete';
        deleteBtn.innerHTML = '<i class="fa fa-trash" aria-hidden="true"></i>';
        deleteBtn.addEventListener('click', () => deleteEntry(entry));

        actionsTd.append(editBtn, deleteBtn);
        tr.append(checkTd, nameTd, loginTd, urlTd, groupTd, actionsTd);
        tbody.append(tr);
    }
};

const toggleSelected = function(uuid, checked) {
    if (checked) {
        entriesState.selected.add(uuid);
    } else {
        entriesState.selected.delete(uuid);
    }
    renderEntries();
};

const deleteSelected = async function() {
    const count = entriesState.selected.size;
    if (count === 0) return;
    if (!window.confirm(`Delete ${count} selected entrie(s)? This cannot be undone.`)) {
        return;
    }
    for (const uuid of Array.from(entriesState.selected)) {
        await send('pwsave_delete_entry', [ uuid ]);
    }
    entriesState.selected.clear();
    await refreshEntries();
};

const updateSortIcons = function() {
    document.querySelectorAll('.entry-sortable').forEach(th => {
        const icon = th.querySelector('.entry-sort-icon');
        if (!icon) return;
        const key = th.dataset.sortKey;
        if (entriesState.sort.key === key) {
            icon.className = 'fa ' + (entriesState.sort.dir > 0 ? 'fa-sort-up' : 'fa-sort-down');
        } else {
            icon.className = 'fa fa-sort entry-sort-icon';
        }
    });
};

const deleteEntry = async function(entry) {
    if (!window.confirm(`Delete entry "${entry.name || '(unnamed)'}"? This cannot be undone.`)) {
        return;
    }
    await send('pwsave_delete_entry', [ entry.uuid ]);
    await refreshEntries();
};

// Short description of a stored 2FA URI, e.g. "alice · 6 digits · SHA1 · 30s"
const describeTotp = function(uri) {
    try {
        const parsed = new URL(uri);
        const issuer = (parsed.searchParams.get('issuer') || '').trim();
        let label = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'TOTP';
        if (issuer && label.toLowerCase().startsWith(issuer.toLowerCase() + ':')) {
            label = label.slice(issuer.length + 1).trim();
        } else if (label.includes(':')) {
            label = label.slice(label.indexOf(':') + 1).trim();
        }

        const algorithm = (parsed.searchParams.get('algorithm') || 'SHA1').toUpperCase();
        const digits = parsed.searchParams.get('digits') || '6';
        const period = parsed.searchParams.get('period') || '30';
        return `${label} · ${digits} digits · ${algorithm} · ${period}s`;
    } catch (e) {
        return '2FA is enabled';
    }
};

// The TOTP inputs are only shown when needed: so an existing secret is never wiped by accident
const updateTotpEditor = function() {
    const hasTotp = !!entriesState.totpOriginal;
    const showFields = !hasTotp || entriesState.totpChangeRequested;

    $('#edit-totp-status').classList.toggle('d-none', showFields);
    $('#edit-totp-fields').classList.toggle('d-none', !showFields);
    if (!showFields) {
        showTotpError('');
    }

    if (showFields) {
        return;
    }

    $('#edit-totp-status-icon').innerHTML = entriesState.totpRemoveRequested
        ? '<i class="fa fa-exclamation-triangle text-danger" aria-hidden="true"></i>'
        : '<i class="fa fa-shield text-success" aria-hidden="true"></i>';
    const text = $('#edit-totp-status-text');
    text.textContent = entriesState.totpRemoveRequested ? '2FA will be removed when you save' : describeTotp(entriesState.totpOriginal);
    text.classList.toggle('text-danger', entriesState.totpRemoveRequested);
    text.classList.toggle('text-muted', !entriesState.totpRemoveRequested);
    $('#edit-totp-change').textContent = entriesState.totpRemoveRequested ? 'Undo' : 'Replace';
    $('#edit-totp-remove').classList.toggle('d-none', entriesState.totpRemoveRequested);
};

const showTotpError = function(message) {
    const error = $('#edit-totp-error');
    error.textContent = message || '';
    error.classList.toggle('d-none', !message);
};

const openEntryModal = function(entry) {
    entriesState.editingUuid = entry ? entry.uuid : null;
    $('#entry-modal-title').textContent = entry ? 'Edit entry' : 'Add entry';
    $('#edit-name').value = entry ? (entry.name || '') : '';
    $('#edit-login').value = entry ? (entry.login || '') : '';
    $('#edit-password').value = entry ? (entry.password || '') : '';
    $('#edit-password').type = 'password';
    $('#edit-toggle-password i').className = 'fa fa-eye';
    $('#edit-toggle-password').title = 'Show password';
    $('#edit-url').value = entry ? (entry.url || '') : '';
    $('#edit-group').value = entry ? (entry.group || '') : '';
    $('#edit-note').value = entry ? (entry.note || '') : '';
    entriesState.totpOriginal = entry ? (entry.totp || '') : '';
    entriesState.totpChangeRequested = false;
    entriesState.totpRemoveRequested = false;
    $('#edit-totp-secret').value = '';
    $('#edit-totp-label').value = '';
    showTotpError('');
    updateTotpEditor();
    $('#delete-entry-button').classList.toggle('d-none', !entry);
    renderGroupOptions();
    bootstrap.Modal.getOrCreateInstance($('#entry-modal')).show();
};

const saveEntry = async function() {
    const name = $('#edit-name').value.trim();
    const login = $('#edit-login').value.trim();
    const password = $('#edit-password').value;
    const url = $('#edit-url').value.trim();
    const group = $('#edit-group').value.trim();
    const note = $('#edit-note').value;
    const totpInput = $('#edit-totp-secret').value.trim();
    const totpLabel = $('#edit-totp-label').value.trim();
    showTotpError('');

    // undefined = keep the stored 2FA secret untouched
    let totp;
    if (totpInput) {
        const parsed = kpxcTotpInput.parse(totpInput);
        if (!parsed) {
            showTotpError('Invalid 2FA secret. Use a Base32 key or an otpauth:// URI');
            return;
        }

        // A URI brings its own label: only an explicitly typed label overrides it
        const fallbackLabel = parsed.uri ? totpLabel : (totpLabel || name || login);
        totp = kpxcTotpInput.toUri(parsed, fallbackLabel);
    } else if (entriesState.totpRemoveRequested && entriesState.totpOriginal) {
        totp = '';
    }

    if (entriesState.editingUuid) {
        const updates = { name, login, password, url, group, note };
        if (totp !== undefined) {
            updates.totp = totp;
        }
        await send('pwsave_update_entry', [ entriesState.editingUuid, updates ]);
    } else {
        const entry = {
            uuid: crypto.randomUUID(),
            name: name || 'New entry',
            login,
            password,
            url,
            group,
            note,
            stringFields: [],
            totp: totp || '',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await send('pwsave_add_entry', [ entry ]);
    }

    bootstrap.Modal.getInstance($('#entry-modal')).hide();
    await refreshEntries();
};

const deleteEntryFromModal = async function() {
    if (entriesState.editingUuid) {
        await send('pwsave_delete_entry', [ entriesState.editingUuid ]);
        bootstrap.Modal.getInstance($('#entry-modal')).hide();
        await refreshEntries();
    }
};

const initEntriesActions = function() {
    $('#add-entry-button').addEventListener('click', () => openEntryModal(null));

    $('#delete-selected-button').addEventListener('click', deleteSelected);

    $('#entry-search').addEventListener('input', (e) => {
        entriesState.search = e.target.value;
        renderEntries();
    });

    $('#entry-group-filter').addEventListener('change', (e) => {
        entriesState.groupFilter = e.target.value;
        renderEntries();
    });

    document.querySelectorAll('.entry-sortable').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.sortKey;
            if (entriesState.sort.key === key) {
                entriesState.sort.dir *= -1;
            } else {
                entriesState.sort = { key, dir: 1 };
            }
            renderEntries();
        });
    });

    $('#entry-select-all').addEventListener('change', (e) => {
        const list = sortEntries(filteredEntries());
        if (e.target.checked) {
            for (const entry of list) {
                entriesState.selected.add(entry.uuid);
            }
        } else {
            for (const entry of list) {
                entriesState.selected.delete(entry.uuid);
            }
        }
        renderEntries();
    });

    $('#save-entry-button').addEventListener('click', saveEntry);

    $('#delete-entry-button').addEventListener('click', deleteEntryFromModal);

    $('#edit-toggle-password').addEventListener('click', () => {
        const pw = $('#edit-password');
        const showing = pw.type === 'text';
        pw.type = showing ? 'password' : 'text';
        const icon = $('#edit-toggle-password i');
        icon.className = showing ? 'fa fa-eye' : 'fa fa-eye-slash';
        $('#edit-toggle-password').title = showing ? 'Show password' : 'Hide password';
    });

    $('#edit-totp-change').addEventListener('click', () => {
        if (entriesState.totpRemoveRequested) {
            // Undo a pending removal
            entriesState.totpRemoveRequested = false;
            updateTotpEditor();
            return;
        }

        entriesState.totpChangeRequested = true;
        $('#edit-totp-secret').value = '';
        $('#edit-totp-label').value = '';
        updateTotpEditor();
        $('#edit-totp-secret').focus();
    });

    $('#edit-totp-remove').addEventListener('click', () => {
        entriesState.totpRemoveRequested = true;
        entriesState.totpChangeRequested = false;
        $('#edit-totp-secret').value = '';
        $('#edit-totp-label').value = '';
        updateTotpEditor();
    });
};

//--------------------------------------------------------------------------
// Init
//--------------------------------------------------------------------------

const init = async function() {
    // Block access while the vault is locked: hide everything and close the tab.
    const status = await send('pwsave_get_status');
    if (status && status.unlocked === false) {
        document.body.innerHTML = '<div class="container-fluid py-5 text-center text-muted">'
            + '<i class="fa fa-lock fa-2x mb-3" aria-hidden="true"></i>'
            + '<p>The vault is locked. Unlock it from the extension popup.</p>'
            + '</div>';
        setTimeout(() => window.close(), 1500);
        return;
    }

    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            showTab(link.getAttribute('href').slice(1));
        });
    });

    initVaultActions();
    initSyncActions();
    initSecurityActions();
    initEntriesActions();

    await loadSettings();
    await refreshSyncStatus();
    await refreshEntries();
};

init();
