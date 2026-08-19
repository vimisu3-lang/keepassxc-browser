'use strict';

/**
 * WebCrypto helpers for the vault (AES-256-GCM + PBKDF2 600k iterations).
 * Ported from PWSave shared/crypto-utils.ts
 */

const bufferToBase64 = function(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
};

const base64ToBuffer = function(str) {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
};

const generateSalt = function() {
    return crypto.getRandomValues(new Uint8Array(SALT_BYTE_LENGTH));
};

const generateIv = function() {
    return crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
};

const deriveKey = async function(masterPassword, salt, extractable = false) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(masterPassword),
        'PBKDF2',
        false,
        [ 'deriveKey' ]
    );

    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt.buffer,
            iterations: PBKDF2_ITERATIONS,
            hash: HASH_ALGORITHM
        },
        keyMaterial,
        {
            name: 'AES-GCM',
            length: KEY_BYTE_LENGTH
        },
        extractable,
        [ 'encrypt', 'decrypt' ]
    );
};

const encryptData = async function(plaintext, key, iv) {
    const encoder = new TextEncoder();
    const usedIv = iv || generateIv();

    const ciphertext = await crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv: usedIv.buffer,
            tagLength: TAG_LENGTH
        },
        key,
        encoder.encode(plaintext)
    );

    return { ciphertext, iv: usedIv };
};

const decryptData = async function(ciphertext, iv, key) {
    const decrypted = await crypto.subtle.decrypt(
        {
            name: 'AES-GCM',
            iv: iv.buffer,
            tagLength: TAG_LENGTH
        },
        key,
        ciphertext
    );

    return new TextDecoder().decode(decrypted);
};

const hashForVerification = async function(masterPassword, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(masterPassword),
        'PBKDF2',
        false,
        [ 'deriveBits' ]
    );

    const hash = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: salt.buffer,
            iterations: PBKDF2_ITERATIONS,
            hash: HASH_ALGORITHM
        },
        keyMaterial,
        256
    );

    return bufferToBase64(hash);
};

const generateId = function() {
    return crypto.randomUUID();
};
