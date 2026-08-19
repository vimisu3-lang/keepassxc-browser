'use strict';

const $ = function(elem) {
    return document.querySelector(elem);
};

const send = async function(action, args = []) {
    return await browser.runtime.sendMessage({ action: action, args: args });
};

let currentEntries = [];
let currentSettings = null;
let currentSort = 'popular';
let searchQuery = '';
let editingUuid = null;
let toastTimer = null;

//--------------------------------------------------------------------------
// Screens
//--------------------------------------------------------------------------

const showScreen = function(name) {
    [ 'sync-setup', 'lock-screen', 'vault-view' ].forEach(id => {
        document.getElementById(id).classList.add('d-none');
    });
    document.getElementById(name).classList.remove('d-none');
    document.getElementById('fab-container').classList.toggle('d-none', name !== 'vault-view');
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
    currentSettings = (await send('pwsave_get_settings')).data || {};
    const entriesResponse = await send('pwsave_get_entries');
    currentEntries = entriesResponse.success ? entriesResponse.data : [];

    updateAccountBadge();
    renderEntries();
};

const updateAccountBadge = async function() {
    const syncStatus = await send('pwsave_sync_get_status');
    const s = syncStatus.data || {};
    const account = s.account || '';

    // Avatar: first 2 letters of the account email (uppercase)
    const name = account.split('@')[0] || 'VI';
    $('#account-avatar').textContent = name.slice(0, 2).toUpperCase();
    $('#account-name').textContent = account ? name : 'vault';
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

// Entry display: "Folder/ Name (login)"
const entryDisplayParts = function(entry) {
    const name = entry.name || '(unnamed)';
    const group = entry.group || '';
    const displayName = group ? name : name;
    const login = entry.login || '';
    return { group, name: displayName, login };
};

const sortEntries = function(entries, sort) {
    const arr = entries.slice();
    switch (sort) {
        case 'recent':
            arr.sort((a, b) => (b.lastUsedAt || b.updatedAt || 0) - (a.lastUsedAt || a.updatedAt || 0));
            break;
        case 'az':
            arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
            break;
        case 'popular':
        default:
            // Popular: by usage count, fallback to most recently used
            arr.sort((a, b) => {
                const diff = (b.usageCount || 0) - (a.usageCount || 0);
                if (diff !== 0) return diff;
                return (b.lastUsedAt || b.updatedAt || 0) - (a.lastUsedAt || a.updatedAt || 0);
            });
            break;
    }
    return arr;
};

const renderEntries = function() {
    const list = $('#entry-list');
    list.innerHTML = '';

    let entries = sortEntries(currentEntries, currentSort);

    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        entries = entries.filter(entry =>
            (entry.name || '').toLowerCase().includes(q) ||
            (entry.login || '').toLowerCase().includes(q) ||
            (entry.url || '').toLowerCase().includes(q) ||
            (entry.group || '').toLowerCase().includes(q)
        );
    }

    if (entries.length === 0) {
        $('#empty-state').classList.remove('d-none');
        return;
    }
    $('#empty-state').classList.add('d-none');

    for (const entry of entries) {
        const item = document.createElement('div');
        item.className = 'rf-entry';
        item.setAttribute('role', 'button');
        item.addEventListener('click', (e) => {
            if (e.isTrusted) {
                e.preventDefault();
                openEntryModal(entry);
            }
        });

        // Icon: favicon if URL, else first letter, else lock
        const icon = document.createElement('div');
        icon.className = 'rf-entry-icon';
        if (entry.url) {
            const img = document.createElement('img');
            img.src = faviconUrl(entry.url);
            img.alt = '';
            img.addEventListener('error', () => { img.remove(); icon.textContent = (entry.name || '?')[0].toUpperCase(); });
            icon.append(img);
        } else {
            icon.textContent = (entry.name || '?')[0].toUpperCase();
        }

        // Body: folder / name + login
        const body = document.createElement('div');
        body.className = 'rf-entry-body';

        const title = document.createElement('div');
        title.className = 'rf-entry-title';
        if (entry.group) {
            const folder = document.createElement('span');
            folder.className = 'rf-entry-folder';
            folder.textContent = entry.group + '/ ';
            title.append(folder);
        }
        const name = document.createElement('span');
        name.className = 'rf-entry-name';
        name.textContent = entry.name || '(unnamed)';
        title.append(name);

        body.append(title);

        if (entry.login) {
            const sub = document.createElement('div');
            sub.className = 'rf-entry-sub';
            sub.textContent = entry.login;
            body.append(sub);
        }

        // Actions on hover
        const actions = document.createElement('div');
        actions.className = 'rf-entry-actions';

        if (entry.login) {
            const copyUser = document.createElement('button');
            copyUser.className = 'rf-entry-action';
            copyUser.title = 'Copy username';
            copyUser.innerHTML = '<i class="fa fa-user" aria-hidden="true"></i>';
            copyUser.addEventListener('click', (e) => {
                if (e.isTrusted) {
                    e.stopPropagation();
                    copyText(entry.login);
                    showToast('Username copied');
                }
            });
            actions.append(copyUser);
        }

        if (entry.password) {
            const copyPass = document.createElement('button');
            copyPass.className = 'rf-entry-action';
            copyPass.title = 'Copy password';
            copyPass.innerHTML = '<i class="fa fa-copy" aria-hidden="true"></i>';
            copyPass.addEventListener('click', (e) => {
                if (e.isTrusted) {
                    e.stopPropagation();
                    copyPassword(entry);
                }
            });
            actions.append(copyPass);
        }

        // Kebab menu (⋮): copy, fill, edit, delete
        const kebab = document.createElement('button');
        kebab.className = 'rf-entry-action';
        kebab.title = 'More options';
        kebab.innerHTML = '<i class="fa fa-ellipsis-v" aria-hidden="true"></i>';
        kebab.addEventListener('click', (e) => {
            if (e.isTrusted) {
                e.stopPropagation();
                showEntryMenu(entry, e.clientX, e.clientY);
            }
        });
        actions.append(kebab);

        item.append(icon, body, actions);
        list.append(item);
    }
};

