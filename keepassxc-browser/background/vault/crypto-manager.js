'use strict';

/**
 * CryptoManager - owns the derived AES key + salt. Ported from PWSave.
 */

class CryptoManager {
    constructor() {
        this.derivedKey = null;
        this.salt = null;
    }

    async createMasterKey(masterPassword) {
        const salt = generateSalt();
        const masterHash = await hashForVerification(masterPassword, salt);

        this.salt = salt;
        this.derivedKey = await deriveKey(masterPassword, salt, true);

        return {
            salt: bufferToBase64(salt.buffer),
            masterHash
        };
    }

    async unlock(masterPassword, storedSalt, storedHash) {
        try {
            const salt = new Uint8Array(base64ToBuffer(storedSalt));
            const computedHash = await hashForVerification(masterPassword, salt);

            if (computedHash !== storedHash) {
                return false;
            }

            this.salt = salt;
            this.derivedKey = await deriveKey(masterPassword, salt, true);
            return true;
        } catch (e) {
            return false;
        }
    }

    async exportKey() {
        if (!this.derivedKey) return null;
        const raw = await crypto.subtle.exportKey('raw', this.derivedKey);
        return bufferToBase64(raw);
    }

    async getKeyFingerprint() {
        if (!this.derivedKey) return null;
        const raw = await crypto.subtle.exportKey('raw', this.derivedKey);
        const digest = await crypto.subtle.digest('SHA-256', raw);
        return bufferToBase64(digest);
    }

    async importKey(rawKeyBase64, saltBase64) {
        const raw = base64ToBuffer(rawKeyBase64);
        this.derivedKey = await crypto.subtle.importKey(
            'raw',
            raw,
            { name: 'AES-GCM' },
            true,
            [ 'encrypt', 'decrypt' ]
        );
        this.salt = new Uint8Array(base64ToBuffer(saltBase64));
    }

    async encryptText(plaintext) {
        if (!this.derivedKey || !this.salt) {
            throw new Error('Vault is locked');
        }
        const { ciphertext, iv } = await encryptData(plaintext, this.derivedKey);
        return {
            data: bufferToBase64(ciphertext),
            iv: bufferToBase64(iv.buffer)
        };
    }

    async decryptText(encrypted) {
        if (!this.derivedKey) {
            throw new Error('Vault is locked');
        }
        const ciphertext = base64ToBuffer(encrypted.data);
        const iv = new Uint8Array(base64ToBuffer(encrypted.iv));
        return decryptData(ciphertext, iv, this.derivedKey);
    }

    lock() {
        this.derivedKey = null;
        this.salt = null;
    }

    get isUnlocked() {
        return this.derivedKey !== null;
    }
}
