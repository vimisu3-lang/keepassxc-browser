'use strict';

HTMLElement.prototype.show = function() {
    this.style.display = 'block';
};

HTMLElement.prototype.hide = function() {
    this.style.display = 'none';
};

const applyTheme = function(theme = 'system') {
    document.documentElement.setAttribute('data-bs-theme', theme === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : theme);
};

const loadColorTheme = async function() {
    let theme = 'system';
    try {
        const response = await browser.runtime.sendMessage({ action: 'pwsave_get_settings' });
        theme = response?.data?.colorTheme || response?.data?.theme || 'system';
    } catch (err) {
        theme = 'system';
    }
    applyTheme(theme);
};

// Disables the browser's internal password manager and let the extension take the control
const updateDefaultPasswordManager = async function() {
    const permissionResponse = await browser.permissions.request({ permissions: [ 'privacy' ] });
    if (!permissionResponse) {
        return false;
    }

    const passwordSavingEnabled = await browser.privacy.services.passwordSavingEnabled.get({});
    if (passwordSavingEnabled?.levelOfControl === 'controllable_by_this_extension') {
        await browser.privacy.services.passwordSavingEnabled.set({
            value: false,
        });
        return true;
    } else if (passwordSavingEnabled?.levelOfControl === 'controlled_by_this_extension') {
        await browser.privacy.services.passwordSavingEnabled.clear({});
    }

    return false;
};
