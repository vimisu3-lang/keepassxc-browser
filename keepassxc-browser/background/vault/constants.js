'use strict';

// Vault / crypto constants (ported from PWSave)
const PBKDF2_ITERATIONS = 600000;
const SALT_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 12;
const KEY_BYTE_LENGTH = 256;
const TAG_LENGTH = 128;
const HASH_ALGORITHM = 'SHA-256';

// Storage keys
const VAULT_STORAGE_KEY = 'pwsave_vault';
const SESSION_STORAGE_KEY = 'pwsave_session';
const SYNC_STORAGE_KEY = 'pwsave_sync_state';
const SYNC_BACKUP_KEY = 'pwsave_sync_backups';

// Sync settings
const SYNC_DRIVE_FILE_NAME = 'pwsave-vault.json';
const SYNC_PUSH_DEBOUNCE_MS = 2000;
const SYNC_PULL_INTERVAL_MS = 5 * 60 * 1000;
const SYNC_BACKUP_KEEP = 3;
const SYNC_HISTORY_PREFIX = 'pwsave-vault.history.';
const SYNC_HISTORY_KEEP = 10;

// Auto-lock default: 1 hour
const DEFAULT_AUTO_LOCK_TIMEOUT = 3600000;

const VAULT_VERSION = 1;

// Generator defaults (for new vaults)
const DEFAULT_GENERATOR_SETTINGS = {
    length: 20,
    useUppercase: true,
    useLowercase: true,
    useNumbers: true,
    useSymbols: true,
    excludeAmbiguous: false,
    minDigits: 1,
    minSymbols: 1
};

const DEFAULT_SETTINGS = {
    autoLockTimeout: DEFAULT_AUTO_LOCK_TIMEOUT,
    autoFillEnabled: true,
    autoSaveEnabled: true,
    clipboardClearDelay: 30000,
    theme: 'system',
    colorTheme: 'system',
    passwordGeneratorDefaults: DEFAULT_GENERATOR_SETTINGS,
    language: 'en'
};
