'use strict';

const browserActionWrapper = browser.action || browser.browserAction;
const browserAction = {};

browserAction.show = async function(tab, popupData) {
    popupData ??= page.popupData;
    page.popupData = popupData;

    browserActionWrapper.setIcon({
        path: await browserAction.generateIconName(popupData.iconType)
    });

    const currentTab = tabs.getTabFromId(tab?.id);

    // Standalone vault manager: the toolbar popup is always the vault UI.
    // The login list is only shown when the content script opens popup_login.html
    // via the inline username icon.
    if (popupData.popup === 'popup_login') {
        browserAction.setBadgeText(tab?.id, currentTab?.loginList.length);
    } else if (popupData.popup === 'popup_httpauth') {
        // HTTP Basic Auth with multiple logins still needs the selection popup
        browserActionWrapper.setPopup({
            tabId: tab.id,
            popup: 'popups/popup_httpauth.html'
        });
        browserAction.setBadgeText(tab?.id, currentTab?.basicAuthLogins?.loginList?.length);
    }
};

browserAction.showDefault = async function(tab) {
    const popupData = {
        iconType: 'normal',
        popup: 'popup'
    };

    const response = await keepass.isConfigured().catch((err) => {
        logError('Cannot show default popup: ' + err);
    });

    if (!response && !keepass.isKeePassXCAvailable) {
        popupData.iconType = 'cross';
    } else if (!keepass.isAssociated() && !keepass.isDatabaseClosed) {
        popupData.iconType = 'bang';
    } else if (keepass.isKeePassXCAvailable && keepass.isDatabaseClosed) {
        popupData.iconType = 'locked';
    }

    // Get the current tab if no tab given
    tab ??= await getCurrentTab();
    if (!tab) {
        return;
    }

    const currentTab = tabs.getTabFromId(tab?.id);
    if (currentTab?.loginList.length > 0) {
        popupData.iconType = 'normal';
        browserAction.setBadgeText(tab?.id, currentTab?.loginList.length);
    }

    // No pending HTTP auth challenge -> restore the vault popup
    if (!currentTab?.basicAuthLogins?.resolve) {
        browserActionWrapper.setPopup({
            tabId: tab.id,
            popup: 'popups/popup.html'
        });
    }

    await browserAction.show(tab, popupData);
};

browserAction.setBadgeText = function(tabId, badgeText) {
    if (!tabId) {
        return;
    }

    browserActionWrapper.setBadgeBackgroundColor({ color: '#666666' });
    browserActionWrapper.setBadgeText({ text: String(badgeText), tabId: tabId });
};

browserAction.generateIconName = async function(iconType) {
    let name = 'icon_';
    name += (await keepass.keePassXCUpdateAvailable()) ? 'new_' : '';
    name += (!iconType || iconType === 'normal') ? 'normal' : iconType;

    let style = 'colored';
    if (page?.settings?.useMonochromeToolbarIcon) {
        if (page.settings.colorTheme === 'system') {
            style = await retrieveColorScheme();
        } else {
            style = page.settings.colorTheme;
        }
    }
    const filetype = (page.isFirefox || page.isSafari) ? 'svg' : 'png';
    return `/icons/toolbar/${style}/${name}.${filetype}`;
};

browserAction.ignoreSite = async function(url) {
    await browser.windows.getCurrent();
    const tab = await getCurrentTab();

    // Send the message to the current tab's content script
    if (tab?.id) {
        browser.tabs.sendMessage(tab.id, {
            action: 'ignore_site',
            args: [ url ]
        });
    }
};
