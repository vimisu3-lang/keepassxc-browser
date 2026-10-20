import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The helper is a plain script (like the other files loaded by the extension),
// so it is evaluated here instead of being imported as an ES module.
const kpxcTotpInput = (() => {
    const file = path.join(process.cwd(), 'keepassxc-browser', 'common', 'totp-input.js');
    const source = readFileSync(file, 'utf8');
    return new Function(`${source}; return kpxcTotpInput;`)();
})();

const TOTP_URI = 'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA256&digits=8&period=60';

describe('kpxcTotpInput', () => {
    it('accepts a plain Base32 secret and normalizes spaces and dashes', () => {
        const parsed = kpxcTotpInput.parse('jbsw y3dp-ehpk3pxp');
        expect(parsed).toEqual({ secret: 'JBSWY3DPEHPK3PXP', label: '', issuer: '', uri: '' });
    });

    it('removes the Base32 padding', () => {
        const parsed = kpxcTotpInput.parse('JBSWY3DPEHPK3PXP====');
        expect(parsed.secret).toBe('JBSWY3DPEHPK3PXP');
    });

    it('rejects invalid secrets', () => {
        expect(kpxcTotpInput.parse('')).toBeNull();
        expect(kpxcTotpInput.parse('short')).toBeNull();
        expect(kpxcTotpInput.parse('ABCDEFGH01234567')).toBeNull(); // 0, 1, 8 and 9 are not Base32
        expect(kpxcTotpInput.parse('https://example.com')).toBeNull();
    });

    it('parses an otpauth URI and keeps it intact', () => {
        const parsed = kpxcTotpInput.parse(TOTP_URI);
        expect(parsed.secret).toBe('JBSWY3DPEHPK3PXP');
        expect(parsed.label).toBe('alice');
        expect(parsed.issuer).toBe('Example');
        expect(parsed.uri).toBe(TOTP_URI);
    });

    it('rejects non-TOTP URIs', () => {
        expect(kpxcTotpInput.parse('otpauth://hotp/foo?secret=JBSWY3DPEHPK3PXP&counter=1')).toBeNull();
        expect(kpxcTotpInput.parse('otpauth://totp/foo')).toBeNull();
    });

    it('builds an otpauth URI from a secret and a label', () => {
        const parsed = kpxcTotpInput.parse('JBSWY3DPEHPK3PXP');
        expect(kpxcTotpInput.toUri(parsed, 'alice')).toBe('otpauth://totp/alice?secret=JBSWY3DPEHPK3PXP');
    });

    it('renames a parsed URI without losing its parameters', () => {
        const parsed = kpxcTotpInput.parse(TOTP_URI);
        const uri = kpxcTotpInput.toUri(parsed, 'bob');
        expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
        expect(uri).toContain('issuer=Example');
        expect(uri).toContain('algorithm=SHA256');
        expect(uri).toContain('digits=8');
        expect(uri).toContain('period=60');
        expect(decodeURIComponent(new URL(uri).pathname)).toBe('/bob');
    });

    it('keeps the original label when no fallback label is given', () => {
        const parsed = kpxcTotpInput.parse(TOTP_URI);
        expect(decodeURIComponent(new URL(kpxcTotpInput.toUri(parsed)).pathname)).toBe('/alice');
    });
});