//--------------------------------------------------------------------------
// Entry kebab menu
//--------------------------------------------------------------------------

const showEntryMenu = function(entry, x, y) {
    const menu = $('#entry-menu');
    menu.innerHTML = '';
    menu.classList.remove('d-none');

    const addItem = function(label, icon, fn, danger = false) {
        const btn = document.createElement('button');
        btn.className = 'rf-entry-menu-item' + (danger ? ' danger' : '');
        btn.innerHTML = `<i class="fa ${icon}" aria-hidden="true"></i> ${label}`;
        btn.addEventListener('click', (e) => {
            if (e.isTrusted) {
                hideEntryMenu();
                fn();
            }
        });
        menu.append(btn);
    };

    const addSep = function() {
        const sep = document.createElement('div');
        sep.className = 'rf-entry-menu-sep';
        menu.append(sep);
    };

    addItem('Copy password', 'fa-copy', () => copyPassword(entry));
    if (entry.login) {
        addItem('Copy username', 'fa-user', async () => {
            await copyText(entry.login);
            showToast('Username copied');
        });
    }
    addSep();
    addItem('Go fill', 'fa-globe', () => goFill(entry));
    addItem('Fill form', 'fa-pencil', () => fillEntryOnTab(entry));
    addSep();
    addItem('Edit', 'fa-pencil-square-o', () => openEntryModal(entry));
    addItem('Delete', 'fa-trash', async () => {
        await send('pwsave_delete_entry', [ entry.uuid ]);
        showToast('Deleted');
        await initVaultView();
    }, true);

    // Position the menu near the click, clamp to viewport
    const menuRect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + menuRect.width > vw - 4) left = vw - menuRect.width - 4;
    if (top + menuRect.height > vh - 4) top = vh - menuRect.height - 4;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
};

const hideEntryMenu = function() {
    $('#entry-menu').classList.add('d-none');
};

// Open the entry's saved URL in a new tab and fill the credentials there
const goFill = async function(entry) {
    const response = await send('pwsave_go_fill', [ entry.uuid ]);
    if (!response || !response.success) {
        showToast(response?.error || 'Could not open URL');
        return;
    }
    window.close();
};

// Fill the entry into the current active tab (URL match NOT required)
const fillEntryOnTab = async function(entry) {
    const tab = await getCurrentTab();
    if (!tab || tab.id === undefined) {
        showToast('No active tab');
        return;
    }
    const res = await send('pwsave_fill_entry', [ entry.uuid, tab.id ]);
    if (res && res.success) {
        showToast('Filled');
        window.close();
    } else {
        showToast('No login form on this page');
    }
};

//--------------------------------------------------------------------------
// Copy helpers
//--------------------------------------------------------------------------

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

