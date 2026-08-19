'use strict';

/**
 * TOTP (RFC 6238) helpers. Ported from PWSave shared/totp.ts
 * Uses WebCrypto HMAC (SHA-1/256/512) and supports otpauth://totp parsing.
 */

const base32Decode = function(encoded) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleaned = String(encoded).toUpperCase().replace(/[^A-Z2-7]/g, '');

    const bytes = [];
    let buffer = 0;
    let bitsLeft = 0;

    for (const char of cleaned) {
        const value = alphabet.indexOf(char);
        if (value === -1) continue;

        buffer = (buffer << 5) | value;
        bitsLeft += 5;

        if (bitsLeft >= 8) {
            bitsLeft -= 8;
            bytes.push((buffer >> bitsLeft) & 0xff);
            buffer &= (1 << bitsLeft) - 1;
        }
    }

    return new Uint8Array(bytes);
};

const hmacName = function(algorithm) {
    const upper = String(algorithm).toUpperCase();
    if (upper === 'SHA256' || upper === 'SHA-256') return 'SHA-256';
    if (upper === 'SHA512' || upper === 'SHA-512') return 'SHA-512';
    return 'SHA-1';
};

const generateTotpCode = async function(secret, algorithm = 'SHA1', digits = 6, period = 30) {
    const epoch = Math.floor(Date.now() / 1000);
    const counter = Math.floor(epoch / period);
    const remaining = period - (epoch % period);

    const keyBytes = base32Decode(secret);
    const counterBuffer = new ArrayBuffer(8);
    const counterView = new DataView(counterBuffer);
    counterView.setBigUint64(0, BigInt(counter), false);

    const key = await crypto.subtle.importKey(
        'raw',
        keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength),
        { name: 'HMAC', hash: hmacName(algorithm) },
        false,
        [ 'sign' ]
    );
    const signature = await crypto.subtle.sign('HMAC', key, counterBuffer);
    const hmac = new Uint8Array(signature);

    const offset = hmac[hmac.length - 1] & 0xf;
    const binaryCode =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);

    const otp = binaryCode % Math.pow(10, digits);
    const code = otp.toString().padStart(digits, '0');

    return { code, remaining, period };
};

const parseOtpauthUri = function(uri) {
    if (!uri || typeof uri !== 'string') return null;

    let parsed;
    try {
        parsed = new URL(uri);
    } catch (e) {
        return null;
    }

    if (parsed.protocol !== 'otpauth:' || parsed.hostname.toLowerCase() !== 'totp') return null;

    const secret = parsed.searchParams.get('secret');
    if (!secret) return null;

    let rawLabel;
    try {
        rawLabel = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    } catch (e) {
        return null;
    }
    const issuerParam = (parsed.searchParams.get('issuer') || '').trim();

    let label = rawLabel;
    let issuer = issuerParam;
    if (issuer && label.toLowerCase().startsWith(issuer.toLowerCase() + ':')) {
        label = label.slice(issuer.length + 1);
    } else if (!issuer && rawLabel.includes(':')) {
        const idx = rawLabel.indexOf(':');
        issuer = rawLabel.slice(0, idx).trim();
        label = rawLabel.slice(idx + 1).trim();
    }

    const algorithmRaw = (parsed.searchParams.get('algorithm') || 'SHA1').toUpperCase();
    let algorithm = 'SHA1';
    if (algorithmRaw === 'SHA256' || algorithmRaw === 'SHA-256') algorithm = 'SHA256';
    else if (algorithmRaw === 'SHA512' || algorithmRaw === 'SHA-512') algorithm = 'SHA512';

    const digitsRaw = Number(parsed.searchParams.get('digits') || 6);
    const digits = digitsRaw === 8 ? 8 : 6;

    const periodRaw = Number(parsed.searchParams.get('period') || 30);
    const period = Number.isFinite(periodRaw) && periodRaw > 0 ? periodRaw : 30;

    return { label, issuer, secret, algorithm, digits, period };
};
