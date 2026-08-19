'use strict';

const kpxcEvent = {};

kpxcEvent.onMessage = async function(request, sender) {
    if (!request || !request.action) {
        return undefined;
    }

    // New vault/sync messages (popup & options). vaultActions is created by init.js
    // synchronously at module load, so it is always defined before any message arrives.
    if (typeof vaultActions !== 'undefined' && request.action in vaultActions) {
        if (!Object.hasOwn(sender, 'tab') || sender?.tab?.id < 1) {
            sender.tab = {};
            sender.tab.id = tabs.currentTabId;
        }
        return await vaultActions[request.action](sender.tab, request.args);
    }

    if (request.action in kpxcEvent.messageHandlers) {
        if (!Object.hasOwn(sender, 'tab') || sender?.tab?.id < 1) {
            sender.tab = {};
            sender.tab.id = tabs.currentTabId;
        }

        return await kpxcEvent.messageHandlers[request.action](sender.tab, request.args);
    }
};

kpxcEvent.showStatus = async function(_tab, configured, internalPoll, forceShowDefault = false) {
    keepass.syncStatus();

    let keyId = null;
    if (configured && keepass.databaseHash !== '') {
        keyId = 'vault';
    }

    if (!internalPoll || forceShowDefault) {
        browserAction.showDefault(_tab);
    }

    const currentTab = tabs.getTabFromId(_tab.id);
    const errorMessage = currentTab?.errorMessage ?? undefined;
    const usernameFieldDetected = currentTab?.usernameFieldDetected ?? false;
    const iframeDetected = currentTab?.iframeDetected ?? false;

    return {
        associated: keepass.isAssociated(),

        configured: configured,
        databaseClosed: keepass.isDatabaseClosed,
        encryptionKeyUnrecognized: keepass.isEncryptionKeyUnrecognized,
        error: errorMessage,
        iframeDetected: iframeDetected,
        identifier: keyId,
        keePassXCAvailable: keepass.isKeePassXCAvailable,
        showGettingStartedGuideAlert: page.settings.showGettingStartedGuideAlert,
        showTroubleshootingGuideAlert: page.settings.showTroubleshootingGuideAlert,
        usernameFieldDetected: usernameFieldDetected
    };
};

kpxcEvent.onLoadSettings = async function() {
    return await page.initSettings().catch((err) => {
        logError('onLoadSettings error: ' + err);
        return Promise.reject();
    });
};

kpxcEvent.onSaveSettings = async function(tab, settings) {
    browser.storage.local.set({ 'settings': settings });
    // Keep the vault settings in sync (colorTheme alias lives in vault settings).
    if (typeof vaultManager !== 'undefined' && settings && 'colorTheme' in settings) {
        try {
            await vaultManager.updateSettings({ colorTheme: settings.colorTheme });
        } catch (err) {
            logError('onSaveSettings vault sync error: ' + err);
        }
    }
    kpxcEvent.onLoadSettings(tab);
};

kpxcEvent.onGetStatus = async function(tab, args = []) {
    try {
        const [ internalPoll = false, triggerUnlock = false, forceShowDefault ] = args;
        if (!internalPoll) {
            const response = await keepass.testAssociation(tab, [ true, triggerUnlock ]);
            if (!response) {
                return kpxcEvent.showStatus(tab, false);
            }
        }

        const configured = await keepass.isConfigured();
        return kpxcEvent.showStatus(tab, configured, internalPoll, forceShowDefault);
    } catch (err) {
        logError('No status shown: ' + err);
        return Promise.reject();
    }
};

kpxcEvent.onReconnect = async function(tab) {
    const configured = await keepass.reconnect(tab);
    if (configured) {
        browser.tabs.sendMessage(tab?.id, {
            action: 'redetect_fields'
        }).catch((err) => {
            logError(err);
            return;
        });
    }

    return kpxcEvent.showStatus(tab, configured);
};

kpxcEvent.lockDatabase = async function(tab) {
    try {
        await keepass.lockDatabase(tab);
        return kpxcEvent.showStatus(tab, false);
    } catch (err) {
        logError('kpxcEvent.lockDatabase error: ' + err);
        return false;
    }
};

kpxcEvent.onGetTabInformation = async function(tab) {
    const id = tab?.id || tabs.currentTabId;
    return tabs.getTabFromId(id);
};

kpxcEvent.onGetConnectedDatabase = async function() {
    keepass.syncStatus();
    return Promise.resolve({
        count: keepass.isKeePassXCAvailable ? 1 : 0,
        identifier: keepass.isKeePassXCAvailable ? 'vault' : null
    });
};

kpxcEvent.onRemoveCredentialsFromTabInformation = async function(tab) {
    const id = tab?.id || tabs.currentTabId;
    page.clearCredentials(id);
    page.clearSubmittedCredentials();
};

kpxcEvent.onLoginPopup = async function(tab, logins) {
    const popupData = {
        iconType: 'normal',
        popup: 'popup_login'
    };

    if (tab?.id) {
        tabs.updateTabValues(tab?.id, { loginList: logins });
        await browserAction.show(tab, popupData);
    }
};

