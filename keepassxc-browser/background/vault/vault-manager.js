'use strict';

/**
 * VaultManager - owns the encrypted vault, CRUD and the AES key.
 * Ported from PWSave background/vault-manager.ts with TOTP embedded in entries.
 *
 * Vault shape (storage.local 'pwsave_vault'):
 *   { version, salt, masterHash, entries[], settings, deletedIds }
 *
 * Stored entry (encrypted):
 *   { uuid, name, login, url, group, note,
 *     password, passwordIv, stringFieldsEnc, stringFieldsIv, totp, totpIv,
 *     createdAt, updatedAt }
 */

class VaultManager {
    constructor() {
        this.crypto = new CryptoManager();
        this.vault = null;
        this.plaintextEntries = new Map();
        this.onVaultSavedCallback = null;
        this.lastActivityWrite = 0;
    }

    setOnVaultSaved(callback) {
        this.onVaultSavedCallback = callback;
    }

    get isUnlocked() {
        return this.crypto.isUnlocked && this.vault !== null;
    }

    async createVault(masterPassword) {
        const { salt, masterHash } = await this.crypto.createMasterKey(masterPassword);

        this.vault = {
            version: VAULT_VERSION,
            salt,
            masterHash,
            entries: [],
            settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
            deletedIds: {}
        };

        await this.saveEncryptedVault();
        await this.saveSession();
    }

    // Assign uuids to legacy entries directly in the stored (encrypted) vault.
    // Must run BEFORE any sync/merge/decrypt so entries without a uuid never
    // get duplicated by the entry-level merge (uuid is the merge key).
    async repairVaultUuids() {
        const stored = await loadVaultFromStorage();
        if (!stored || !Array.isArray(stored.entries)) return false;
        let changed = false;
        for (const entry of stored.entries) {
            if (!entry || typeof entry.uuid !== 'string' || entry.uuid === '') {
                entry.uuid = generateId();
                changed = true;
            }
        }
        if (changed) {
            await saveVaultToStorage(stored);
        }
        return changed;
    }

    async unlockVault(masterPassword) {
        await this.repairVaultUuids();
        const stored = await loadVaultFromStorage();
        if (!stored) return false;

        const unlocked = await this.crypto.unlock(masterPassword, stored.salt, stored.masterHash);
        if (!unlocked) return false;

        this.vault = stored;
        await this.decryptAllEntries();
        await this.saveSession();

        return true;
    }

    async lockVault() {
        if (this.usageSaveTimer) {
            clearTimeout(this.usageSaveTimer);
            this.usageSaveTimer = null;
        }
        this.crypto.lock();
        this.vault = null;
        this.plaintextEntries.clear();
        await clearSessionData();
    }

    async decryptAllEntries() {
        if (!this.vault) return;
        this.plaintextEntries.clear();

        for (const entry of this.vault.entries) {
            try {
                const decrypted = await this.decryptEntry(entry);
                // uuid should always be present (repairVaultUuids runs on every load).
                this.plaintextEntries.set(decrypted.uuid, decrypted);
            } catch (e) {
                // Keep the entry without decrypting on failure (shouldn't happen normally)
                this.plaintextEntries.set(entry.uuid, this.toPlaintextEntry(entry));
            }
        }
    }

    async decryptEntry(stored) {
        const out = this.toPlaintextEntry(stored);
        if (stored.password && stored.passwordIv) {
            out.password = await this.crypto.decryptText({
                data: stored.password,
                iv: stored.passwordIv
            });
        }
        if (stored.stringFieldsEnc && stored.stringFieldsIv) {
            const raw = await this.crypto.decryptText({
                data: stored.stringFieldsEnc,
                iv: stored.stringFieldsIv
            });
            out.stringFields = JSON.parse(raw);
        }
        if (stored.totp && stored.totpIv) {
            out.totp = await this.crypto.decryptText({
                data: stored.totp,
                iv: stored.totpIv
            });
        }
        return out;
    }

