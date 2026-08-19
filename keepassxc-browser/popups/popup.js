'use strict';

const $ = function(elem) {
    return document.querySelector(elem);
};

const send = async function(action, args = []) {
    return await browser.runtime.sendMessage({ action: action, args: args });
};

let currentEntries = [];
let currentSettings = null;

//--------------------------------------------------------------------------
// Screens
//--------------------------------------------------------------------------

const showScreen = function(name) {
    [ 'sync-setup', 'lock-screen', 'vault-view' ].forEach(id => {
        document.getElementById(id).classList.add('d-none');
    });
    document.getElementById(name).classList.remove('d-none');
};

const initStatus = async function() {
    const status = await send('pwsave_get_status');
    if (!status.unlocked) {
        if (!status.syncConnected) {
            showScreen('sync-setup');
        } else {
            $('#lock-title').textContent = status.vaultExists ? 'Unlock vault' : 'Create vault';
            showScreen('lock-screen');
            $('#master-password').focus();
        }
        return;
    }

    await initVaultView();
};

//--------------------------------------------------------------------------
// Vault view
//--------------------------------------------------------------------------

const initVaultView = async function() {
    showScreen('vault-view');
    currentSettings = (await send('pwsave_get_settings')).data;
    const entriesResponse = await send('pwsave_get_entries');
    currentEntries = entriesResponse.success ? entriesResponse.data : [];

    const syncStatus = await send('pwsave_sync_get_status');
    const s = syncStatus.data || {};
    const syncText = s.connected
        ? `Synced${s.account ? ' as ' + s.account : ''}${s.error ? ' (' + s.error + ')' : ''}`
        : 'Not connected';
    $('#sync-status-text').textContent = syncText;

    $('#search-input').value = '';
    renderEntries(currentEntries);
    renderTotpCodes();
};

const faviconUrl = function(url) {
    if (!url) {
        return '../icons/keepassxc.svg';
    }
    try {
        const hostname = new URL(url).hostname;
        return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
    } catch (e) {
        return '../icons/keepassxc.svg';
    }
};

const renderEntries = function(entries) {
    const list = $('#entry-list');
    list.innerHTML = '';

    if (entries.length === 0) {
        $('#empty-state').classList.remove('d-none');
        return;
    }
    $('#empty-state').classList.add('d-none');

    for (const entry of entries) {
        const item = document.createElement('a');
        item.setAttribute('href', '#');
        item.className = 'list-group-item list-group-item-action pwsave-entry d-flex align-items-center gap-2';
        item.addEventListener('click', (e) => {
            if (e.isTrusted) {
                e.preventDefault();
                openEntryModal(entry);
            }
        });

        const img = document.createElement('img');
        img.src = faviconUrl(entry.url);
        img.width = 16;
        img.height = 16;
        img.className = 'rounded';
        img.addEventListener('error', () => { img.src = '../icons/keepassxc.svg'; });

        const text = document.createElement('div');
        text.className = 'flex-grow-1 overflow-hidden';
        const name = document.createElement('div');
        name.className = 'text-truncate';
        name.textContent = entry.name || '(unnamed)';
        const login = document.createElement('div');
        login.className = 'text-truncate small text-muted';
        login.textContent = entry.login || '';
        text.append(name, login);

        const actions = document.createElement('div');
        actions.className = 'd-flex gap-1';
        actions.addEventListener('click', (e) => e.stopPropagation());

        if (entry.password) {
            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn btn-sm btn-outline-secondary pwsave-icon-btn';
            copyBtn.title = 'Copy password';
            copyBtn.innerHTML = '<i class="fa fa-copy" aria-hidden="true"></i>';
            copyBtn.addEventListener('click', (e) => {
                if (e.isTrusted) {
                    copyPassword(entry);
                }
            });
            actions.append(copyBtn);
        }

        if (entry.login) {
            const userBtn = document.createElement('button');
            userBtn.className = 'btn btn-sm btn-outline-secondary pwsave-icon-btn';
            userBtn.title = 'Copy username';
            userBtn.innerHTML = '<i class="fa fa-user" aria-hidden="true"></i>';
            userBtn.addEventListener('click', (e) => {
                if (e.isTrusted) {
                    copyUsername(entry);
                }
            });
            actions.append(userBtn);
        }

        item.append(img, text, actions);
        list.append(item);
    }
};

