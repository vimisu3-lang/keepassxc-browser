'use strict';

const $ = function(elem) {
    return document.querySelector(elem);
};

const send = async function(action, args = []) {
    return await browser.runtime.sendMessage({ action: action, args: args });
};

let currentEntries = [];
let fillEntries = [];
let currentSettings = null;
let currentView = 'fill';
let currentTabUrl = null;
let searchQuery = '';
let editingUuid = null;
let toastTimer = null;
let generatorInitialized = false;
let totpCodes = {};
let totpTicker = null;
let totpOriginal = '';
let totpChangeRequested = false;
let totpRemoveRequested = false;

//--------------------------------------------------------------------------
// Screens
//--------------------------------------------------------------------------

const showScreen = function(name) {
    [ 'sync-setup', 'lock-screen', 'vault-view' ].forEach(id => {
        document.getElementById(id).classList.add('d-none');
    });
    document.getElementById(name).classList.remove('d-none');
    document.getElementById('fab-container').classList.toggle('d-none', name !== 'vault-view');

    // No point counting down 2FA codes while the vault view is not visible
    if (name !== 'vault-view' && totpTicker) {
        clearInterval(totpTicker);
        totpTicker = null;
    }
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
    applyGeneratorDefaults();
    const entriesResponse = await send('pwsave_get_entries');
    currentEntries = entriesResponse.success ? entriesResponse.data : [];

    // Resolve current tab URL for Fill Logins (matching) view
    let activeTab = null;
    try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        activeTab = tabs && tabs.length > 0 ? tabs[0] : null;
        currentTabUrl = activeTab ? activeTab.url : null;
    } catch (e) {
        currentTabUrl = null;
    }

    const fillResponse = currentTabUrl
        ? await send('pwsave_get_entries_for_url', [ currentTabUrl ])
        : { success: true, data: [] };
    fillEntries = fillResponse && fillResponse.success ? fillResponse.data : [];

    // Default to Fill tab when there are matching entries, otherwise All
    currentView = fillEntries.length > 0 ? 'fill' : 'all';

    // 2FA codes for the entries that have TOTP configured
    await refreshTotpCodes();

    updateViewTabs();
    renderEntries();
    startTotpTicker();
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

// Fixed display order: most used first, fallback to most recently used
const sortEntries = function(entries) {
    const arr = entries.slice();
    arr.sort((a, b) => {
        const diff = (b.usageCount || 0) - (a.usageCount || 0);
        if (diff !== 0) return diff;
        return (b.lastUsedAt || b.updatedAt || 0) - (a.lastUsedAt || a.updatedAt || 0);
    });
    return arr;
};

const updateViewTabs = function() {
    const fillCount = fillEntries.length;
    const allCount = currentEntries.length;
    const fillCountEl = $('#fill-count');
    const allCountEl = $('#all-count');
    if (fillCountEl) fillCountEl.textContent = fillCount > 0 ? `(${fillCount})` : '';
    if (allCountEl) allCountEl.textContent = allCount > 0 ? `(${allCount})` : '';
    $('#type-selector').classList.toggle('active', currentView === 'all');
    $('#fill-button').classList.toggle('active', currentView === 'fill');
};

