'use strict';

/**
 * chrome.storage accessors for the vault, sync state and session data.
 * Ported from PWSave shared/storage-utils.ts
 */

const saveVaultToStorage = async function(vault) {
    await chrome.storage.local.set({ [VAULT_STORAGE_KEY]: vault });
};

const loadVaultFromStorage = async function() {
    const result = await chrome.storage.local.get(VAULT_STORAGE_KEY);
    return result[VAULT_STORAGE_KEY] || null;
};

const saveSyncState = async function(state) {
    await chrome.storage.local.set({ [SYNC_STORAGE_KEY]: state });
};

const loadSyncState = async function() {
    const result = await chrome.storage.local.get(SYNC_STORAGE_KEY);
    return result[SYNC_STORAGE_KEY] || null;
};

const loadSyncBackups = async function() {
    const result = await chrome.storage.local.get(SYNC_BACKUP_KEY);
    return result[SYNC_BACKUP_KEY] || [];
};

const saveSyncBackups = async function(backups) {
    await chrome.storage.local.set({ [SYNC_BACKUP_KEY]: backups });
};

const saveSessionData = async function(session) {
    await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: session });
};

const loadSessionData = async function() {
    const result = await chrome.storage.session.get(SESSION_STORAGE_KEY);
    return result[SESSION_STORAGE_KEY] || null;
};

const clearSessionData = async function() {
    await chrome.storage.session.remove(SESSION_STORAGE_KEY);
};

const clearVault = async function() {
    await chrome.storage.local.remove([ VAULT_STORAGE_KEY, SYNC_STORAGE_KEY, SYNC_BACKUP_KEY ]);
    await clearSessionData();
};
