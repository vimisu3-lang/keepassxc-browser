import { describe, it, expect, beforeEach } from 'vitest';

describe('auto-lock', () => {
    beforeEach(() => {
        global.__loadVaultModules();
        global.__storageData.local = {};
        global.__storageData.session = {};
    });

    it('locks the vault when the timer fires', async () => {
        const vm = new VaultManager();
        await vm.createVault('pw');

        const autoLock = new AutoLockManager(50);
        let locked = false;
        autoLock.setOnLock(async () => {
            await vm.lockVault();
            locked = true;
        });

        autoLock.startTimer();
        await new Promise(r => setTimeout(r, 120));
        expect(locked).toBe(true);
        expect(vm.isUnlocked).toBe(false);
    });

    it('resetTimer delays the lock', async () => {
        const vm = new VaultManager();
        await vm.createVault('pw');
        const autoLock = new AutoLockManager(80);
        let locked = false;
        autoLock.setOnLock(() => { locked = true; });

        autoLock.startTimer();
        await new Promise(r => setTimeout(r, 40));
        autoLock.resetTimer(); // push the deadline out
        await new Promise(r => setTimeout(r, 60));
        expect(locked).toBe(false);
        await new Promise(r => setTimeout(r, 60));
        expect(locked).toBe(true);
    });

    it('stopTimer prevents locking', async () => {
        const autoLock = new AutoLockManager(50);
        let locked = false;
        autoLock.setOnLock(() => { locked = true; });
        autoLock.startTimer();
        autoLock.stopTimer();
        await new Promise(r => setTimeout(r, 80));
        expect(locked).toBe(false);
    });
});