    toPlaintextEntry(stored) {
        return {
            uuid: stored.uuid,
            name: stored.name || '',
            login: stored.login || '',
            url: stored.url || '',
            group: stored.group || '',
            note: stored.note || '',
            password: '',
            stringFields: [],
            totp: '',
            createdAt: stored.createdAt || Date.now(),
            updatedAt: stored.updatedAt || Date.now(),
            usageCount: stored.usageCount || 0,
            lastUsedAt: stored.lastUsedAt || 0
        };
    }

    async encryptEntry(plain) {
        const out = {
            uuid: plain.uuid,
            name: plain.name || '',
            login: plain.login || '',
            url: plain.url || '',
            group: plain.group || '',
            note: plain.note || '',
            createdAt: plain.createdAt,
            updatedAt: plain.updatedAt,
            usageCount: plain.usageCount || 0,
            lastUsedAt: plain.lastUsedAt || 0
        };
        if (plain.password) {
            const enc = await this.crypto.encryptText(plain.password);
            out.password = enc.data;
            out.passwordIv = enc.iv;
        }
        if (plain.stringFields && plain.stringFields.length > 0) {
            const enc = await this.crypto.encryptText(JSON.stringify(plain.stringFields));
            out.stringFieldsEnc = enc.data;
            out.stringFieldsIv = enc.iv;
        }
        if (plain.totp) {
            const enc = await this.crypto.encryptText(plain.totp);
            out.totp = enc.data;
            out.totpIv = enc.iv;
        }
        return out;
    }

    async saveEncryptedVault() {
        if (!this.vault) return;

        const encryptedEntries = [];
        for (const [ , entry ] of this.plaintextEntries) {
            encryptedEntries.push(await this.encryptEntry(entry));
        }

        await saveVaultToStorage({
            ...this.vault,
            entries: encryptedEntries
        });
        this.onVaultSavedCallback?.();
    }

    async saveSession() {
        if (!this.vault) return;
        const masterKey = await this.crypto.exportKey();
        const masterKeyHash = await this.crypto.getKeyFingerprint();
        if (!masterKey || !masterKeyHash) return;

        const session = {
            isUnlocked: true,
            lastActivity: Date.now(),
            vaultHash: this.vault.salt.slice(0, 16),
            masterKey,
            masterKeyHash
        };
        await saveSessionData(session);
    }

    async touchSession() {
        if (!this.vault) return;
        const now = Date.now();
        if (now - this.lastActivityWrite < 30000) return;
        this.lastActivityWrite = now;
        const session = await loadSessionData();
        if (session && session.isUnlocked) {
            await saveSessionData({ ...session, lastActivity: now });
        }
    }

    async restoreSession(session) {
        await this.repairVaultUuids();
        const stored = await loadVaultFromStorage();
        if (!stored || !session.masterKey || !session.masterKeyHash) return false;

        try {
            await this.crypto.importKey(session.masterKey, stored.salt);
            const fingerprint = await this.crypto.getKeyFingerprint();
            if (fingerprint !== session.masterKeyHash) {
                await this.crypto.lock();
                return false;
            }

            this.vault = stored;
            await this.decryptAllEntries();
            return true;
        } catch (e) {
            await this.crypto.lock();
            return false;
        }
    }

    async reloadFromStorage() {
        await this.repairVaultUuids();
        const stored = await loadVaultFromStorage();
        if (!stored) return false;
        this.vault = stored;
        if (this.crypto.isUnlocked) {
            await this.decryptAllEntries();
        }
        return true;
    }

    //--------------------------------------------------------------------------
    // Entry CRUD (plaintext)
    //--------------------------------------------------------------------------

    // Build a new plaintext entry from captured login credentials (content-script flow)
    newEntryFromCredentials(cred) {
        const hostname = (() => {
            try {
                return new URL(cred.url || 'about:blank').hostname;
            } catch (e) {
                return '';
            }
        })();
        const now = Date.now();
        return {
            uuid: generateId(),
            name: cred.name || (hostname || 'New entry'),
            login: cred.login || '',
            url: cred.url || '',
            group: cred.group || '',
            note: cred.note || '',
            password: cred.password || '',
            stringFields: cred.stringFields || [],
            totp: cred.totp || '',
            createdAt: now,
            updatedAt: now,
            usageCount: 0,
            lastUsedAt: 0
        };
    }

