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
    const disabled = locked;
    [ '#master-password-card', '#export-encrypted-button', '#export-csv-button',
        '#import-file', '#security-report-button' ].forEach(sel => {
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
// Init
//--------------------------------------------------------------------------

const init = async function() {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            showTab(link.getAttribute('href').slice(1));
        });
    });

    initVaultActions();
    initSyncActions();
    initSecurityActions();

    await loadSettings();
    await refreshSyncStatus();
    await refreshVaultLockedState();
};

init();
