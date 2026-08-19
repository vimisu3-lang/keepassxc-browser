'use strict';

// Global chrome stub + shared context used by the vault test suites.
// The vault modules rely on globals (crypto, chrome.storage, etc).
// We load the module source files directly into the same global scope that
// the test files use (they are plain scripts, not ES modules).

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

// Ensure crypto.randomUUID + subtle available in the node test context
const { webcrypto } = require('crypto');
Object.defineProperty(global, 'crypto', {
    value: webcrypto,
    writable: true,
    configurable: true
});

// --- in-memory chrome.storage implementation ---
const storageData = {
    local: {},
    session: {}
};

const makeStorageArea = (area) => ({
    async get(keys) {
        const out = {};
        const defaults = {};
        if (typeof keys === 'string') {
            defaults[keys] = undefined;
        } else if (Array.isArray(keys)) {
            for (const k of keys) defaults[k] = undefined;
        } else if (keys && typeof keys === 'object') {
            Object.assign(defaults, keys);
        }
        for (const [ k, v ] of Object.entries(defaults)) {
            out[k] = (k in storageData[area]) ? storageData[area][k] : v;
        }
        return out;
    },
    async set(items) {
        Object.assign(storageData[area], items);
    },
    async remove(keys) {
        const list = Array.isArray(keys) ? keys : [ keys ];
        for (const k of list) delete storageData[area][k];
    },
    async clear() {
        storageData[area] = {};
    }
});

global.chrome = {
    storage: {
        local: makeStorageArea('local'),
        session: makeStorageArea('session'),
        onChanged: { addListener() {} }
    },
    runtime: {
        onMessage: { addListener() {} },
        onStartup: { addListener() {} },
        lastError: null,
        getURL: (p) => p,
        openPopup: async () => {}
    },
    tabs: { onActivated: { addListener() {} } },
    alarms: {
        onAlarm: { addListener() {} },
        create() {},
        clear() {}
    },
    identity: {
        getAuthToken: async () => ({ token: 'test-token' }),
        removeCachedAuthToken: async () => {},
        clearAllCachedAuthTokens: async () => {}
    },
    action: {
        openPopup: async () => {}
    }
};

// Load the vault modules into the global scope in dependency order.
// The files use top-level `const`/`class` which would be function-scoped by
// `new Function`, so we transform `const X =` / `class X {` declarations into
// globalThis assignments. The modules only reference each other through
// globals (no imports), so this is safe.
const loadModule = (rel) => {
    const file = path.join(__dirname, '..', 'keepassxc-browser', 'background', rel);
    const src = fs.readFileSync(file, 'utf8');
    const transformed = src
        .replace(/^(const|let|var)\s+(var|const|let)\s/g, '$1 $2')
        .replace(/^(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, 'globalThis.$2 =')
        .replace(/^class\s+([A-Za-z_$][\w$]*)/gm, 'globalThis.$1 = class $1');
    const fn = new Function(transformed);
    fn.call(global);
};

global.__loadVaultModules = function() {
    loadModule('vault/constants.js');
    loadModule('vault/crypto-utils.js');
    loadModule('vault/storage-utils.js');
    loadModule('vault/totp.js');
    loadModule('vault/password.js');
    loadModule('vault/crypto-manager.js');
    loadModule('vault/merge-utils.js');
    loadModule('vault/import-utils.js');
    loadModule('vault/security-center.js');
    loadModule('vault/vault-manager.js');
    loadModule('vault/auto-lock.js');
    loadModule('vault/sync-manager.js');
};

global.__storageData = storageData;