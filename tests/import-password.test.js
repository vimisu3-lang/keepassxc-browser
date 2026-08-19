import { describe, it, expect, beforeEach } from 'vitest';

describe('import-utils + password', () => {
    beforeEach(() => {
        global.__loadVaultModules();
        global.__storageData.local = {};
        global.__storageData.session = {};
    });

    it('parses CSV entries (quoted fields + escaped quotes)', () => {
        const csv = [
            'name,url,login,password,note,group',
            '"My ""Site""",https://site.com,alice,secret123,"A note","work"',
            'Other,https://other.com,bob,pw456,,home'
        ].join('\n');
        const entries = parseImportedEntries('csv', csv);
        expect(entries).toHaveLength(2);
        expect(entries[0].name).toBe('My "Site"');
        expect(entries[0].login).toBe('alice');
        expect(entries[0].password).toBe('secret123');
        expect(entries[0].group).toBe('work');
    });

    it('parses JSON array entries', () => {
        const data = JSON.stringify([
            { name: 'A', url: 'https://a.com', username: 'u', password: 'p' }
        ]);
        const entries = parseImportedEntries('json', data);
        expect(entries).toHaveLength(1);
        expect(entries[0].login).toBe('u');
        expect(entries[0].password).toBe('p');
    });

    it('parses a full vault object (entries array)', () => {
        const data = JSON.stringify({ version: 1, salt: 's', masterHash: 'h', entries: [ { name: 'B', url: 'https://b.com', password: 'x' } ] });
        const entries = parseImportedEntries('json', data);
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe('B');
    });

    it('returns empty array for invalid data', () => {
        expect(parseImportedEntries('csv', 'name,url\nonly-header')).toHaveLength(0);
        expect(parseImportedEntries('json', 'not json')).toHaveLength(0);
        expect(parseImportedEntries('json', '{}')).toHaveLength(0);
    });

    it('generates passwords matching the requested options', () => {
        const password = generatePassword({ length: 16, useUppercase: true, useLowercase: true, useNumbers: true, useSymbols: true, excludeAmbiguous: false, minDigits: 2, minSymbols: 2 });
        expect(password).toHaveLength(16);
        expect(/[0-9]/.test(password)).toBe(true);
        expect(/[^a-zA-Z0-9]/.test(password)).toBe(true);
    });

    it('calculates password strength', () => {
        expect(calculatePasswordStrength('password')).toBeLessThan(50);
        expect(calculatePasswordStrength('Str0ng!Passw0rd')).toBeGreaterThanOrEqual(70);
    });
});