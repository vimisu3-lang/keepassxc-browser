# PWSave - Password Manager (browser extension)

Standalone Chromium (Manifest V3) password manager built on the KeePassXC-Browser
codebase. No desktop app, no native messaging — the encrypted vault lives in the
browser and syncs to Google Drive (appData folder) as an already-encrypted file.

## How it works

- All vault data is encrypted locally: **AES-256-GCM** (256-bit key, 128-bit tag,
  96-bit IV, 32-byte random salt) derived from the master password via
  **PBKDF2-SHA256 with 600,000 iterations**.
- The vault is stored in `chrome.storage.local` (`pwsave_vault`). Only the
  encrypted ciphertext is ever persisted; passwords/TOTP secrets are decrypted
  on demand while unlocked.
- Google Drive sync (`pwsave-vault.json` in the appData folder) stores the same
  already-encrypted vault — Drive never sees plaintext. Conflicts are merged
  per entry (last-write-wins per entry with tombstones for deletions); the
  losing side is snapshotted to `pwsave-vault.history.<timestamp>.json`
  (newest 10 kept).
- Auto-lock (default 1 hour), session restore across service-worker restarts
  (`chrome.storage.session` + SHA-256 key fingerprint), TOTP 2FA codes, password
  generator, security report (Pwned Passwords range API), import/export
  (encrypted vault or CSV).

## Install / build

Requirements: Node.js 20+, npm.

```sh
npm install
npm run build        # creates pwsave_<version>_Chromium.zip
```

Then load `keepassxc-browser/` as an unpacked extension in `chrome://extensions`
(Developer mode → Load unpacked) or install the zip.

> Drive sync requires the `oauth2.client_id` in `keepassxc-browser/manifest.json`
> to match a "Chrome Extension" OAuth client in Google Cloud Console (scope
> `https://www.googleapis.com/auth/drive.appdata`). The extension ID is fixed by
> the manifest `key` — never change it or users lose access to their vault.

## Tests

```sh
npm test        # Vitest (background vault/crypto/sync)
```

## Scripts

| Script | Purpose |
| ------ | ------- |
| `npm run build` | Package Chromium extension zip |
| `npm run test` | Run Vitest suites |
| `npm run lint` | ESLint (note: repo checkout uses CRLF line endings on Windows, which trips the `linebreak-style` rule) |

## Requested permissions

| Name | Reason |
| ---- | ------ |
| `activeTab` | Current tab URL for credential matching |
| `contextMenus` | Fill username/password context menu items |
| `cookies` | Internal Public Suffix List handling |
| `clipboardWrite` | Copy passwords / TOTP codes |
| `identity` | Google Drive OAuth (`drive.appdata`) |
| `notifications` | Browser notifications |
| `offscreen` | System theme detection for icon colors |
| `storage` | Encrypted vault + settings |
| `tabs` | Tab URL / info |
| `unlimitedStorage` | Large vaults / sync backups |
| `webNavigation` | Redirect handling on login forms |
| `webRequest` + `webRequestAuthProvider` | HTTP Basic Auth auto-fill |
| `<all_urls>` | Detect and fill credentials on any website |

## Manual QA checklist

1. **First run**: popup shows Google sign-in (mandatory). After auth, Create vault screen.
2. **Create vault** → vault view opens, entry list empty.
3. **Add entry** (name/login/password/url) → appears in list; reload popup → still there.
4. **Search** filters entries.
5. **Copy password / username** → clipboard cleared after the configured delay.
6. **Lock** → Lock screen; reopen → still locked. **Unlock** with wrong password → error; correct → vault.
7. **Auto-lock**: set 1 minute in options, wait → popup shows locked.
8. **Service worker restart**: close popup, wait ~30s (or `chrome://serviceworker-internals` → Stop), reopen popup → vault still unlocked (session restore).
9. **Drive sync**: options → Drive Sync → Sync now. Confirm remote file exists (Google Drive → Manage apps). Edit an entry, sync again → remote updated.
10. **Sync history**: after several syncs, history list shows snapshots; restore one → entries revert.
11. **TOTP**: add a TOTP entry (manual secret or QR scan) → 6-digit code shown in popup, updates every 30s.
12. **Password generator**: options → generate → copy.
13. **Security report**: shows weak/reused/pwned passwords.
14. **Import/export**: export CSV + encrypted vault; import CSV → entries added.
15. **Content scripts**: on a login page, username field icon appears; click → fills credentials; clicking the locked icon opens the vault popup for unlock.
16. **HTTP Basic Auth** page with a saved entry → auto-fills; with multiple → selection popup.
17. **Change master password** → old password no longer unlocks.