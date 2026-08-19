'use strict';

/**
 * AutoLockManager - locks the vault after inactivity.
 * chrome.alarms (min 30s) + setTimeout fallback. Ported from PWSave background/auto-lock.ts
 */

const AUTO_LOCK_ALARM = 'pwsave-auto-lock';

class AutoLockManager {
    constructor(timeout = DEFAULT_AUTO_LOCK_TIMEOUT) {
        this.timeout = timeout;
        this.timerId = null;
        this.onLockCallback = null;
        this.onActivityCallback = null;
        this.setupAlarmListener();
    }

    setupAlarmListener() {
        chrome.alarms.onAlarm.addListener((alarm) => {
            if (alarm.name === AUTO_LOCK_ALARM) {
                this.lock();
            }
        });
    }

    setOnLock(callback) {
        this.onLockCallback = callback;
    }

    setOnActivity(callback) {
        this.onActivityCallback = callback;
    }

    setTimeout(timeout) {
        this.timeout = timeout;
    }

    resetTimer() {
        this.stopTimer();
        this.startTimer();
    }

    startTimer(delayMs) {
        const remaining = delayMs || this.timeout;
        if (this.timeout <= 0 || remaining <= 0) return;

        this.timerId = setTimeout(() => {
            this.lock();
        }, remaining);

        chrome.alarms.create(AUTO_LOCK_ALARM, {
            delayInMinutes: Math.max(0.5, remaining / 60000)
        });
    }

    stopTimer() {
        chrome.alarms.clear(AUTO_LOCK_ALARM);
        if (this.timerId !== null) {
            clearTimeout(this.timerId);
            this.timerId = null;
        }
    }

    lock() {
        this.stopTimer();
        this.onLockCallback?.();
    }

    onActivity() {
        this.resetTimer();
        this.onActivityCallback?.();
    }

    destroy() {
        this.stopTimer();
        this.onLockCallback = null;
    }
}
