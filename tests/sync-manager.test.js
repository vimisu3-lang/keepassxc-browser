import { describe, it, expect, beforeEach } from 'vitest';

describe('sync-manager', () => {
    beforeEach(async () => {
        global.__loadVaultModules();
        global.__storageData.local = {};
        global.__storageData.session = {};
        global.chrome.identity.getAuthToken = async () => ({ token: 'test-token' });
        global.fetch = undefined;
    });

    it('syncNow does nothing when not connected', async () => {
        const vm = new VaultManager();
        await vm.createVault('pw');
        const sm = new SyncManager(vm);
        const state = await sm.syncNow();
        expect(state.connected).toBe(false);
    });

    it('pushes the local vault to Drive when no remote exists', async () => {
        const vm = new VaultManager();
        await vm.createVault('pw');
        const entry = vm.newEntryFromCredentials({ login: 'a', password: 'p', url: 'https://x.com' });
        await vm.addEntry(entry);
        const sm = new SyncManager(vm);

        // Fake Drive: no file exists
        const uploaded = [];
        global.fetch = async (url, opts) => {
            if (url.includes('/files?uploadType=multipart') && opts.method === 'POST') {
                uploaded.push({ body: opts.body });
                return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'file1', modifiedTime: '2026-01-01T00:00:00.000Z' }) };
            }
            if (url.includes('/files?') && !url.includes('upload')) {
                return { ok: true, status: 200, text: async () => JSON.stringify({ files: [] }) };
            }
            throw new Error('unexpected url ' + url);
        };

        // connect first
        const state = await sm.setup();
        expect(state.connected).toBe(true);
        expect(uploaded).toHaveLength(1);
        // The uploaded body must contain the encrypted vault but NOT the plaintext password
        expect(uploaded[0].body).toContain('pwsave-vault.json');
        expect(uploaded[0].body).not.toContain('"password":"p"');
    });

    it('pulls the remote vault when local does not exist', async () => {
        const vm = new VaultManager();
        const sm = new SyncManager(vm);

        const remoteVault = {
            version: 1, salt: 'salt', masterHash: 'hash', entries: [], settings: {}, deletedIds: {}
        };
        global.fetch = async (url) => {
            if (url.includes('/files?') && !url.includes('upload') && !url.includes('alt=media')) {
                return { ok: true, status: 200, text: async () => JSON.stringify({ files: [ { id: 'file1', name: 'pwsave-vault.json', modifiedTime: '2026-01-01T00:00:00.000Z' } ] }) };
            }
            if (url.includes('alt=media')) {
                return { ok: true, status: 200, text: async () => JSON.stringify(remoteVault) };
            }
            if (url.includes('/about?')) {
                return { ok: true, status: 200, text: async () => JSON.stringify({ user: { emailAddress: 'a@b.com' } }) };
            }
            throw new Error('unexpected url ' + url);
        };

        await sm.setup();
        const vault = await loadVaultFromStorage();
        expect(vault).not.toBeNull();
        expect(vault.salt).toBe('salt');
    });

    it('handles 401 by refreshing the token', async () => {
        const vm = new VaultManager();
        await vm.createVault('pw');
        const sm = new SyncManager(vm);

        let callCount = 0;
        global.fetch = async (url, opts) => {
            if (url.includes('/files?') && !url.includes('upload')) {
                callCount++;
                if (callCount === 1) {
                    return { ok: false, status: 401, text: async () => '' };
                }
                return { ok: true, status: 200, text: async () => JSON.stringify({ files: [] }) };
            }
            if (url.includes('/files?uploadType=multipart')) {
                return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'file1', modifiedTime: '2026-01-01T00:00:00.000Z' }) };
            }
            throw new Error('unexpected url ' + url);
        };
        let refreshCount = 0;
        global.chrome.identity.getAuthToken = async () => { refreshCount++; return { token: 'fresh-token' }; };

        await sm.setup();
        expect(refreshCount).toBeGreaterThanOrEqual(2);
    });
});