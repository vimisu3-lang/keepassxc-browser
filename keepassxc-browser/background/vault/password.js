'use strict';

/**
 * Password generation + strength scoring. Ported from PWSave shared/password.ts
 */

const generatePassword = function(options) {
    const uppercaseChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lowercaseChars = 'abcdefghijklmnopqrstuvwxyz';
    const digitChars = '0123456789';
    const symbolChars = '!@#$%^&*()_+-=[]{}|;:,.<>?';
    const ambiguousChars = '0OIl1';

    const opts = Object.assign({}, DEFAULT_GENERATOR_SETTINGS, options || {});

    const withoutAmbiguous = function(chars) {
        let result = chars;
        if (opts.excludeAmbiguous) {
            for (const char of ambiguousChars) {
                result = result.replace(char, '');
            }
        }
        return result;
    };

    const allowedDigits = withoutAmbiguous(digitChars);
    const allowedSymbols = withoutAmbiguous(symbolChars);

    let allowedChars = '';
    if (opts.useLowercase) allowedChars += withoutAmbiguous(lowercaseChars);
    if (opts.useUppercase) allowedChars += withoutAmbiguous(uppercaseChars);
    if (opts.useNumbers) allowedChars += allowedDigits;
    if (opts.useSymbols) allowedChars += allowedSymbols;

    // Never return a broken password if every character set is disabled
    if (allowedChars.length === 0) {
        allowedChars = withoutAmbiguous(lowercaseChars);
    }

    const minDigits = opts.useNumbers ? Math.max(0, Math.min(opts.minDigits || 0, opts.length)) : 0;
    const minSymbols = opts.useSymbols ? Math.max(0, Math.min(opts.minSymbols || 0, opts.length - minDigits)) : 0;

    const getRandomChar = function(chars) {
        return chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
    };

    const passwordArray = [];
    for (let i = 0; i < minDigits; i++) {
        passwordArray.push(getRandomChar(allowedDigits));
    }
    for (let i = 0; i < minSymbols; i++) {
        passwordArray.push(getRandomChar(allowedSymbols));
    }

    while (passwordArray.length < opts.length) {
        passwordArray.push(getRandomChar(allowedChars));
    }

    for (let i = passwordArray.length - 1; i > 0; i--) {
        const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
        [ passwordArray[i], passwordArray[j] ] = [ passwordArray[j], passwordArray[i] ];
    }

    return passwordArray.join('');
};

const calculatePasswordStrength = function(password) {
    let score = 0;

    if (password.length >= 8) score += 20;
    if (password.length >= 12) score += 10;
    if (password.length >= 16) score += 10;
    if (password.length >= 20) score += 5;

    if (/[a-z]/.test(password)) score += 10;
    if (/[A-Z]/.test(password)) score += 10;
    if (/[0-9]/.test(password)) score += 10;
    if (/[^a-zA-Z0-9]/.test(password)) score += 10;

    const uniqueChars = new Set(password).size;
    if (uniqueChars >= 10) score += 5;
    if (uniqueChars >= 16) score += 5;
    if (uniqueChars >= 20) score += 5;

    return Math.min(100, score);
};