const showToast = function(message) {
    let toast = $('#toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'rf-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
};

//--------------------------------------------------------------------------
// Fill action
//--------------------------------------------------------------------------

const fillLogins = async function() {
    const tab = await getCurrentTab();
    if (!tab || tab.id === undefined) {
        showToast('No active tab');
        return;
    }
    try {
        await browser.tabs.sendMessage(tab.id, { action: 'fill_username_password' });
        showToast('Logins filled');
        window.close();
    } catch (e) {
        showToast('No login form on this page');
    }
};

//--------------------------------------------------------------------------
// Entry modal (add / edit)
//--------------------------------------------------------------------------

const openEntryModal = function(entry) {
    editingUuid = entry ? entry.uuid : null;
    $('#entry-modal-title').textContent = entry ? 'Edit entry' : 'Add entry';
    $('#edit-name').value = entry ? (entry.name || '') : '';
    $('#edit-login').value = entry ? (entry.login || '') : '';
    $('#edit-password').value = entry ? (entry.password || '') : '';
    $('#edit-url').value = entry ? (entry.url || '') : '';
    $('#edit-group').value = entry ? (entry.group || '') : '';
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
    const group = $('#edit-group').value.trim();
    const note = $('#edit-note').value;
    const totpSecret = $('#edit-totp-secret').value.trim().replace(/\s/g, '');
    const totpLabel = $('#edit-totp-label').value.trim();

    let totpUri = '';
    if (totpSecret) {
        const label = encodeURIComponent(totpLabel || name || login || 'TOTP');
        totpUri = `otpauth://totp/${label}?secret=${encodeURIComponent(totpSecret).replace(/%20/g, '')}`;
    }

    if (editingUuid) {
        await send('pwsave_update_entry', [ editingUuid, { name, login, password, url, group, note, totp: totpUri } ]);
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
    $('#home-button').addEventListener('click', () => {
        // Back to the main view (same as vault view, just clears search)
        searchQuery = '';
        $('#search-input').value = '';
        renderEntries();
    });

    $('#search-input').addEventListener('input', (e) => {
        searchQuery = e.target.value;
        renderEntries();
    });

    $('#copy-action-button').addEventListener('click', async () => {
        // Copy first visible entry's login (quick access)
        const entries = sortEntries(currentEntries, currentSort);
        const filtered = searchQuery
            ? entries.filter(entry =>
                (entry.name || '').toLowerCase().includes(searchQuery) ||
                (entry.login || '').toLowerCase().includes(searchQuery) ||
                (entry.group || '').toLowerCase().includes(searchQuery)
            )
            : entries;
        const first = filtered[0];
        if (first && first.login) {
            await copyText(first.login);
            showToast('Username copied');
        } else if (first) {
            await copyText(first.name);
            showToast('Name copied');
        } else {
            showToast('No entries');
        }
    });

    $('#type-selector').addEventListener('click', () => {
        showToast('Only logins available');
    });

    $('#fill-button').addEventListener('click', fillLogins);

    $('.rf-account').addEventListener('click', () => browser.runtime.openOptionsPage());

    // Sort tabs
    document.querySelectorAll('.rf-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.rf-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentSort = tab.dataset.sort;
            renderEntries();
        });
    });

    $('#menu-button').addEventListener('click', (e) => {
        e.stopPropagation();
        $('#rf-menu').classList.toggle('d-none');
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#rf-menu') && !e.target.closest('#menu-button')) {
            $('#rf-menu').classList.add('d-none');
        }
        if (!e.target.closest('#entry-menu') && !e.target.closest('.rf-entry-action')) {
            hideEntryMenu();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideEntryMenu();
            $('#rf-menu').classList.add('d-none');
        }
    });

    $('#menu-options').addEventListener('click', () => browser.runtime.openOptionsPage());

    $('#menu-sync').addEventListener('click', async () => {
        $('#rf-menu').classList.add('d-none');
        const response = await send('pwsave_sync_now');
        showToast(response && response.success ? 'Synced' : 'Sync failed');
    });

    $('#menu-lock').addEventListener('click', async () => {
        $('#rf-menu').classList.add('d-none');
        await send('pwsave_lock');
        await initStatus();
    });

    $('#menu-delete-all').addEventListener('click', async () => {
        $('#rf-menu').classList.add('d-none');
        const count = currentEntries.length;
        if (count === 0) {
            showToast('No entries to delete');
            return;
        }
        if (window.confirm(`Delete ALL ${count} entries? This cannot be undone.`)) {
            const response = await send('pwsave_clear_entries');
            if (response && response.success) {
                await initVaultView();
                showToast('All entries deleted');
            } else {
                showToast(response?.error || 'Delete failed');
            }
        }
    });

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

    $('#fab-add').addEventListener('click', () => openEntryModal(null));
    $('#fab-save').addEventListener('click', () => openEntryModal(null));

    $('#save-entry-button').addEventListener('click', saveEntry);

    $('#delete-entry-button').addEventListener('click', async () => {
        if (editingUuid) {
            await send('pwsave_delete_entry', [ editingUuid ]);
            bootstrap.Modal.getInstance($('#entry-modal')).hide();
            showToast('Deleted');
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

    $('#gen-again').addEventListener('click', generateAndShow);
    $('#gen-copy').addEventListener('click', () => {
        copyText($('#gen-password').value);
        showToast('Password copied');
    });
    $('#gen-length').addEventListener('change', generateAndShow);
    $('#gen-symbols').addEventListener('change', generateAndShow);
    $('#gen-numbers').addEventListener('change', generateAndShow);
};

(async () => {
    await loadColorTheme();
    initEvents();
    await initStatus();
})();