const renderEntries = function() {
    updateViewTabs();

    const list = $('#entry-list');
    list.innerHTML = '';

    const base = currentView === 'fill' ? fillEntries : currentEntries;
    let entries = sortEntries(base);

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
        // Contextual empty text
        const emptyEl = $('#empty-state');
        if (currentView === 'fill' && fillEntries.length === 0 && currentEntries.length > 0) {
            emptyEl.textContent = 'No matching logins for this site.';
        } else if (currentView === 'fill' && currentEntries.length === 0) {
            emptyEl.textContent = 'No entries yet.';
        } else {
            emptyEl.textContent = 'No entries found.';
        }
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

        // 2FA: live code + countdown (click to copy)
        if (entry.totp) {
            const totp = totpCodes[entry.uuid];
            const chip = document.createElement('div');
            chip.className = 'rf-totp-chip' + (totp && totp.remaining <= 5 ? ' expiring' : '');
            if (totp) {
                chip.title = 'Click to copy 2FA code';
                chip.innerHTML = `<i class="fa fa-shield" aria-hidden="true"></i> <span class="rf-totp-code">${formatTotpCode(totp.code)}</span> <span class="rf-totp-remaining" data-uuid="${entry.uuid}">${totp.remaining}s</span>`;
                chip.addEventListener('click', (e) => {
                    if (e.isTrusted) {
                        e.stopPropagation();
                        copyTotpCode(entry);
                    }
                });
            } else {
                chip.title = '2FA is enabled for this entry';
                chip.innerHTML = '<i class="fa fa-shield" aria-hidden="true"></i> <span class="rf-totp-code">2FA</span>';
            }
            body.append(chip);
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
    if (entry.totp) {
        addItem('Copy 2FA code', 'fa-shield', () => copyTotpCode(entry));
        addItem('Fill 2FA code', 'fa-key', () => fillTotpOnTab(entry));
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
// 2FA (TOTP)
//--------------------------------------------------------------------------

const formatTotpCode = function(code) {
    const text = String(code || '');
    if (text.length === 6) return `${text.slice(0, 3)} ${text.slice(3)}`;
    if (text.length === 8) return `${text.slice(0, 4)} ${text.slice(4)}`;
    return text;
};

const refreshTotpCodes = async function() {
    totpCodes = {};
    const response = await send('pwsave_get_totp_codes');
    if (response && response.success && Array.isArray(response.data)) {
        for (const item of response.data) {
            totpCodes[item.uuid] = item;
        }
    }
};

// Count down in place, and re-fetch the codes when a time window expires
const startTotpTicker = function() {
    if (totpTicker) {
        return;
    }

    totpTicker = setInterval(async () => {
        let expired = false;
        for (const totp of Object.values(totpCodes)) {
            totp.remaining -= 1;
            if (totp.remaining <= 0) {
                expired = true;
            }
        }

        if (expired) {
            await refreshTotpCodes();
            renderEntries();
            return;
        }

        document.querySelectorAll('.rf-totp-remaining').forEach(el => {
            const totp = totpCodes[el.dataset.uuid];
            if (!totp) {
                return;
            }
            el.textContent = `${totp.remaining}s`;
            el.closest('.rf-totp-chip')?.classList.toggle('expiring', totp.remaining <= 5);
        });
    }, 1000);
};

const copyTotpCode = async function(entry) {
    let code = totpCodes[entry.uuid]?.code;
    if (!code) {
        await refreshTotpCodes();
        renderEntries();
        code = totpCodes[entry.uuid]?.code;
    }

    if (!code) {
        showToast('No 2FA code for this entry');
        return;
    }

    await copyText(code);
    showToast('2FA code copied');
};

const fillTotpOnTab = async function(entry) {
    const tab = await getCurrentTab();
    if (!tab || tab.id === undefined) {
        showToast('No active tab');
        return;
    }

    const response = await send('pwsave_fill_totp', [ entry.uuid, tab.id ]);
    if (response && response.success) {
        showToast('2FA code filled');
        window.close();
    } else {
        showToast(response?.error || 'Could not fill 2FA code');
    }
};

//--------------------------------------------------------------------------
// Entry modal (add / edit)
//--------------------------------------------------------------------------

const setPasswordVisible = function(visible) {
    $('#edit-password').type = visible ? 'text' : 'password';
    $('#edit-toggle-password i').className = visible ? 'fa fa-eye-slash' : 'fa fa-eye';
    $('#edit-toggle-password').title = visible ? 'Hide password' : 'Show password';
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
    const hasTotp = !!totpOriginal;
    const showFields = !hasTotp || totpChangeRequested;

    $('#edit-totp-status').classList.toggle('d-none', showFields);
    $('#edit-totp-fields').classList.toggle('d-none', !showFields);
    if (showFields) {
        return;
    }

    $('#edit-totp-status-icon').innerHTML = totpRemoveRequested
        ? '<i class="fa fa-exclamation-triangle text-danger" aria-hidden="true"></i>'
        : '<i class="fa fa-shield text-success" aria-hidden="true"></i>';
    const text = $('#edit-totp-status-text');
    text.textContent = totpRemoveRequested ? '2FA will be removed when you save' : describeTotp(totpOriginal);
    text.classList.toggle('text-danger', totpRemoveRequested);
    text.classList.toggle('text-muted', !totpRemoveRequested);
    $('#edit-totp-change').textContent = totpRemoveRequested ? 'Undo' : 'Replace';
    $('#edit-totp-remove').classList.toggle('d-none', totpRemoveRequested);
};

const openEntryModal = function(entry) {
    editingUuid = entry ? entry.uuid : null;
    $('#entry-modal-title').textContent = entry ? 'Edit entry' : 'Add entry';
    $('#edit-name').value = entry ? (entry.name || '') : '';
    $('#edit-login').value = entry ? (entry.login || '') : '';
    $('#edit-password').value = entry ? (entry.password || '') : '';
    setPasswordVisible(false);
    $('#edit-url').value = entry ? (entry.url || '') : '';
    $('#edit-group').value = entry ? (entry.group || '') : '';
    $('#edit-note').value = entry ? (entry.note || '') : '';
    totpOriginal = entry ? (entry.totp || '') : '';
    totpChangeRequested = false;
    totpRemoveRequested = false;
    $('#edit-totp-secret').value = '';
    $('#edit-totp-label').value = '';
    updateTotpEditor();
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

    // undefined = keep the stored 2FA secret untouched
    let totp;
    if (totpSecret) {
        const label = encodeURIComponent(totpLabel || name || login || 'TOTP');
        totp = `otpauth://totp/${label}?secret=${encodeURIComponent(totpSecret).replace(/%20/g, '')}`;
    } else if (totpRemoveRequested && totpOriginal) {
        totp = '';
    }

    if (editingUuid) {
        const updates = { name, login, password, url, group, note };
        if (totp !== undefined) {
            updates.totp = totp;
        }
        await send('pwsave_update_entry', [ editingUuid, updates ]);
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
    await initVaultView();
};

//--------------------------------------------------------------------------
// Password generator
//--------------------------------------------------------------------------

// Use the generator defaults saved in Settings as the starting values
// (applied once per popup session, so in-popup tweaks are not reverted)
const applyGeneratorDefaults = function() {
    if (generatorInitialized) return;
    generatorInitialized = true;

    const defaults = (currentSettings && currentSettings.passwordGeneratorDefaults) || {};
    if (typeof defaults.length === 'number') {
        $('#gen-length').value = defaults.length;
    }
    $('#gen-uppercase').checked = defaults.useUppercase !== false;
    $('#gen-lowercase').checked = defaults.useLowercase !== false;
    $('#gen-numbers').checked = defaults.useNumbers !== false;
    $('#gen-symbols').checked = defaults.useSymbols !== false;
    $('#gen-ambiguous').checked = defaults.excludeAmbiguous === true;
};

const generatorOptions = function() {
    const useNumbers = $('#gen-numbers').checked;
    const useSymbols = $('#gen-symbols').checked;
    return {
        length: Math.min(128, Math.max(4, Number($('#gen-length').value) || 20)),
        useUppercase: $('#gen-uppercase').checked,
        useLowercase: $('#gen-lowercase').checked,
        useNumbers,
        useSymbols,
        excludeAmbiguous: $('#gen-ambiguous').checked,
        minDigits: useNumbers ? 1 : 0,
        minSymbols: useSymbols ? 1 : 0
    };
};

const requestPassword = async function() {
    const options = generatorOptions();
    if (!options.useUppercase && !options.useLowercase && !options.useNumbers && !options.useSymbols) {
        return { success: false, error: 'Select at least one character set' };
    }
    return await send('pwsave_generate_password', [ options ]);
};

const generateAndShow = async function() {
    const response = await requestPassword();
    const errorEl = $('#gen-error');
    if (response && response.success) {
        $('#gen-password').value = response.data;
        errorEl.classList.add('d-none');
    } else {
        $('#gen-password').value = '';
        errorEl.textContent = (response && response.error) || 'Could not generate password';
        errorEl.classList.remove('d-none');
    }
};

const openGenerator = async function() {
    bootstrap.Modal.getOrCreateInstance($('#generator-modal')).show();
    await generateAndShow();
};

// Hand the generated password over to the add-entry modal
const useGeneratedInNewEntry = function() {
    const password = $('#gen-password').value;
    const modalEl = $('#generator-modal');
    modalEl.addEventListener('hidden.bs.modal', () => {
        openEntryModal(null);
        if (password) {
            $('#edit-password').value = password;
        }
        if (currentTabUrl && /^https?:/i.test(currentTabUrl)) {
            $('#edit-url').value = currentTabUrl;
        }
    }, { once: true });
    bootstrap.Modal.getOrCreateInstance(modalEl).hide();
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
        // Copy first visible entry's login (quick access, respects current view)
        const base = currentView === 'fill' ? fillEntries : currentEntries;
        const entries = sortEntries(base);
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
        currentView = 'all';
        renderEntries();
    });

    $('#fill-button').addEventListener('click', () => {
        currentView = 'fill';
        renderEntries();
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

    $('#save-entry-button').addEventListener('click', saveEntry);

    $('#delete-entry-button').addEventListener('click', async () => {
        if (editingUuid) {
            await send('pwsave_delete_entry', [ editingUuid ]);
            bootstrap.Modal.getInstance($('#entry-modal')).hide();
            showToast('Deleted');
            await initVaultView();
        }
    });

    $('#edit-toggle-password').addEventListener('click', () => {
        setPasswordVisible($('#edit-password').type !== 'text');
    });

    $('#edit-generate-password').addEventListener('click', async () => {
        const response = await requestPassword();
        if (!response || !response.success) {
            showToast((response && response.error) || 'Could not generate password');
            return;
        }
        $('#edit-password').value = response.data;
        setPasswordVisible(true);
        showToast('Password generated');
    });

    $('#edit-totp-change').addEventListener('click', () => {
        if (totpRemoveRequested) {
            // Undo a pending removal
            totpRemoveRequested = false;
            updateTotpEditor();
            return;
        }

        totpChangeRequested = true;
        $('#edit-totp-secret').value = '';
        $('#edit-totp-label').value = '';
        updateTotpEditor();
        $('#edit-totp-secret').focus();
    });

    $('#edit-totp-remove').addEventListener('click', () => {
        totpRemoveRequested = true;
        totpChangeRequested = false;
        $('#edit-totp-secret').value = '';
        $('#edit-totp-label').value = '';
        updateTotpEditor();
    });

    $('#menu-generator').addEventListener('click', async () => {
        $('#rf-menu').classList.add('d-none');
        await openGenerator();
    });

    $('#gen-again').addEventListener('click', generateAndShow);
    $('#gen-new-entry').addEventListener('click', useGeneratedInNewEntry);
    $('#gen-copy').addEventListener('click', async () => {
        const password = $('#gen-password').value;
        if (!password) return;
        await copyText(password);
        showToast('Password copied');
    });
    $('#gen-length').addEventListener('change', generateAndShow);
    $('#gen-symbols').addEventListener('change', generateAndShow);
    $('#gen-numbers').addEventListener('change', generateAndShow);
    $('#gen-uppercase').addEventListener('change', generateAndShow);
    $('#gen-lowercase').addEventListener('change', generateAndShow);
    $('#gen-ambiguous').addEventListener('change', generateAndShow);
};

(async () => {
    await loadColorTheme();
    initEvents();
    await initStatus();
})();
