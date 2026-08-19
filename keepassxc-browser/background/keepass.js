'use strict';

/**
 * keepass facade - thin wrapper over the local VaultManager.
 *
 * Keeps the same function names + signatures the content scripts / event.js / page.js
 * expect (retrieveCredentials, addCredentials, updateCredentials, getTotp, ...) but the
 * backend is now the encrypted local vault instead of the KeePassXC native host.
 */

const keepass = {};

// Emulated connection/status state (derived from the vault)
keepass.isConnected = false;
keepass.isKeePassXCAvailable = false;
keepass.isDatabaseClosed = true;
keepass.isEncryptionKeyUnrecognized = false;
keepass.databaseHash = '';
keepass.previousDatabaseHash = '';
keepass.associated = { 'value': false, 'hash': null };
keepass.keyRing = {};
keepass.currentKeePassXC = '';
keepass.featuresList = {};

// Refresh emulated state from the vault manager
keepass.syncStatus = function() {
    const unlocked = vaultManager.isUnlocked;
    const vaultExists = vaultManager.vaultExists;
    keepass.isConnected = unlocked;
    keepass.isKeePassXCAvailable = vaultExists;
    keepass.isDatabaseClosed = !unlocked;
    keepass.databaseHash = unlocked && vaultManager.vault ? vaultManager.vault.salt.slice(0, 16) : '';
    keepass.associated.value = unlocked;
    keepass.associated.hash = keepass.databaseHash;
};

keepass.isAssociated = function() {
    return vaultManager.isUnlocked;
};

keepass.isConfigured = function() {
    return vaultManager.vaultExists;
};

//--------------------------------------------------------------------------
// Credentials
//--------------------------------------------------------------------------

keepass.retrieveCredentials = async function(_tab, args = []) {
    const [ url, submitUrl ] = args;
    keepass.syncStatus();
    if (!vaultManager.isUnlocked) {
        return [];
    }
    if (!url) {
        return [];
    }
    const credentials = vaultManager.getCredentialsForUrl(url, submitUrl);

    // Track usage for the popup's Popular/Recent sorts (batched write, no updatedAt change).
    if (credentials.length > 0) {
        for (const cred of credentials) {
            try {
                await vaultManager.bumpUsage(cred.uuid);
            } catch (e) {
                logError('retrieveCredentials usage tracking error: ' + e);
            }
        }
    }

    return credentials;
};

keepass.addCredentials = async function(_tab, args = []) {
    const [ username, password, url, group ] = args;
    if (!vaultManager.isUnlocked) {
        return CreationError.GENERAL;
    }
    if (!password) {
        return CreationError.GENERAL;
    }

    const entry = vaultManager.newEntryFromCredentials({
        login: username || '',
        password: password || '',
        url: url || '',
        group: group || ''
    });
    await vaultManager.addEntry(entry);
    keepass.syncStatus();
    return CreationError.CREATED;
};

keepass.updateCredentials = async function(_tab, args = []) {
    const [ entryId, username, password, url, group ] = args;
    if (!vaultManager.isUnlocked) {
        return CreationError.GENERAL;
    }
    if (!entryId) {
        return CreationError.GENERAL;
    }

    const updates = {};
    if (username !== undefined) updates.login = username;
    if (password !== undefined) updates.password = password;
    if (url !== undefined) updates.url = url;
    if (group !== undefined) updates.group = group;

    try {
        await vaultManager.updateEntry(entryId, updates);
        keepass.syncStatus();
        return CreationError.UPDATED;
    } catch (e) {
        return CreationError.GENERAL;
    }
};

keepass.generatePassword = async function() {
    if (!vaultManager.isUnlocked) {
        return '';
    }
    const settings = await vaultManager.getSettings();
    const gen = settings.passwordGeneratorDefaults || DEFAULT_GENERATOR_SETTINGS;
    return generatePassword(gen);
};

//--------------------------------------------------------------------------
// Groups (kept minimal: a single Root group; entries store group/folder)
//--------------------------------------------------------------------------

