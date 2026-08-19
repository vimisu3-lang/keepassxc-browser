'use strict';

//--------------------------------------------------------------------------
// Manager singletons (created synchronously at module load)
//--------------------------------------------------------------------------

const vaultManager = new VaultManager();
const autoLockManager = new AutoLockManager();
const syncManager = new SyncManager(vaultManager);
const securityCenter = new SecurityCenter();

autoLockManager.setOnLock(async () => {
    await vaultManager.lockVault();
    keepass.syncStatus();
    keepass.updateDatabaseHashToContent();
});

autoLockManager.setOnActivity(() => {
    void vaultManager.touchSession();
});

vaultManager.setOnVaultSaved(() => syncManager.schedulePush());

// New message handlers used by the popup/options
const vaultActions = createVaultActions({
    vaultManager,
    autoLockManager,
    syncManager,
    securityCenter,
    waitForInit: () => initReadyPromise
});

//--------------------------------------------------------------------------
// Message listener MUST be registered synchronously (before any async init),
// otherwise a cold service worker misses popup messages during init.
//--------------------------------------------------------------------------

browser.runtime.onMessage.addListener(kpxcEvent.onMessage);

// Session restore gate: popups must not see the vault as "locked" while the
// session-restore phase of init() is still running.
let initReady = () => {};
const initReadyPromise = new Promise((resolve) => {
    initReady = resolve;
});

async function init() {
    const session = await loadSessionData();
    if (session && session.isUnlocked && session.masterKey) {
        const settings = await vaultManager.getStoredSettings;
        const elapsed = Date.now() - session.lastActivity;
        if (elapsed < settings.autoLockTimeout) {
            const restored = await vaultManager.restoreSession(session);
            if (restored) {
                keepass.syncStatus();
                autoLockManager.setTimeout(settings.autoLockTimeout);
                autoLockManager.startTimer(settings.autoLockTimeout - elapsed);
                initReady();
                void syncManager.init();
                return;
            }
            console.warn('[pwsave] session restore failed (fingerprint/tampered)');
        } else {
            console.warn(
                `[pwsave] session expired: elapsed=${Math.round(elapsed / 60000)}min timeout=${Math.round(settings.autoLockTimeout / 60000)}min`
            );
        }
        await clearSessionData();
    }
    keepass.syncStatus();
    initReady();
    void syncManager.init();
}

chrome.runtime.onStartup.addListener(async () => {
    await clearSessionData();
});

chrome.tabs.onActivated.addListener(() => {
    autoLockManager.onActivity();
});

chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[SESSION_STORAGE_KEY];
    if (area === 'session' && change && change.oldValue && !change.newValue) {
        console.warn(
            '[pwsave] session cleared in-session',
            new Error('session cleared').stack
        );
    }
});

//--------------------------------------------------------------------------
// Context menu + commands + webNavigation listeners (non-critical path)
//--------------------------------------------------------------------------

const contextMenuItems = [
    { title: tr('contextMenuFillUsernameAndPassword'), action: 'fill_username_password' },
    { title: tr('contextMenuFillPassword'), action: 'fill_password' },
    { title: tr('contextMenuFillTOTP'), action: 'fill_totp' },
    { title: tr('contextMenuShowPasswordGenerator'), action: 'show_password_generator' },
    { title: tr('contextMenuSaveCredentials'), action: 'save_credentials' }
];

const initListeners = function() {
    browser.webNavigation.onCommitted.addListener((details) => {
        if (details.transitionQualifiers?.[0] === 'client_redirect' || details.transitionType === 'form_submit') {
            page.redirectCount += 1;
            return;
        }

        // Clear credentials on reload so a new retrieval can be made
        if (details.transitionType === 'reload') {
            page.clearLogins(details.tabId);
        }

        page.redirectCount = 0;
    });

    browser.commands.onCommand.addListener(async (command) => {
        if (contextMenuItems.some(e => e.action === command)
            || command === 'redetect_fields'
            || command === 'choose_credential_fields'
            || command === 'retrieve_credentials_forced'
            || command === 'lock_database'
            || command === 'reload_extension') {
            const tab = await getCurrentTab();
            if (tab?.id) {
                browser.tabs.sendMessage(tab.id, { action: command });
            }
        }
    });

    browser.contextMenus.onClicked.addListener(async (_item, tab) => {
        if (!tab?.id) {
            return;
        }

        browser.tabs.sendMessage(tab.id, {
            action: _item.menuItemId
        }, {
            frameId: _item.frameId
        }).catch((err) => {
            logError(err);
        });
    });

    browser.runtime.onInstalled.addListener((details) => {
        if (details?.reason === 'install') {
            browser.tabs.create({
                url: 'options/getting_started.html',
            });
        }
    });
};

const initContextMenuItems = async function() {
    page.menuContexts = [ 'editable' ];

    // Remove any old attribute items
    page.attributeMenuItems.forEach(item => {
        browser.contextMenus.remove(item?.action);
    });
    page.attributeMenuItems = [];

    await browser.contextMenus.removeAll();
    for (const item of contextMenuItems) {
        try {
            await browser.contextMenus.create({
                title: item.title,
                contexts: page.menuContexts,
                visible: item.visible,
                id: item.id || item.action
            });
        } catch (e) {
            logError(e);
        }
    }
};

(async () => {
    try {
        await page.initBrowser();
        await page.initSettings();
        await page.initSitePreferences();
        await tabs.initOpenedTabs();
        await tabs.initListeners();
        initListeners();
        await initContextMenuItems();
        await httpAuth.init();
        await init();
    } catch (e) {
        logError(`init.js failed: ${e}`);
    }
})();
