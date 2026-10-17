'use strict';

/**
 * New message handlers for the standalone vault (used by the rewritten popup/options).
 * Actions are dispatched by event.js when `request.action` matches (vaultActions).
 */

// Closes every open options page tab. Used when the vault gets locked so the
// management UI cannot stay open without an unlocked vault.
const closeOptionsTabs = async function() {
    try {
        const optionsUrl = browser.runtime.getURL('options/options.html');
        const found = await browser.tabs.query({ url: optionsUrl });
        if (found.length > 0) {
            await browser.tabs.remove(found.map(t => t.id));
        }
    } catch (e) {
        logError('closeOptionsTabs failed: ' + e);
    }
};

const createVaultActions = function(deps) {
    return {
        'pwsave_get_status': async function() {
            await deps.waitForInit();
            keepass.syncStatus();
            const sync = await deps.syncManager.getStatus();
            const vaultExists = await vaultManager.vaultExists;
            return {
                unlocked: vaultManager.isUnlocked,
                vaultExists,
                syncConnected: !!sync.connected,
                syncAccount: sync.account || null,
                syncError: sync.error || null,
                lastSyncedAt: sync.lastSyncedAt || null
            };
        },

        'pwsave_unlock': async function(_tab, args = []) {
            const [ masterPassword ] = args;
            const exists = await vaultManager.vaultExists;
            if (!exists) {
                await vaultManager.createVault(masterPassword);
            } else {
                const unlocked = await vaultManager.unlockVault(masterPassword);
                if (!unlocked) {
                    return { success: false, error: 'Wrong master password' };
                }
            }
            keepass.syncStatus();
            autoLockManager.setTimeout((await vaultManager.getSettings()).autoLockTimeout);
            autoLockManager.startTimer();
            keepass.updateDatabase();
            void deps.syncManager.init();
            return { success: true };
        },

        'pwsave_lock': async function() {
            autoLockManager.stopTimer();
            await vaultManager.lockVault();
            keepass.syncStatus();
            keepass.updateDatabaseHashToContent();
            await closeOptionsTabs();
            return { success: true };
        },

        'pwsave_get_entries': async function() {
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };
            return { success: true, data: vaultManager.getAllEntries() };
        },

        'pwsave_get_entries_for_url': async function(_tab, args = []) {
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };
            const [ url, submitUrl ] = args;
            if (!url) return { success: true, data: [] };
            const data = submitUrl
                ? vaultManager.getEntriesForUrls(url, submitUrl)
                : vaultManager.getEntriesForUrl(url);
            return { success: true, data };
        },

        'pwsave_get_entry': async function(_tab, args = []) {
            const [ uuid ] = args;
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };
            return { success: true, data: vaultManager.getEntryByUuid(uuid) || null };
        },

        'pwsave_add_entry': async function(_tab, args = []) {
            const [ entry ] = args;
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };
            await vaultManager.addEntry(entry);
            return { success: true };
        },

        'pwsave_update_entry': async function(_tab, args = []) {
            const [ uuid, updates ] = args;
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };
            await vaultManager.updateEntry(uuid, updates);
            return { success: true };
        },

        'pwsave_delete_entry': async function(_tab, args = []) {
            const [ uuid ] = args;
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };
            await vaultManager.deleteEntry(uuid);
            return { success: true };
        },

        'pwsave_get_totp_codes': async function() {
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };
            const entries = vaultManager.getAllEntries().filter(e => e.totp);
            const codes = [];
            for (const e of entries) {
                const parsed = parseOtpauthUri(e.totp);
                if (!parsed) continue;
                const result = await generateTotpCode(parsed.secret, parsed.algorithm, parsed.digits, parsed.period);
                codes.push({
                    uuid: e.uuid,
                    name: e.name,
                    login: e.login,
                    ...result,
                    algorithm: parsed.algorithm,
                    digits: parsed.digits
                });
            }
            return { success: true, data: codes };
        },

        'pwsave_set_entry_totp': async function(_tab, args = []) {
            const [ uuid, otpauthUri ] = args;
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };
            await vaultManager.updateEntry(uuid, { totp: otpauthUri || '' });
            return { success: true };
        },

        // Fill the current 2FA code of an entry into the active tab (no URL match required)
        'pwsave_fill_totp': async function(_tab, args = []) {
            const [ uuid, tabId ] = args;
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };

            const code = await vaultManager.getTotpCode(uuid);
            if (!code) return { success: false, error: 'No 2FA code for this entry' };

            const targetTabId = tabId || tabs.currentTabId;
            if (!targetTabId || targetTabId < 1) {
                return { success: false, error: 'No active tab' };
            }

            try {
                const filled = await browser.tabs.sendMessage(targetTabId, {
                    action: 'fill_specific_totp',
                    code: code
                });
                if (!filled) {
                    return { success: false, error: 'No 2FA field on this page' };
                }
                try {
                    await vaultManager.bumpUsage(uuid);
                } catch {
                    /* best effort */
                }
                return { success: true, data: { code } };
            } catch (e) {
                return { success: false, error: 'No content script on this page' };
            }
        },

        // Fill a specific entry on the given tab (does NOT require URL match).
        // tabId: target tab; if not provided, the current active tab is used.
        'pwsave_fill_entry': async function(_tab, args = []) {
            const [ uuid, tabId ] = args;
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };
            const entry = vaultManager.getEntryByUuid(uuid);
            if (!entry) return { success: false, error: 'Entry not found' };

            const targetTabId = tabId || tabs.currentTabId;
            if (!targetTabId || targetTabId < 1) {
                return { success: false, error: 'No active tab' };
            }

            try {
                await browser.tabs.sendMessage(targetTabId, {
                    action: 'fill_specific_credentials',
                    uuid: entry.uuid,
                    login: entry.login || '',
                    password: entry.password || '',
                    name: entry.name || '',
                    url: entry.url || '',
                    group: entry.group || '',
                    stringFields: entry.stringFields || [],
                    totp: entry.totp || ''
                });
                // Track usage for Popular/Recent sorts (fill via popup ... -> Fill form)
                try {
                    await vaultManager.bumpUsage(entry.uuid);
                } catch {
                    /* best effort */
                }
                return { success: true };
            } catch (e) {
                return { success: false, error: 'No content script on this page' };
            }
        },

        // Open the entry's URL in a new tab, then fill credentials once the page loads.
        'pwsave_go_fill': async function(_tab, args = []) {
            const [ uuid ] = args;
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };
            const entry = vaultManager.getEntryByUuid(uuid);
            if (!entry) return { success: false, error: 'Entry not found' };
            if (!entry.url) return { success: false, error: 'No URL saved for this entry' };

            let tab;
            try {
                tab = await browser.tabs.create({ url: entry.url, active: true });
            } catch (e) {
                return { success: false, error: 'Could not open URL' };
            }

            // Track usage immediately (user explicitly chose this entry via Go fill)
            try {
                await vaultManager.bumpUsage(entry.uuid);
            } catch {
                /* best effort */
            }

            // Wait for the page to load, then try to fill (content script may need time).
            const attemptFill = async function(tabId) {
                for (let i = 0; i < 15; i++) {
                    await new Promise(resolve => setTimeout(resolve, 800));
                    try {
                        await browser.tabs.sendMessage(tabId, {
                            action: 'fill_specific_credentials',
                            uuid: entry.uuid,
                            login: entry.login || '',
                            password: entry.password || '',
                            name: entry.name || '',
                            url: entry.url || '',
                            group: entry.group || '',
                            stringFields: entry.stringFields || [],
                            totp: entry.totp || ''
                        });
                        return true;
                    } catch (e) {
                        // Page may still be loading or content script not ready yet
                    }
                }
                return false;
            };

            void attemptFill(tab.id).then((ok) => {
                if (!ok) {
                    logError('pwsave_go_fill: could not fill after page load');
                }
            });

            return { success: true, tabId: tab.id };
        },

        'pwsave_generate_password': async function(_tab, args = []) {
            const [ options ] = args;
            return { success: true, data: generatePassword(options) };
        },

        'pwsave_get_settings': async function() {
            return { success: true, data: await vaultManager.getSettings() };
        },

        'pwsave_update_settings': async function(_tab, args = []) {
            const [ settings ] = args;
            await vaultManager.updateSettings(settings);
            if (settings && settings.autoLockTimeout) {
                autoLockManager.setTimeout(settings.autoLockTimeout);
            }
            return { success: true };
        },

        'pwsave_change_master_password': async function(_tab, args = []) {
            const [ currentPassword, newPassword ] = args;
            const changed = await vaultManager.changeMasterPassword(currentPassword, newPassword);
            return changed
                ? { success: true }
                : { success: false, error: 'Current password is incorrect' };
        },

        'pwsave_export_vault': async function(_tab, args = []) {
            const [ format ] = args;
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };
            const data = await vaultManager.exportVault(format);
            return { success: true, data };
        },

        'pwsave_import_vault': async function(_tab, args = []) {
            const [ format, data ] = args;
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };
            const entries = parseImportedEntries(format, data);
            await vaultManager.importEntries(entries);
            return { success: true, data: entries.length };
        },

        'pwsave_get_security_report': async function() {
            if (!vaultManager.isUnlocked) return { success: false, error: 'VAULT_LOCKED' };
            const report = await securityCenter.generateReport(vaultManager.getAllEntries());
            return { success: true, data: report };
        },

        'pwsave_sync_get_status': async function() {
            return { success: true, data: await deps.syncManager.getStatus() };
        },

        'pwsave_sync_setup': async function() {
            return { success: true, data: await deps.syncManager.setup() };
        },

        'pwsave_sync_now': async function() {
            return { success: true, data: await deps.syncManager.syncNow() };
        },

        'pwsave_sync_disable': async function() {
            await deps.syncManager.disable();
            keepass.syncStatus();
            return { success: true };
        },

        'pwsave_sync_history': async function() {
            try {
                const items = await deps.syncManager.listHistory();
                return { success: true, data: items };
            } catch (e) {
                return { success: false, error: e && e.message ? e.message : 'NETWORK' };
            }
        },

        'pwsave_sync_restore': async function(_tab, args = []) {
            const [ fileId ] = args;
            const ok = await deps.syncManager.restoreHistory(fileId);
            return ok ? { success: true } : { success: false, error: 'Could not restore backup' };
        }
    };
};