keepass.getDatabaseGroups = async function() {
    if (!vaultManager.isUnlocked) {
        return [];
    }
    return {
        groups: [ { name: 'Root', uuid: 'root', children: [] } ],
        defaultGroup: page.settings.defaultGroup || '',
        defaultGroupAlwaysAsk: false
    };
};

keepass.createNewGroup = async function() {
    if (!vaultManager.isUnlocked) {
        return [];
    }
    return { name: 'Root', uuid: 'root' };
};

//--------------------------------------------------------------------------
// TOTP
//--------------------------------------------------------------------------

keepass.getTotp = async function(_tab, args = []) {
    const [ uuid ] = args;
    if (!vaultManager.isUnlocked) {
        return undefined;
    }
    return await vaultManager.getTotpCode(uuid);
};

//--------------------------------------------------------------------------
// Lock / unlock
//--------------------------------------------------------------------------

keepass.lockDatabase = async function(_tab) {
    await vaultManager.lockVault();
    keepass.syncStatus();
    keepass.updateDatabaseHashToContent();
    return true;
};

keepass.reconnect = async function(_tab, _connectionTimeout) {
    keepass.syncStatus();
    if (vaultManager.isUnlocked) {
        keepass.updateDatabaseHashToContent();
        return true;
    }

    // Vault locked - offer to unlock via the popup
    try {
        await chrome.action.openPopup();
    } catch (e) {
        // ignore - popup may not be openable from a SW context
    }
    return false;
};

keepass.updateDatabase = async function() {
    keepass.syncStatus();
    page.clearAllLogins();
    keepass.updateDatabaseHashToContent();
};

keepass.updateDatabaseHashToContent = async function() {
    try {
        const tab = await getCurrentTab();
        if (tab && tab.id) {
            browser.tabs.sendMessage(tab.id, {
                action: 'check_database_hash',
                hash: { old: keepass.previousDatabaseHash, new: keepass.databaseHash },
                connected: keepass.isKeePassXCAvailable
            }).catch((err) => {
                logError('No content script available for this tab.');
            });
            keepass.previousDatabaseHash = keepass.databaseHash;
        }
    } catch (err) {
        logError(`updateDatabaseHashToContent failed: ${err}`);
    }
};

//--------------------------------------------------------------------------
// No-ops kept for compatibility
//--------------------------------------------------------------------------

keepass.testAssociation = async function(_tab, args = []) {
    // Association = a vault exists. Lock state is separate (databaseClosed).
    const [ , triggerUnlock = false ] = args || [];
    if (!vaultManager.isUnlocked && triggerUnlock) {
        // Vault is locked and the user wants credentials -> open the popup to unlock
        try {
            await chrome.action.openPopup();
        } catch (e) {
            // ignore - popup may not be openable from a SW context
        }
    }
    return vaultManager.vaultExists;
};

keepass.associate = async function() {
    return AssociatedAction.ASSOCIATED;
};

keepass.getDatabaseHash = async function(_tab, args = []) {
    const [ , triggerUnlock = false ] = args || [];
    keepass.syncStatus();
    if (!vaultManager.isUnlocked && triggerUnlock) {
        // Vault is locked and the user wants credentials -> open the popup to unlock
        try {
            await chrome.action.openPopup();
        } catch (e) {
            // ignore - popup may not be openable from a SW context
        }
    }
    return keepass.databaseHash;
};

keepass.checkDatabaseHash = async function() {
    return keepass.databaseHash;
};

keepass.getErrorMessage = async function() {
    return '';
};

keepass.clearErrorMessage = function(_tab) {
    return undefined;
};

keepass.handleError = function(tab, _errorCode, errorMessage = '') {
    if (tab && tab.id) {
        tabs.updateTabValues(tab.id, { errorMessage: errorMessage || '' });
    }
};

keepass.migrateKeyRing = async function() {
    return Promise.resolve();
};

keepass.enableAutomaticReconnect = async function() {
    return Promise.resolve();
};

keepass.disableAutomaticReconnect = async function() {
    return Promise.resolve();
};

keepass.keePassXCUpdateAvailable = async function() {
    return false;
};

keepass.updateFeaturesList = function() {
    return undefined;
};

keepass.compareMultipleVersions = function() {
    return {};
};

keepass.isConnected = false;
