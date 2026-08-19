'use strict';

/**
 * Import parsing (CSV + JSON). Ported from PWSave shared/import-utils.ts
 * Produces entries in the vault-manager shape (uuid/name/login/url/password/note/group).
 */

const parseImportedEntries = function(format, data) {
    if (format === 'csv') return parseCsvEntries(data);
    return parseJsonEntries(data);
};

const newEntry = function(partial) {
    const fallbackId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    return {
        uuid: partial.uuid || fallbackId,
        name: partial.name || '',
        url: partial.url || '',
        login: partial.login || partial.username || '',
        password: partial.password || '',
        note: partial.note || '',
        group: partial.group || partial.folder || '',
        createdAt: partial.createdAt || Date.now(),
        updatedAt: partial.updatedAt || Date.now()
    };
};

const parseCsvEntries = function(data) {
    const lines = String(data).split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) return [];

    const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
    const nameIdx = headers.indexOf('name');
    const urlIdx = headers.indexOf('url');
    const loginIdx = headers.indexOf('login');
    const usernameIdx = headers.indexOf('username');
    const passwordIdx = headers.indexOf('password');
    const noteIdx = headers.indexOf('note');
    const groupIdx = headers.indexOf('group');
    const folderIdx = headers.indexOf('folder');

    if (nameIdx === -1 || passwordIdx === -1) return [];

    const entries = [];
    for (const line of lines.slice(1)) {
        const cols = parseCsvLine(line);
        entries.push(newEntry({
            name: cols[nameIdx] || '',
            url: urlIdx !== -1 ? (cols[urlIdx] || '') : '',
            login: (loginIdx !== -1 ? (cols[loginIdx] || '') : '') ||
                (usernameIdx !== -1 ? (cols[usernameIdx] || '') : ''),
            password: cols[passwordIdx] || '',
            note: noteIdx !== -1 ? (cols[noteIdx] || '') : '',
            group: (groupIdx !== -1 ? (cols[groupIdx] || '') : '') ||
                (folderIdx !== -1 ? (cols[folderIdx] || '') : '')
        }));
    }
    return entries;
};

const parseCsvLine = function(line) {
    const cols = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                current += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            cols.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    cols.push(current);
    return cols;
};

const parseJsonEntries = function(data) {
    let parsed;
    try {
        parsed = JSON.parse(data);
    } catch (e) {
        return [];
    }

    let raw = null;
    if (Array.isArray(parsed)) {
        raw = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
        raw = parsed.entries;
    }
    if (!raw) return [];

    const entries = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.name !== 'string' && typeof item.url !== 'string') continue;
        entries.push(newEntry({
            uuid: typeof item.uuid === 'string' ? item.uuid : undefined,
            name: typeof item.name === 'string' ? item.name : '',
            url: typeof item.url === 'string' ? item.url : '',
            login: typeof item.login === 'string' ? item.login :
                (typeof item.username === 'string' ? item.username : ''),
            password: typeof item.password === 'string' ? item.password : '',
            note: typeof item.note === 'string' ? item.note : '',
            group: typeof item.group === 'string' ? item.group :
                (typeof item.folder === 'string' ? item.folder : ''),
            createdAt: typeof item.createdAt === 'number' ? item.createdAt : undefined,
            updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : undefined
        }));
    }
    return entries;
};
