'use strict';

/**
 * Helper for handling 2FA (TOTP) input. Used by the popup and the options page.
 * Accepts a plain Base32 secret or a complete otpauth:// URI (e.g. scanned from a QR code).
 */
const kpxcTotpInput = {};

// Removes spaces, dashes and Base32 padding from a secret
kpxcTotpInput.normalizeSecret = function(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/[\s-]/g, '')
        .replace(/=+$/, '');
};

// A TOTP secret should be at least 80 bits (16 Base32 characters)
kpxcTotpInput.isSecret = function(value) {
    return /^[A-Z2-7]{16,128}$/.test(kpxcTotpInput.normalizeSecret(value));
};

// Splits a TOTP label (Issuer:account) the same way as the background parser
const splitTotpLabel = function(rawLabel, issuerParam) {
    let label = rawLabel;
    let issuer = issuerParam;

    if (issuer && label.toLowerCase().startsWith(issuer.toLowerCase() + ':')) {
        label = label.slice(issuer.length + 1);
    } else if (!issuer && rawLabel.includes(':')) {
        const idx = rawLabel.indexOf(':');
        issuer = rawLabel.slice(0, idx).trim();
        label = rawLabel.slice(idx + 1).trim();
    }

    return { label, issuer };
};

// Parses a Base32 secret or an otpauth:// URI.
// Returns { secret, label, issuer, uri } or null when the input is not valid TOTP data.
kpxcTotpInput.parse = function(value) {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }

    if (/^otpauth:/i.test(text)) {
        let parsed;
        try {
            parsed = new URL(text);
        } catch {
            return null;
        }

        if (parsed.protocol !== 'otpauth:' || parsed.hostname.toLowerCase() !== 'totp') {
            return null;
        }

        const secret = kpxcTotpInput.normalizeSecret(parsed.searchParams.get('secret') || '');
        if (!kpxcTotpInput.isSecret(secret)) {
            return null;
        }

        let rawLabel = '';
        try {
            rawLabel = decodeURIComponent(parsed.pathname.replace(/^\//, '')).trim();
        } catch {
            return null;
        }

        const issuerParam = (parsed.searchParams.get('issuer') || '').trim();
        const { label, issuer } = splitTotpLabel(rawLabel, issuerParam);
        return { secret, label, issuer, uri: text };
    }

    if (!kpxcTotpInput.isSecret(text)) {
        return null;
    }

    return { secret: kpxcTotpInput.normalizeSecret(text), label: '', issuer: '', uri: '' };
};

// Builds a storable otpauth:// URI. A URI that was given as input is preserved as-is,
// so the non-default parameters (algorithm, digits, period) are not lost.
kpxcTotpInput.toUri = function(parsed, fallbackLabel) {
    if (!parsed || !parsed.secret) {
        return '';
    }

    const label = (String(fallbackLabel || '').trim() || parsed.label || parsed.issuer || 'TOTP').trim();

    if (parsed.uri) {
        try {
            const url = new URL(parsed.uri);
            url.pathname = '/' + encodeURIComponent(label);
            return url.toString();
        } catch {
            return parsed.uri;
        }
    }

    return `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(parsed.secret)}`;
};