    async addEntry(entry) {
        if (!this.vault) throw new Error('Vault not initialized');
        console.log('[pwsave] addEntry:', JSON.stringify({
            uuid: entry.uuid, name: entry.name, login: entry.login, url: entry.url
        }));
        const existing = this.getAllEntries().find(
            e => e.name.toLowerCase() === (entry.name || '').toLowerCase()
        );
        if (existing) {
            await this.updateEntry(existing.uuid, { ...entry, uuid: existing.uuid });
            return;
        }
        this.plaintextEntries.set(entry.uuid, entry);
        await this.saveEncryptedVault();
    }

    async updateEntry(uuid, updates) {
        const existing = this.plaintextEntries.get(uuid);
        if (!existing) throw new Error('Entry not found');

        const cleanUpdates = {};
        for (const [ key, value ] of Object.entries(updates)) {
            if (value !== undefined) cleanUpdates[key] = value;
        }

        const updated = { ...existing, ...cleanUpdates, updatedAt: Date.now() };
        this.plaintextEntries.set(uuid, updated);
        await this.saveEncryptedVault();
    }

    // Lightweight usage bump (popup Popular/Recent sorts). Does NOT touch updatedAt
    // (that tracks content edits) and batches disk writes (max 1 per 5s).
    async bumpUsage(uuid) {
        const entry = this.plaintextEntries.get(uuid);
        if (!entry) return;
        const now = Date.now();
        entry.usageCount = (entry.usageCount || 0) + 1;
        entry.lastUsedAt = now;
        if (!this.usageSaveTimer) {
            this.usageSaveTimer = setTimeout(() => {
                this.usageSaveTimer = null;
                this.saveEncryptedVault().catch(() => { /* best effort */ });
            }, 5000);
        }
    }

    async deleteEntry(uuid) {
        console.log('[pwsave] deleteEntry called with uuid:', JSON.stringify(uuid));
        console.log('[pwsave] plaintextEntries has uuid:', this.plaintextEntries.has(uuid),
            '| total entries:', this.plaintextEntries.size);

        // Legacy entries stored without a uuid end up as key `undefined` in the Map.
        if (!uuid && this.plaintextEntries.has(undefined)) {
            this.plaintextEntries.delete(undefined);
            if (this.vault) {
                this.vault.entries = this.vault.entries.filter(e => !e.uuid);
                this.vault.deletedIds = { ...(this.vault.deletedIds || {}) };
            }
            await this.saveEncryptedVault();
            console.log('[pwsave] deleted legacy entry without uuid');
            return;
        }

        this.plaintextEntries.delete(uuid);
        if (this.vault) {
            this.vault.entries = this.vault.entries.filter(e => e.uuid !== uuid);
            this.vault.deletedIds = { ...(this.vault.deletedIds || {}), [uuid]: Date.now() };
        }
        await this.saveEncryptedVault();
        console.log('[pwsave] after delete, entries left:', this.plaintextEntries.size,
            '| vault entries:', this.vault ? this.vault.entries.length : 'null');
    }

    async clearAllEntries() {
        const now = Date.now();
        const deletedIds = {};
        for (const entry of this.plaintextEntries.values()) {
            deletedIds[entry.uuid] = now;
        }
        this.plaintextEntries.clear();
        if (this.vault) {
            this.vault.entries = [];
            // Keep tombstones so Drive sync drops the deleted entries instead of resurrecting them.
            this.vault.deletedIds = { ...(this.vault.deletedIds || {}), ...deletedIds };
        }
        await this.saveEncryptedVault();
        console.log('[pwsave] cleared all entries, tombstones:', Object.keys(this.vault ? this.vault.deletedIds : {}).length);
    }

    getAllEntries() {
        return Array.from(this.plaintextEntries.values());
    }

    getEntryByUuid(uuid) {
        return this.plaintextEntries.get(uuid);
    }

    // Hostname match: entry host === page host OR page host is a subdomain of entry host
    urlMatches(entryUrl, pageUrl) {
        if (!entryUrl) return false;
        try {
            const entryHost = new URL(entryUrl).hostname.toLowerCase();
            const pageHost = new URL(pageUrl).hostname.toLowerCase();
            return entryHost === pageHost || pageHost.endsWith('.' + entryHost);
        } catch (e) {
            return entryUrl.includes(pageUrl);
        }
    }

