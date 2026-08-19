'use strict';

/**
 * Entry-level vault merge for Drive sync. Ported from PWSave shared/merge-utils.ts
 *
 * Returns null when salt/masterHash differ (incompatible vaults) -> caller falls back to LWW + history.
 * Otherwise union by uuid, per-entry LWW via updatedAt (tie -> uuid lexicographic).
 * Tombstones: deletedIds keeps a deletedAt for each removed uuid; an entry is dropped if
 * deletedAt > updatedAt and resurrected (tombstone removed) if updatedAt > deletedAt.
 * TOTP is embedded in each entry, so it merges with the entry.
 */

const mergeVaults = function(local, remote, settingsSource) {
    if (local.salt !== remote.salt || local.masterHash !== remote.masterHash) {
        return null;
    }

    const localDeleted = local.deletedIds || {};
    const remoteDeleted = remote.deletedIds || {};
    const deletedIds = {};
    for (const [ id, at ] of Object.entries(localDeleted)) {
        deletedIds[id] = at;
    }
    for (const [ id, at ] of Object.entries(remoteDeleted)) {
        if ((deletedIds[id] || 0) < at) deletedIds[id] = at;
    }

    const entriesByUuid = new Map();
    for (const entry of [ ...remote.entries, ...local.entries ]) {
        const current = entriesByUuid.get(entry.uuid);
        if (!current || isNewerEntry(entry, current)) entriesByUuid.set(entry.uuid, entry);
    }

    const mergedEntries = [];
    for (const [ uuid, entry ] of entriesByUuid) {
        const deletedAt = deletedIds[uuid];
        if (deletedAt !== undefined && deletedAt > entry.updatedAt) {
            continue;
        }
        if (deletedAt !== undefined && entry.updatedAt > deletedAt) {
            delete deletedIds[uuid];
        }
        mergedEntries.push(entry);
    }

    return {
        version: local.version,
        salt: local.salt,
        masterHash: local.masterHash,
        entries: mergedEntries,
        settings: settingsSource === 'local' ? local.settings : remote.settings,
        deletedIds
    };
};

const isNewerEntry = function(candidate, current) {
    if (candidate.updatedAt !== current.updatedAt) {
        return candidate.updatedAt > current.updatedAt;
    }
    return candidate.uuid > current.uuid;
};
