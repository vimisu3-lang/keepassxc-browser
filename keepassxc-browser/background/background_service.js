'use strict';

try {
    importScripts(
        '../common/browser-polyfill.min.js',
        '../common/global.js',
        '../common/sites.js',
        'vault/constants.js',
        'vault/crypto-utils.js',
        'vault/storage-utils.js',
        'vault/totp.js',
        'vault/password.js',
        'vault/crypto-manager.js',
        'vault/merge-utils.js',
        'vault/import-utils.js',
        'vault/security-center.js',
        'vault/vault-manager.js',
        'vault/auto-lock.js',
        'vault/sync-manager.js',
        'keepass.js',
        'httpauth.js',
        'offscreen.js',
        'browserAction.js',
        'tabs.js',
        'page.js',
        'event.js',
        'vault/actions.js',
        'init.js'
    );
} catch (e) {
    console.log('Cannot import background scripts: ', e);
}