kpxcEvent.initHttpAuth = async function() {
    httpAuth.init();
};

kpxcEvent.onHTTPAuthPopup = async function(tab, data) {
    const popupData = {
        iconType: 'normal',
        popup: 'popup_httpauth'
    };

    tabs.updateTabValues(tab?.id, { basicAuthLogins: data });
    await browserAction.show(tab, popupData);
};

kpxcEvent.onUsernameFieldDetected = async function(tab, detected) {
    tabs.updateTabValues(tab?.id, { usernameFieldDetected: detected });
};

kpxcEvent.onIframeDetected = async function(tab, detected) {
    tabs.updateTabValues(tab?.id, { iframeDetected: detected });
};

kpxcEvent.passwordGetFilled = async function() {
    return page.passwordFilled;
};

kpxcEvent.passwordSetFilled = async function(tab, state) {
    page.passwordFilled = state;
};

kpxcEvent.getColorTheme = async function(tab) {
    return page.settings.colorTheme;
};

kpxcEvent.pageGetRedirectCount = async function() {
    return page.redirectCount;
};

kpxcEvent.pageClearLogins = async function(tab, alreadyCalled) {
    if (!alreadyCalled && tab?.id) {
        page.clearLogins(tab.id);
    }
};

kpxcEvent.getIsKeePassXCAvailable = async function() {
    keepass.syncStatus();
    // "Connected" means the vault is unlocked and ready to fill.
    return keepass.isConnected;
};

// Chromium-only extension (MV3). Content uses this to branch Firefox-specific code.
kpxcEvent.getIsFirefox = async function() {
    return false;
};

// Bounce message back to all frames
kpxcEvent.sendBackToTabs = async function(tab, args = []) {
    if (tab?.id) {
        await browser.tabs.sendMessage(tab.id, { action: 'frame_message', args: args });
    }
};

// All methods named in this object have to be declared BEFORE this!
kpxcEvent.messageHandlers = {
    'add_credentials': keepass.addCredentials,
    'associate': keepass.associate,
    'banner_get_position': page.getBannerPosition,
    'banner_set_position': page.setBannerPosition,
    'check_database_hash': keepass.checkDatabaseHash,
    'create_new_group': keepass.createNewGroup,
    'disable_automatic_reconnect': keepass.disableAutomaticReconnect,
    'enable_automatic_reconnect': keepass.enableAutomaticReconnect,
    'fill_http_auth': page.fillHttpAuth,
    'frame_message': kpxcEvent.sendBackToTabs,
    'generate_password': keepass.generatePassword,
    'get_color_theme': kpxcEvent.getColorTheme,
    'get_connected_database': kpxcEvent.onGetConnectedDatabase,
    'get_database_groups': keepass.getDatabaseGroups,
    'get_database_hash': keepass.getDatabaseHash,
    'get_error_message': keepass.getErrorMessage,
    'get_login_list': page.getLoginList,
    'get_status': kpxcEvent.onGetStatus,
    'get_tab_information': kpxcEvent.onGetTabInformation,
    'get_totp': keepass.getTotp,
    'iframe_detected': kpxcEvent.onIframeDetected,
    'init_http_auth': kpxcEvent.initHttpAuth,
    'is_connected': kpxcEvent.getIsKeePassXCAvailable,
    'is_firefox': kpxcEvent.getIsFirefox,
    'is_iframe_allowed': page.isIframeAllowed,
    'is_site_ignored': page.isSiteIgnored,
    'load_settings': kpxcEvent.onLoadSettings,
    'lock_database': kpxcEvent.lockDatabase,
    'page_clear_logins': kpxcEvent.pageClearLogins,
    'page_clear_submitted': page.clearSubmittedCredentials,
    'page_get_autosubmit_performed': page.getAutoSubmitPerformed,
    'page_get_login_id': page.getLoginId,
    'page_get_manual_fill': page.getManualFill,
    'page_get_redirect_count': kpxcEvent.pageGetRedirectCount,
    'page_get_submitted': page.getSubmitted,
    'page_set_allow_iframes': page.setAllowIframes,
    'page_set_autosubmit_performed': page.setAutoSubmitPerformed,
    'page_set_login_id': page.setLoginId,
    'page_set_manual_fill': page.setManualFill,
    'page_set_submitted': page.setSubmitted,
    'password_get_filled': kpxcEvent.passwordGetFilled,
    'password_set_filled': kpxcEvent.passwordSetFilled,
    'popup_login': kpxcEvent.onLoginPopup,
    'reconnect': kpxcEvent.onReconnect,
    'remove_credentials_from_tab_information': kpxcEvent.onRemoveCredentialsFromTabInformation,
    'reset_all_settings': page.resetAllSettings,
    'retrieve_credentials': page.retrieveCredentials,
    'save_settings': kpxcEvent.onSaveSettings,
    'show_default_browseraction': browserAction.showDefault,
    'update_credentials': keepass.updateCredentials,
    'update_context_menu': page.updateContextMenu,
    'update_popup': page.updatePopup,
    'username_field_detected': kpxcEvent.onUsernameFieldDetected
};
