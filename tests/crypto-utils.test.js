import { describe, it, expect, beforeEach } from 'vitest';

describe('crypto-utils', () => {
    beforeEach(() => {
        global.__loadVaultModules();
    });

    it('encrypts and decrypts a string', async () => {
        const key = await deriveKey('test-password', new Uint8Array(32), true);
        const plaintext = 'hello world';
        const { ciphertext, iv } = await encryptData(plaintext, key);
        const decrypted = await decryptData(ciphertext, iv, key);
        expect(decrypted).toBe(plaintext);
    });

    it('uses a different IV for the same plaintext (randomized IV)', async () => {
        const key = await deriveKey('test-password', new Uint8Array(32), true);
        const a = await encryptData('same', key);
        const b = await encryptData('same', key);
        expect(bufferToBase64(a.ciphertext)).not.toBe(bufferToBase64(b.ciphertext));
    });

    it('fails to decrypt with a wrong key', async () => {
        const key = await deriveKey('test-password', new Uint8Array(32), true);
        const wrongKey = await deriveKey('wrong-password', new Uint8Array(32), true);
        const { ciphertext, iv } = await encryptData('secret', key);
        await expect(decryptData(ciphertext, iv, wrongKey)).rejects.toThrow();
    });

    it('base64 round-trips', () => {
        const bytes = new Uint8Array([ 0, 1, 2, 255, 128, 42 ]);
        expect(new Uint8Array(base64ToBuffer(bufferToBase64(bytes.buffer)))).toEqual(bytes);
    });

    it('hashForVerification is deterministic for same input', async () => {
        const salt = new Uint8Array(32).fill(7);
        const a = await hashForVerification('pw', salt);
        const b = await hashForVerification('pw', salt);
        expect(a).toBe(b);
    });

    it('hashForVerification differs for different passwords', async () => {
        const salt = new Uint8Array(32).fill(7);
        const a = await hashForVerification('pw', salt);
        const b = await hashForVerification('pw2', salt);
        expect(a).not.toBe(b);
    });
});