const copyText = async function(text) {
    const delay = (currentSettings && currentSettings.clipboardClearDelay) || 0;
    try {
        await navigator.clipboard.writeText(text);
    } catch (e) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
    }

    if (delay > 0) {
        setTimeout(() => {
            try {
                navigator.clipboard.writeText('');
            } catch (e) { /* ignore */ }
        }, delay);
    }
};

const copyPassword = async function(entry) {
    await copyText(entry.password || '');
    showToast('Password copied');
};

const copyUsername = async function(entry) {
    await copyText(entry.login || '');
    showToast('Username copied');
};

let toastTimer = null;
const showToast = function(message) {
    let toast = $('#toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'pwsave-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
};

//--------------------------------------------------------------------------
// TOTP codes
//--------------------------------------------------------------------------

let totpTimer = null;

const renderTotpCodes = async function() {
    const response = await send('pwsave_get_totp_codes');
    const codes = response.success ? response.data : [];
    const section = $('#totp-section');
    const list = $('#totp-list');

    if (codes.length === 0) {
        section.classList.add('d-none');
        if (totpTimer) {
            clearInterval(totpTimer);
            totpTimer = null;
        }
        return;
    }

    section.classList.remove('d-none');
    list.innerHTML = '';
    for (const code of codes) {
        const item = document.createElement('div');
        item.className = 'list-group-item d-flex align-items-center gap-2 py-1';
        const label = document.createElement('span');
        label.className = 'small flex-grow-1 text-truncate';
        label.textContent = `${code.name || 'TOTP'}${code.login ? ' (' + code.login + ')' : ''}`;
        const value = document.createElement('code');
        value.className = 'pwsave-totp-code';
        value.textContent = code.code;
        item.append(label, value);
        item.addEventListener('click', (e) => {
            if (e.isTrusted) {
                copyText(code.code);
                showToast('Code copied');
            }
        });
        list.append(item);
    }

    if (!totpTimer) {
        totpTimer = setInterval(renderTotpCodes, 1000);
    }
};

//--------------------------------------------------------------------------
// Entry modal (add / edit)
//--------------------------------------------------------------------------

let editingUuid = null;

const openEntryModal = function(entry) {
    editingUuid = entry ? entry.uuid : null;
    $('#entry-modal-title').textContent = entry ? 'Edit entry' : 'Add entry';
    $('#edit-name').value = entry ? (entry.name || '') : '';
    $('#edit-login').value = entry ? (entry.login || '') : '';
    $('#edit-password').value = entry ? (entry.password || '') : '';
    $('#edit-url').value = entry ? (entry.url || '') : '';
    $('#edit-note').value = entry ? (entry.note || '') : '';
    $('#edit-totp-secret').value = '';
    $('#edit-totp-label').value = '';
    $('#delete-entry-button').classList.toggle('d-none', !entry);
    bootstrap.Modal.getOrCreateInstance($('#entry-modal')).show();
};

const saveEntry = async function() {
    const name = $('#edit-name').value.trim();
    const login = $('#edit-login').value.trim();
    const password = $('#edit-password').value;
    const url = $('#edit-url').value.trim();
    const note = $('#edit-note').value;
    const totpSecret = $('#edit-totp-secret').value.trim().replace(/\s/g, '');
    const totpLabel = $('#edit-totp-label').value.trim();

    let totpUri = '';
    if (totpSecret) {
        const label = encodeURIComponent(totpLabel || name || login || 'TOTP');
        totpUri = `otpauth://totp/${label}?secret=${encodeURIComponent(totpSecret).replace(/%20/g, '')}`;
    }

    if (editingUuid) {
        await send('pwsave_update_entry', [ editingUuid, { name, login, password, url, note, totp: totpUri } ]);
    } else {
        const entry = {
            uuid: crypto.randomUUID(),
            name: name || 'New entry',
            login,
            password,
            url,
            note,
            group: '',
            stringFields: [],
            totp: totpUri,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await send('pwsave_add_entry', [ entry ]);
    }

    bootstrap.Modal.getInstance($('#entry-modal')).hide();
    await initVaultView();
};

//--------------------------------------------------------------------------
// Password generator
//--------------------------------------------------------------------------

const generateAndShow = async function() {
    const options = {
        length: Number($('#gen-length').value) || 20,
        useUppercase: true,
        useLowercase: true,
        useNumbers: $('#gen-numbers').checked,
        useSymbols: $('#gen-symbols').checked,
        excludeAmbiguous: false,
        minDigits: 1,
        minSymbols: 1
    };
    const response = await send('pwsave_generate_password', [ options ]);
    $('#gen-password').value = response.success ? response.data : '';
};

//--------------------------------------------------------------------------
// Events
//--------------------------------------------------------------------------

const initEvents = function() {
    $('#options-button').addEventListener('click', () => browser.runtime.openOptionsPage());

    $('#signin-button').addEventListener('click', async () => {
        const response = await send('pwsave_sync_setup');
        const data = response.success ? response.data : {};
        if (!data.connected) {
            const err = $('#sync-error');
            err.textContent = 'Could not connect to Google. Please try again.';
            err.classList.remove('d-none');
            return;
        }
        await initStatus();
    });

    $('#unlock-button').addEventListener('click', async () => {
        const password = $('#master-password').value;
        if (!password) return;
        const response = await send('pwsave_unlock', [ password ]);
        if (!response.success) {
            const err = $('#lock-error');
            err.textContent = response.error || 'Could not unlock vault.';
            err.classList.remove('d-none');
            return;
        }
        $('#master-password').value = '';
        $('#lock-error').classList.add('d-none');
        await initVaultView();
    });
    $('#master-password').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            $('#unlock-button').click();
        }
    });

    $('#lock-button').addEventListener('click', async () => {
        await send('pwsave_lock');
        await initStatus();
    });

    $('#add-entry-button').addEventListener('click', () => openEntryModal(null));

    $('#save-entry-button').addEventListener('click', saveEntry);

    $('#delete-entry-button').addEventListener('click', async () => {
        if (editingUuid && window.confirm('Delete this entry?')) {
            await send('pwsave_delete_entry', [ editingUuid ]);
            bootstrap.Modal.getInstance($('#entry-modal')).hide();
            await initVaultView();
        }
    });

    $('#edit-generate').addEventListener('click', async () => {
        const options = {
            length: 20, useUppercase: true, useLowercase: true, useNumbers: true,
            useSymbols: true, excludeAmbiguous: false, minDigits: 1, minSymbols: 1
        };
        const response = await send('pwsave_generate_password', [ options ]);
        $('#edit-password').value = response.success ? response.data : '';
    });

    $('#generator-button').addEventListener('click', () => {
        generateAndShow();
        bootstrap.Modal.getOrCreateInstance($('#generator-modal')).show();
    });
    $('#gen-again').addEventListener('click', generateAndShow);
    $('#gen-copy').addEventListener('click', () => {
        copyText($('#gen-password').value);
        showToast('Password copied');
    });
    $('#gen-length').addEventListener('change', generateAndShow);
    $('#gen-symbols').addEventListener('change', generateAndShow);
    $('#gen-numbers').addEventListener('change', generateAndShow);

    $('#search-input').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        const filtered = currentEntries.filter(entry =>
            (entry.name || '').toLowerCase().includes(q) ||
            (entry.login || '').toLowerCase().includes(q) ||
            (entry.url || '').toLowerCase().includes(q)
        );
        renderEntries(filtered);
    });

    $('#sync-now-button').addEventListener('click', async () => {
        await send('pwsave_sync_now');
        await initVaultView();
    });

    $('#totp-refresh-button').addEventListener('click', renderTotpCodes);
};

(async () => {
    await loadColorTheme();
    initEvents();
    await initStatus();
})();
