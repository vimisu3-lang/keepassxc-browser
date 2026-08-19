'use strict';

/**
 * SecurityCenter - password health report (weak / reused / breached via Pwned Passwords).
 * Ported from PWSave background/security-center.ts
 */

class SecurityCenter {
    constructor() {
        this.knownBreachedHashes = new Set();
    }

    async generateReport(entries) {
        const weak = [];
        const reused = new Map();
        const compromised = [];

        for (const entry of entries) {
            if (!entry.password) continue;

            const strength = calculatePasswordStrength(entry.password);
            if (strength < 50) {
                weak.push(entry.uuid);
            }

            if (!reused.has(entry.password)) {
                reused.set(entry.password, []);
            }
            reused.get(entry.password).push(entry.uuid);

            if (await this.checkBreached(entry.password)) {
                compromised.push({
                    entryId: entry.uuid,
                    entryName: entry.name,
                    reason: 'Password found in known data breaches'
                });
            }
        }

        const reusedIds = [];
        for (const [ , ids ] of reused) {
            if (ids.length > 1) {
                reusedIds.push(...ids);
            }
        }

        const uniquePasswords = new Set(entries.filter(e => e.password).map(e => e.password));
        const totalPasswords = entries.filter(e => e.password).length;

        let score = 100;
        score -= (weak.length / Math.max(totalPasswords, 1)) * 30;
        score -= (reusedIds.length / Math.max(totalPasswords, 1)) * 20;
        score -= (compromised.length / Math.max(totalPasswords, 1)) * 40;

        const avgStrength = entries
            .filter(e => e.password)
            .reduce((sum, e) => sum + calculatePasswordStrength(e.password), 0) / Math.max(totalPasswords, 1);

        if (avgStrength < 50) score -= 10;
        else if (avgStrength >= 80) score += 10;

        const hasEmpty = entries.some(e => !e.password || e.password.length === 0);
        if (hasEmpty) score -= 5;

        return {
            totalPasswords,
            weakCount: weak.length,
            reusedCount: reusedIds.length,
            compromisedCount: compromised.length,
            uniqueCount: uniquePasswords.size,
            overallScore: Math.max(0, Math.min(100, Math.round(score))),
            weakPasswords: weak,
            reusedPasswords: reusedIds,
            compromisedPasswords: compromised.slice(0, 100)
        };
    }

    async checkBreached(password) {
        const hash = await this.sha1(password);
        const prefix = hash.substring(0, 5).toUpperCase();
        const suffix = hash.substring(5).toUpperCase();

        try {
            const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`);
            const text = await response.text();
            return text.split('\n').some(line => line.startsWith(suffix));
        } catch (e) {
            return this.knownBreachedHashes.has(hash);
        }
    }

    addKnownBreached(hash) {
        this.knownBreachedHashes.add(hash);
    }

    async sha1(input) {
        const encoder = new TextEncoder();
        const data = encoder.encode(input);
        const hashBuffer = await crypto.subtle.digest('SHA-1', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
}