    getEntriesForUrl(url) {
        return this.getAllEntries().filter(e => this.urlMatches(e.url, url));
    }

    getEntriesForUrls(url, submitUrl) {
        return this.getAllEntries().filter(e =>
            this.urlMatches(e.url, url) || (submitUrl && this.urlMatches(e.url, submitUrl))
        );
    }

    searchEntries(query) {
        const lower = String(query).toLowerCase();
        return this.getAllEntries().filter(e =>
            (e.name || '').toLowerCase().includes(lower) ||
            (e.login || '').toLowerCase().includes(lower) ||
            (e.url || '').toLowerCase().includes(lower) ||
            (e.note || '').toLowerCase().includes(lower)
        );
    }

    // Content-script credential shape (decrypted)
    getCredentialsForUrl(url, submitUrl) {
        return this.getEntriesForUrls(url, submitUrl).map(e => ({
            uuid: e.uuid,
            login: e.login || '',
            name: e.name || '',
            password: e.password || '',
            url: e.url || '',
            group: e.group || '',
            stringFields: e.stringFields || [],
            totp: e.totp || ''
        }));
    }

    //--------------------------------------------------------------------------
    // TOTP (embedded in entries)
    //--------------------------------------------------------------------------

    async getTotpCode(uuid) {
        const entry = this.plaintextEntries.get(uuid);
        if (!entry || !entry.totp) return '';
        const parsed = parseOtpauthUri(entry.totp);
        if (!parsed) return '';
        const { code } = await generateTotpCode(parsed.secret, parsed.algorithm, parsed.digits, parsed.period);
        return code;
    }

    //--------------------------------------------------------------------------
    // Settings
    //--------------------------------------------------------------------------

    async getSettings() {
        if (!this.vault) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        return { ...DEFAULT_SETTINGS, ...this.vault.settings };
    }

    async updateSettings(settings) {
        if (!this.vault) throw new Error('Vault not initialized');
        if (settings && 'colorTheme' in settings) {
            settings.theme = settings.colorTheme;
        }
        if (settings && 'theme' in settings) {
            settings.colorTheme = settings.theme;
        }
        this.vault.settings = { ...this.vault.settings, ...settings };
        await this.saveEncryptedVault();
    }

    get getStoredSettings() {
        return loadVaultFromStorage().then(v => v ? { ...DEFAULT_SETTINGS, ...v.settings } : DEFAULT_SETTINGS);
    }

    //--------------------------------------------------------------------------
    // Master password / import / export
    //--------------------------------------------------------------------------

    async changeMasterPassword(currentPassword, newPassword) {
        if (!this.vault) return false;

        const unlocked = await this.crypto.unlock(currentPassword, this.vault.salt, this.vault.masterHash);
        if (!unlocked) return false;

        const { salt, masterHash } = await this.crypto.createMasterKey(newPassword);
        this.vault.salt = salt;
        this.vault.masterHash = masterHash;

        await this.saveEncryptedVault();
        await this.saveSession();

        return true;
    }

    async exportVault(format) {
        if (!this.vault) throw new Error('Vault not initialized');

        if (format === 'encrypted') {
            const stored = await loadVaultFromStorage();
            return JSON.stringify(stored);
        }

        const entries = this.getAllEntries();
        const header = 'name,url,login,password,note,group';
        const escape = function(s = '') {
            return '"' + String(s).replace(/"/g, '""') + '"';
        };
        const rows = entries.map(e =>
            [ escape(e.name), escape(e.url), escape(e.login), escape(e.password), escape(e.note), escape(e.group) ].join(',')
        );

        return [ header, ...rows ].join('\n');
    }

    async importEntries(entries) {
        for (const entry of entries) {
            const existing = (this.getEntriesForUrl(entry.url || '') || []).find(
                e => e.login === entry.login
            );
            if (existing) {
                await this.updateEntry(existing.uuid, { password: entry.password });
            } else {
                await this.addEntry(entry);
            }
        }
    }

    get vaultExists() {
        return loadVaultFromStorage().then(v => v !== null);
    }
}
