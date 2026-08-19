import { describe, it, expect, beforeEach } from 'vitest';

describe('vault-manager', () => {
    beforeEach(async () => {
        global.__loadVaultModules();
        global.__storageData.local = {};
        global.__storageData.session = {};
    });

    it('creates a vault and unlocks it with the correct password', async () => {
        const vm = new VaultManager();
        await vm.createVault('masterpw');

        expect(vm.isUnlocked).toBe(true);
        expect(await vm.vaultExists).toBe(true);

        await vm.lockVault();
        expect(vm.isUnlocked).toBe(false);

        const unlocked = await vm.unlockVault('masterpw');
        expect(unlocked).toBe(true);
        expect(vm.isUnlocked).toBe(true);
    });

    it('rejects the wrong master password', async () => {
        const vm = new VaultManager();
        await vm.createVault('masterpw');
        await vm.lockVault();
        const unlocked = await vm.unlockVault('wrong');
        expect(unlocked).toBe(false);
        expect(vm.isUnlocked).toBe(false);
    });

    it('URL matching works in both directions with subdomains', () => {
        const vm = new VaultManager();
        vm.plaintextEntries.set('1', { uuid: '1', name: 'A', login: 'a', url: 'https://a.com' });

        // Same host
        expect(vm.urlMatches('https://a.com', 'https://a.com/dashboard')).toBe(true);
        // Entry on base domain, page on subdomain
        expect(vm.urlMatches('https://a.com', 'https://login.a.com')).toBe(true);
        expect(vm.urlMatches('https://a.com', 'https://web.a.com')).toBe(true);
        expect(vm.urlMatches('https://a.com', 'https://www.a.com')).toBe(true);
        // Entry on subdomain, page on base domain (reverse direction)
        expect(vm.urlMatches('https://login.a.com', 'https://a.com')).toBe(true);
        expect(vm.urlMatches('https://web.a.com', 'https://a.com')).toBe(true);
        expect(vm.urlMatches('https://www.a.com', 'https://a.com')).toBe(true);
        // Bare hostname entry without scheme
        expect(vm.urlMatches('a.com', 'https://login.a.com')).toBe(true);
        // Subdomain to subdomain (same base domain)
        expect(vm.urlMatches('https://login.a.com', 'https://web.a.com')).toBe(true);
        expect(vm.urlMatches('https://b.a.com', 'https://c.a.com')).toBe(true);
        // Multi-label 2nd-level domains
        expect(vm.urlMatches('https://a.co.uk', 'https://b.a.co.uk')).toBe(true);
        expect(vm.urlMatches('https://a.com.au', 'https://www.a.com.au')).toBe(true);

        // Negative cases
        expect(vm.urlMatches('https://a.com', 'https://a.evil.com')).toBe(false);
        expect(vm.urlMatches('https://a.com', 'https://b.com')).toBe(false);
        expect(vm.urlMatches('https://b.a.com', 'https://a.b.com')).toBe(false);
        expect(vm.urlMatches('https://a.com', 'https://a.com.au')).toBe(false);
        expect(vm.urlMatches('https://a.com.au', 'https://a.com')).toBe(false);
        expect(vm.urlMatches('not a url', 'https://a.com')).toBe(false);
        expect(vm.urlMatches('', 'https://a.com')).toBe(false);
        expect(vm.urlMatches('https://a.com', '')).toBe(false);
    });

    it('stores and retrieves an entry, with password encrypted at rest', async () => {
        const vm = new VaultManager();
        await vm.createVault('pw');

        const entry = vm.newEntryFromCredentials({
            login: 'alice', password: 's3cret', url: 'https://example.com/login', name: 'Example'
        });
        await vm.addEntry(entry);

        const all = vm.getAllEntries();
        expect(all).toHaveLength(1);
        expect(all[0].password).toBe('s3cret');

        // The stored vault must NOT contain the plaintext password
        const stored = await loadVaultFromStorage();
        expect(JSON.stringify(stored)).not.toContain('s3cret');

        // URL matching works
        const matches = vm.getEntriesForUrl('https://example.com/dashboard');
        expect(matches).toHaveLength(1);
        expect(vm.getEntriesForUrl('https://other.com')).toHaveLength(0);
    });

    it('updates and deletes an entry, recording a tombstone', async () => {
        const vm = new VaultManager();
        await vm.createVault('pw');
        const entry = vm.newEntryFromCredentials({ login: 'a', password: 'p', url: 'https://x.com' });
        await vm.addEntry(entry);

        await vm.updateEntry(entry.uuid, { password: 'newpass' });
        expect(vm.getEntryByUuid(entry.uuid).password).toBe('newpass');

        await vm.deleteEntry(entry.uuid);
        expect(vm.getAllEntries()).toHaveLength(0);
        const stored = await loadVaultFromStorage();
        expect(stored.deletedIds[entry.uuid]).toBeTypeOf('number');
    });

    it('session restore works across manager instances', async () => {
        const vm = new VaultManager();
        await vm.createVault('pw');
        const entry = vm.newEntryFromCredentials({ login: 'a', password: 'p', url: 'https://x.com' });
        await vm.addEntry(entry);

        // Simulate SW restart: create a fresh manager and restore from storage.session
        const vm2 = new VaultManager();
        const session = await loadSessionData();
        expect(session).toBeTruthy();
        const restored = await vm2.restoreSession(session);
        expect(restored).toBe(true);
        expect(vm2.isUnlocked).toBe(true);
        expect(vm2.getAllEntries()[0].password).toBe('p');
    });

    it('rejects a tampered session (fingerprint mismatch)', async () => {
        const vm = new VaultManager();
        await vm.createVault('pw');
        const session = await loadSessionData();
        session.masterKeyHash = 'tampered';
        const vm2 = new VaultManager();
        const restored = await vm2.restoreSession(session);
        expect(restored).toBe(false);
        expect(vm2.isUnlocked).toBe(false);
    });

    it('TOTP embedded in entry: generates a code', async () => {
        const vm = new VaultManager();
        await vm.createVault('pw');
        const entry = vm.newEntryFromCredentials({ login: 'a', password: 'p', url: 'https://x.com' });
        entry.totp = 'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example';
        await vm.addEntry(entry);

        const code = await vm.getTotpCode(entry.uuid);
        expect(code).toMatch(/^\d{6}$/);
    });
});