'use strict';

/**
 * SyncManager - Google Drive (appDataFolder) sync of the already-encrypted vault.
 * Ported from PWSave background/sync-manager.ts
 *
 * - Push debounced 2s after every vault save (setOnVaultSaved -> schedulePush)
 * - Pull every 5 min via chrome.alarms
 * - Entry-level merge on conflict; incompatible vaults fall back to LWW + history snapshot
 * - History snapshots before every overwrite (keep newest SYNC_HISTORY_KEEP on Drive)
 * - Never-synced local vault never wins over an existing remote
 * - Errors: AUTH_REQUIRED / AUTH_FAILED / NETWORK / INVALID_REMOTE
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SYNC_ALARM = 'pwsave-sync-pull';

const EMPTY_SYNC_STATE = { initialized: false, connected: false, error: null };

class SyncManager {
    constructor(vaultManager) {
        this.vaultManager = vaultManager;
        this.pushTimer = null;
        this.syncing = false;
        this.syncQueued = false;

        chrome.alarms.onAlarm.addListener((alarm) => {
            if (alarm.name === SYNC_ALARM) {
                this.syncNow().catch(() => undefined);
            }
        });
    }

    async init() {
        const state = await this.getStatus();
        if (!state.connected) return;
        this.startPeriodicPull();
        await this.syncNow();
    }

    startPeriodicPull() {
        chrome.alarms.create(SYNC_ALARM, {
            periodInMinutes: SYNC_PULL_INTERVAL_MS / 60000
        });
    }

    stopPeriodicPull() {
        chrome.alarms.clear(SYNC_ALARM);
    }

    async getStatus() {
        return (await loadSyncState()) || { ...EMPTY_SYNC_STATE };
    }

    async setup() {
        try {
            const token = await this.getToken(true);
            const account = await this.fetchAccountEmail(token);
            const previous = await this.getStatus();
            await saveSyncState({
                initialized: true,
                connected: true,
                account,
                error: null,
                driveFileId: previous.driveFileId,
                lastSyncedAt: previous.lastSyncedAt,
                lastKnownModifiedTime: previous.lastKnownModifiedTime,
                lastLocalSaveAt: previous.lastLocalSaveAt
            });
            this.startPeriodicPull();
            await this.syncNow();
            return await this.getStatus();
        } catch (error) {
            const detail = error instanceof Error && error.message ? error.message : 'AUTH_FAILED';
            console.error('[pwsave] sync setup failed:', detail);
            const state = await this.getStatus();
            await saveSyncState({
                ...state,
                initialized: true,
                connected: false,
                error: detail
            });
            return await this.getStatus();
        }
    }

    async disable() {
        this.stopPeriodicPull();
        await this.vaultManager.lockVault();
        await chrome.storage.local.remove([ VAULT_STORAGE_KEY, SYNC_STORAGE_KEY, SYNC_BACKUP_KEY ]);
        await clearSessionData();
        try {
            await chrome.identity.clearAllCachedAuthTokens();
        } catch (e) {
            // ignore
        }
    }

    schedulePush() {
        if (this.pushTimer) clearTimeout(this.pushTimer);
        this.pushTimer = setTimeout(() => {
            this.pushTimer = null;
            this.syncNow().catch(() => undefined);
        }, SYNC_PUSH_DEBOUNCE_MS);
        void this.getStatus().then((state) => {
            const next = { ...state, lastLocalSaveAt: Date.now() };
            return saveSyncState(next);
        });
    }

    async syncNow() {
        const state = await this.getStatus();
        if (!state.connected) return state;
        if (this.syncing) {
            this.syncQueued = true;
            return state;
        }
        this.syncing = true;
        try {
            let token;
            try {
                token = await this.getToken(false);
            } catch (e) {
                await saveSyncState({ ...state, error: 'AUTH_REQUIRED' });
                return await this.getStatus();
            }

            try {
                await this.performSync(token, state);
            } catch (error) {
                await saveSyncState({
                    ...state,
                    error: error instanceof Error ? error.message : 'NETWORK'
                });
            }
        } finally {
            this.syncing = false;
            if (this.syncQueued) {
                this.syncQueued = false;
                void this.syncNow();
            }
        }
        return await this.getStatus();
    }

    async performSync(token, state) {
        const remote = await this.findRemoteFile(token);
        const localVault = await loadVaultFromStorage();

        if (!remote) {
            if (localVault) {
                const uploaded = await this.uploadVault(token, localVault, undefined);
                await this.markSynced(uploaded);
            }
            return;
        }

        if (!localVault) {
            await this.downloadAndApply(token, remote.id);
            await this.markSynced(remote);
            return;
        }

        const remoteChanged =
            !state.lastKnownModifiedTime ||
            remote.modifiedTime !== state.lastKnownModifiedTime;
        const localChanged =
            !!state.lastLocalSaveAt &&
            (!state.lastSyncedAt || state.lastLocalSaveAt > state.lastSyncedAt);

        if (!state.lastSyncedAt) {
            await this.backupLocal();
            await this.saveToHistory(token, JSON.stringify(localVault));
            await this.downloadAndApply(token, remote.id);
            await this.markSynced(remote);
            return;
        }

        if (remoteChanged && localChanged) {
            const merged = await this.tryMerge(token, remote, state, localVault);
            if (merged) {
                await saveVaultToStorage(merged);
                if (this.vaultManager.isUnlocked) {
                    await this.vaultManager.reloadFromStorage();
                }
                const uploaded = await this.uploadVault(token, merged, remote.id);
                await this.markSynced(uploaded);
                return;
            }
            const remoteMs = new Date(remote.modifiedTime).getTime();
            if (remoteMs > (state.lastLocalSaveAt || 0)) {
                await this.backupLocal();
                await this.saveToHistory(token, JSON.stringify(localVault));
                await this.downloadAndApply(token, remote.id);
                await this.markSynced(remote);
            } else {
                const remoteContent = await this.fetchWithAuth(
                    token,
                    `${DRIVE_API}/files/${remote.id}?alt=media`
                );
                await this.pushBackup({ at: Date.now(), vault: remoteContent });
                await this.saveToHistory(token, remoteContent);
                const uploaded = await this.uploadVault(token, localVault, remote.id);
                await this.markSynced(uploaded);
            }
        } else if (remoteChanged) {
            await this.downloadAndApply(token, remote.id);
            await this.markSynced(remote);
        } else if (localChanged) {
            const uploaded = await this.uploadVault(token, localVault, remote.id);
            await this.markSynced(uploaded);
        } else {
            await this.markSynced(remote);
        }
    }

    async tryMerge(token, remote, state, local) {
        let remoteVault;
        try {
            const content = await this.fetchWithAuth(
                token,
                `${DRIVE_API}/files/${remote.id}?alt=media`
            );
            remoteVault = this.parseVault(content);
        } catch (e) {
            return null;
        }
        const settingsSource =
            new Date(remote.modifiedTime).getTime() > (state.lastLocalSaveAt || 0)
                ? 'remote'
                : 'local';
        return mergeVaults(local, remoteVault, settingsSource);
    }

    async markSynced(remote) {
        const state = await this.getStatus();
        await saveSyncState({
            ...state,
            lastSyncedAt: Date.now(),
            lastKnownModifiedTime: remote.modifiedTime,
            ...(remote.id ? { driveFileId: remote.id } : {}),
            error: null
        });
    }

    async downloadAndApply(token, fileId) {
        const content = await this.fetchWithAuth(
            token,
            `${DRIVE_API}/files/${fileId}?alt=media`
        );
        const parsed = this.parseVault(content);
        await saveVaultToStorage(parsed);
        if (this.vaultManager.isUnlocked) {
            await this.vaultManager.reloadFromStorage();
        }
    }

    async uploadVault(token, vault, fileId) {
        const metadata = fileId
            ? {}
            : { name: SYNC_DRIVE_FILE_NAME, parents: [ 'appDataFolder' ] };
        const url = fileId
            ? `${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=multipart`
            : `${DRIVE_UPLOAD_API}/files?uploadType=multipart`;
        const method = fileId ? 'PATCH' : 'POST';

        const boundary = `pwsave-${Math.random().toString(36).slice(2)}`;
        const body = [
            `--${boundary}`,
            'Content-Type: application/json; charset=UTF-8',
            '',
            JSON.stringify(metadata),
            `--${boundary}`,
            'Content-Type: application/json; charset=UTF-8',
            '',
            JSON.stringify(vault),
            `--${boundary}--`,
            ''
        ].join('\r\n');

        const response = await this.fetchWithAuth(token, url, {
            method,
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
            body
        });

        let parsed;
        try {
            parsed = JSON.parse(response);
        } catch (e) {
            throw new Error('NETWORK');
        }
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof parsed.id !== 'string' ||
            typeof parsed.modifiedTime !== 'string'
        ) {
            throw new Error('NETWORK');
        }
        return parsed;
    }

    async findRemoteFile(token) {
        const query = encodeURIComponent(
            `name='${SYNC_DRIVE_FILE_NAME}' and trashed=false`
        );
        const response = await this.fetchWithAuth(
            token,
            `${DRIVE_API}/files?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime)`
        );
        let parsed;
        try {
            parsed = JSON.parse(response);
        } catch (e) {
            throw new Error('NETWORK');
        }
        const files = (parsed && parsed.files) || [];
        return files[0] || null;
    }

    async fetchAccountEmail(token) {
        try {
            const response = await this.fetchWithAuth(
                token,
                `${DRIVE_API}/about?fields=user`
            );
            const parsed = JSON.parse(response);
            return parsed && parsed.user ? parsed.user.emailAddress : undefined;
        } catch (e) {
            return undefined;
        }
    }

    async fetchWithAuth(token, url, init = {}) {
        const response = await fetch(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(init.headers || {})
            }
        });
        if (response.status === 401) {
            try {
                await chrome.identity.removeCachedAuthToken({ token });
                const fresh = await this.getToken(false);
                const retry = await fetch(url, {
                    ...init,
                    headers: {
                        Authorization: `Bearer ${fresh}`,
                        ...(init.headers || {})
                    }
                });
                if (retry.status === 401) {
                    throw new Error('AUTH_REQUIRED');
                }
                if (!retry.ok) {
                    throw new Error('NETWORK');
                }
                return retry.text();
            } catch (error) {
                if (error instanceof Error && error.message === 'AUTH_REQUIRED') {
                    throw error;
                }
                throw new Error('NETWORK');
            }
        }
        if (!response.ok) {
            throw new Error('NETWORK');
        }
        return response.text();
    }

    async getToken(interactive) {
        try {
            // Promise form: resolves with GetAuthTokenResult {token?, grantedScopes?}
            const result = await chrome.identity.getAuthToken({ interactive });
            if (!result || !result.token) {
                throw new Error(interactive ? 'AUTH_FAILED' : 'AUTH_REQUIRED');
            }
            return result.token;
        } catch (error) {
            const message =
                error instanceof Error && error.message
                    ? error.message
                    : interactive ? 'AUTH_FAILED' : 'AUTH_REQUIRED';
            console.error('[pwsave] getAuthToken failed:', message);
            throw new Error(message);
        }
    }

    parseVault(content) {
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            throw new Error('INVALID_REMOTE');
        }
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof parsed.version !== 'number' ||
            typeof parsed.salt !== 'string' ||
            typeof parsed.masterHash !== 'string' ||
            !Array.isArray(parsed.entries)
        ) {
            throw new Error('INVALID_REMOTE');
        }
        return parsed;
    }

    async backupLocal() {
        const vault = await loadVaultFromStorage();
        if (!vault) return;
        await this.pushBackup({ at: Date.now(), vault: JSON.stringify(vault) });
    }

    async pushBackup(backup) {
        const backups = await loadSyncBackups();
        backups.push(backup);
        await saveSyncBackups(backups.slice(-SYNC_BACKUP_KEEP));
    }

    async listHistory(token) {
        const auth = token || (await this.getToken(false));
        const query = encodeURIComponent(
            `name contains '${SYNC_HISTORY_PREFIX}' and trashed=false`
        );
        const response = await this.fetchWithAuth(
            auth,
            `${DRIVE_API}/files?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime)&orderBy=createdTime desc`
        );
        let parsed;
        try {
            parsed = JSON.parse(response);
        } catch (e) {
            throw new Error('NETWORK');
        }
        return ((parsed && parsed.files) || []).filter(f =>
            f.name.startsWith(SYNC_HISTORY_PREFIX)
        );
    }

    async restoreHistory(fileId) {
        const token = await this.getToken(false);
        const content = await this.fetchWithAuth(
            token,
            `${DRIVE_API}/files/${fileId}?alt=media`
        );
        const vault = this.parseVault(content);
        await saveVaultToStorage(vault);
        if (this.vaultManager.isUnlocked) {
            await this.vaultManager.reloadFromStorage();
        }
        await saveSyncState({
            ...(await this.getStatus()),
            lastLocalSaveAt: Date.now(),
            lastSyncedAt: Date.now() - 1,
            error: null
        });
        void this.syncNow();
        return true;
    }

    async saveToHistory(token, content) {
        try {
            const name = `${SYNC_HISTORY_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            const url = `${DRIVE_UPLOAD_API}/files?uploadType=multipart`;
            const boundary = `pwsave-${Math.random().toString(36).slice(2)}`;
            const body = [
                `--${boundary}`,
                'Content-Type: application/json; charset=UTF-8',
                '',
                JSON.stringify({ name, parents: [ 'appDataFolder' ] }),
                `--${boundary}`,
                'Content-Type: application/json; charset=UTF-8',
                '',
                content,
                `--${boundary}--`,
                ''
            ].join('\r\n');
            await this.fetchWithAuth(token, url, {
                method: 'POST',
                headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
                body
            });
            await this.pruneHistory(token);
        } catch (e) {
            // best effort - a failed history snapshot must not block the sync
        }
    }

    async pruneHistory(token) {
        let items;
        try {
            items = await this.listHistory(token);
        } catch (e) {
            return;
        }
        if (items.length <= SYNC_HISTORY_KEEP) return;
        for (const item of items.slice(SYNC_HISTORY_KEEP)) {
            try {
                await this.fetchWithAuth(token, `${DRIVE_API}/files/${item.id}`, {
                    method: 'DELETE'
                });
            } catch (e) {
                // ignore individual delete failures
            }
        }
    }
}
