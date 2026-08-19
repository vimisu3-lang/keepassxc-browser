import { describe, it, expect, beforeEach } from 'vitest';

describe('merge-utils', () => {
    beforeEach(() => {
        global.__loadVaultModules();
        global.__storageData.local = {};
        global.__storageData.session = {};
    });

    const makeEntry = (uuid, updatedAt, password = 'p') => ({
        uuid, name: uuid, login: uuid, password, url: `https://${uuid}.com`,
        stringFields: [], totp: '', createdAt: updatedAt, updatedAt, group: '', note: ''
    });

    const makeVault = (entries, deletedIds = {}) => ({
        version: 1, salt: 'salt', masterHash: 'hash', entries, settings: {}, deletedIds
    });

    it('merges two vaults by uuid (union)', () => {
        const local = makeVault([ makeEntry('a', 100), makeEntry('b', 100) ]);
        const remote = makeVault([ makeEntry('b', 100), makeEntry('c', 100) ]);
        const merged = mergeVaults(local, remote, 'local');
        expect(merged).not.toBeNull();
        expect(merged.entries.map(e => e.uuid).sort()).toEqual([ 'a', 'b', 'c' ]);
    });

    it('keeps the newer entry on conflict', () => {
        const local = makeVault([ makeEntry('a', 200, 'local-pass') ]);
        const remote = makeVault([ makeEntry('a', 300, 'remote-pass') ]);
        const merged = mergeVaults(local, remote, 'local');
        expect(merged.entries[0].password).toBe('remote-pass');
    });

    it('returns null for incompatible vaults (different salt)', () => {
        const local = makeVault([ makeEntry('a', 100) ]);
        local.salt = 'salt1';
        const remote = makeVault([ makeEntry('b', 100) ]);
        remote.salt = 'salt2';
        expect(mergeVaults(local, remote, 'local')).toBeNull();
    });

    it('applies tombstones: deleted entry is dropped', () => {
        const local = makeVault([ makeEntry('a', 100) ], { a: 150 });
        const remote = makeVault([ makeEntry('a', 100) ]);
        const merged = mergeVaults(local, remote, 'local');
        expect(merged.entries).toHaveLength(0);
    });

    it('resurrects an entry updated after deletion (tombstone removed)', () => {
        const local = makeVault([ makeEntry('a', 200) ], { a: 150 });
        const remote = makeVault([ makeEntry('a', 100) ]);
        const merged = mergeVaults(local, remote, 'local');
        expect(merged.entries.map(e => e.uuid)).toEqual([ 'a' ]);
        expect(merged.deletedIds.a).toBeUndefined();
    });

    it('picks the settings source from the argument', () => {
        const local = makeVault([]);
        local.settings = { theme: 'local' };
        const remote = makeVault([]);
        remote.settings = { theme: 'remote' };
        const merged = mergeVaults(local, remote, 'remote');
        expect(merged.settings.theme).toBe('remote');
    });
});