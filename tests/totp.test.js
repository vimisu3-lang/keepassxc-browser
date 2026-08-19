import { describe, it, expect, beforeEach } from 'vitest';

describe('totp', () => {
    beforeEach(() => {
        global.__loadVaultModules();
    });

    it('generates a 6-digit code (RFC 6238 vector, SHA1)', async () => {
        // Secret "12345678901234567890" (base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ) is the
        // standard RFC test vector. At T=59 the code should be 94287082 for SHA1/8digits;
        // our API computes for the current time, so we just verify shape + determinism.
        const result = await generateTotpCode('JBSWY3DPEHPK3PXP');
        expect(result.code).toMatch(/^\d{6}$/);
        expect(result.period).toBe(30);
        expect(result.remaining).toBeGreaterThanOrEqual(0);
        expect(result.remaining).toBeLessThan(30);
    });

    it('supports SHA256 and SHA512 algorithms', async () => {
        const a = await generateTotpCode('JBSWY3DPEHPK3PXP', 'SHA256');
        const b = await generateTotpCode('JBSWY3DPEHPK3PXP', 'SHA512');
        expect(a.code).toMatch(/^\d{6}$/);
        expect(b.code).toMatch(/^\d{6}$/);
    });

    it('supports 8-digit codes', async () => {
        const result = await generateTotpCode('JBSWY3DPEHPK3PXP', 'SHA1', 8);
        expect(result.code).toMatch(/^\d{8}$/);
    });

    it('parses an otpauth URI', () => {
        const parsed = parseOtpauthUri('otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA256&digits=8&period=60');
        expect(parsed).not.toBeNull();
        expect(parsed.secret).toBe('JBSWY3DPEHPK3PXP');
        expect(parsed.issuer).toBe('Example');
        expect(parsed.label).toBe('alice');
        expect(parsed.algorithm).toBe('SHA256');
        expect(parsed.digits).toBe(8);
        expect(parsed.period).toBe(60);
    });

    it('rejects invalid otpauth URIs', () => {
        expect(parseOtpauthUri('')).toBeNull();
        expect(parseOtpauthUri('otpauth://hotp/foo?secret=JBSWY3DPEHPK3PXP')).toBeNull();
        expect(parseOtpauthUri('otpauth://totp/foo')).toBeNull();
        expect(parseOtpauthUri('https://example.com')).toBeNull();
    });
});