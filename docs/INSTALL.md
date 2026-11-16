# Installing BrewPhase

BrewPhase is three separate things that share one data model. Pick the one you want — you do not
need the desktop app to use the iPhone app.

| You want… | Install | Requires |
|---|---|---|
| The coffee notebook on your phone | [BrewPhase 1.1 from the App Store](https://apps.apple.com/us/app/brewphase/id6815591631) | iPhone, iOS 18.0+ |
| The desktop companion (Coffee / Records / Canvas, LAN sync, MCP) | `BrewPhase-<version>-mac-arm64.dmg` from [Releases](https://github.com/banmu123/BrewPhase/releases) | Apple Silicon Mac |
| The same desktop companion on Windows | `BrewPhase-<version>-win-x64.exe` from [Releases](https://github.com/banmu123/BrewPhase/releases) | Windows x64 |

> **Installers come from two places only:** the App Store link above and
> [github.com/banmu123/BrewPhase/releases](https://github.com/banmu123/BrewPhase/releases). There is
> no external download site. Every GitHub asset has a `.sha256` sidecar so you can check it yourself
> (see [Verifying a download](#verifying-a-download)).

What is actually shipped, and what is still only in `main`, is tracked in
[docs/PROJECT_STATUS.md](PROJECT_STATUS.md). Do not read this page as a release announcement.

---

## 1. iPhone

1. Open [BrewPhase on the App Store](https://apps.apple.com/us/app/brewphase/id6815591631).
2. Install. The listing is free, on the US storefront, in English and Simplified Chinese.
3. Open the app, add a bag with its roast date, and log a brew. The flavour timeline starts filling
   itself in.

The App Store build is **1.1** — the Coffee notebook. Records, Canvas and LAN sync are **not** in it;
they exist in `main` and in the desktop builds below.

There is no account and no sign-in, on any platform.

---

## 2. macOS desktop

### 2.1 Download

Open [Releases](https://github.com/banmu123/BrewPhase/releases) and take the newest `desktop-v*`
entry. Two assets, same app:

| Asset | Use it when |
|---|---|
| `BrewPhase-<version>-mac-arm64.dmg` | Normal install. Mount, drag, done. |
| `BrewPhase-<version>-mac-arm64.zip` | You need a plain archive (scripted install, MDM). Unzip and move `BrewPhase.app` to `/Applications` yourself. |

Both are **Apple Silicon (arm64) only**. There is no Intel build, and none is planned — an Intel Mac
will refuse to launch the app rather than run it slowly.

The `.blockmap` files next to them are for the updater format, not for installation; ignore them.

### 2.2 Verifying a download

Download the `.sha256` file next to the asset, then:

```bash
cd ~/Downloads
shasum -a 256 -c BrewPhase-<version>-mac-arm64.dmg.sha256
# BrewPhase-<version>-mac-arm64.dmg: OK
```

The sidecar contains `<hash>  <filename>`, so `shasum -c` works without editing anything. If you get
`FAILED`, delete the file and download it again — do not install it.

For the record, release `desktop-v0.1.4`:

```
d1a8f81b36a225524a69e588db7047e7adae8dd74db02d98df0238e2ccfa9437  BrewPhase-0.1.4-mac-arm64.dmg
```

### 2.3 Install

1. Double-click the `.dmg` to mount it.
2. Drag **BrewPhase** onto the **Applications** folder in the same window.
3. Eject the disk image (`⌘E`, or the eject button in Finder).
4. Launch from **Applications**, not from the mounted image — a copy inside the image is read-only
   and disappears on eject.

### 2.4 First launch and Gatekeeper

`desktop-v0.1.1`, `desktop-v0.1.3` and `desktop-v0.1.4` are **Developer ID signed, notarized by
Apple and stapled**. Double-click opens them normally: no right-click, no `xattr` removal, no
"Open Anyway" trip through System Settings.

| Build | Signing state | First launch |
|---|---|---|
| 0.1.4 / 0.1.3 / 0.1.1 | Signed + notarized + stapled | Double-click |
| 0.1.2 | Signed, **not notarized** | Right-click → **Open**, once — or skip it and use 0.1.4 |
| 0.1.0 | Signed + notarized + stapled | Double-click |

If macOS says *"BrewPhase is damaged and can't be opened"* on 0.1.4, the download was truncated —
check the SHA-256 above before doing anything else. Do **not** reach for
`sudo spctl --master-disable`; disabling Gatekeeper system-wide to run one app is a bad trade, and
you do not need it here.

The repository does not declare a minimum macOS version. Only arm64 has ever been built, and the
Electron major pinned in `Desktop/package.json` sets the floor — if the app quits immediately on
launch, an outdated macOS is the first thing to check.

### 2.5 Where your data lives

The packaged app keeps everything in one folder, separate from any development build:

| Platform | Folder | Contents |
|---|---|---|
| macOS | `~/Library/Application Support/BrewPhase/` | `brewphase.db` (SQLite), `media/` |
| Windows | `%APPDATA%\BrewPhase\` | `brewphase.db`, `media/` |

You can point it somewhere else — **Settings → General → Local data → Change location…** — which
copies the database and media directory into an empty folder you pick and restarts. The original
folder is left untouched. Back up by copying that folder while the app is closed; there is no cloud
copy and no export server.

A development build (`pnpm dev`) uses `~/Library/Application Support/brewphase-desktop` instead, so
the two never share a database.

### 2.6 Uninstall

1. Quit BrewPhase.
2. Drag **BrewPhase** from `/Applications` to the Trash.

Your data is **not** deleted. To remove it as well, delete `~/Library/Application Support/BrewPhase`
after the app is gone. This is deliberate: uninstalling should not destroy a coffee journal you might
reinstall for.

---

## 3. Windows desktop

### 3.1 Download

From the newest `desktop-v*` entry on [Releases](https://github.com/banmu123/BrewPhase/releases):

| Asset | Use it when |
|---|---|
| `BrewPhase-<version>-win-x64.exe` | Normal install (NSIS). |
| `BrewPhase-<version>-win-x64.exe.sha256` | Checksum sidecar — download it with the installer. |

Windows x64 only. There is no arm64 Windows build.

### 3.2 Verifying a download

In PowerShell, in the folder you downloaded to:

```powershell
Get-FileHash .\BrewPhase-<version>-win-x64.exe -Algorithm SHA256
```

Compare the `Hash` field with the first token in the `.sha256` file. They must match exactly. A GUI
alternative: right-click the `.exe` → **Properties** → **Digital signatures** — but the current
installers are **not** Authenticode-signed, so that tab will be empty. The checksum is the check that
works.

### 3.3 Install

1. Run the `.exe`.
2. SmartScreen will interrupt — see below.
3. The NSIS installer is **assisted**, not one-click: it shows the destination folder and lets you
   change it, then creates a Start-menu entry and a desktop shortcut named *BrewPhase*.
4. Launch from the Start menu.

### 3.4 SmartScreen

The Windows installers carry **no Authenticode signature** yet, so Windows shows
*"Windows protected your PC"* on first run:

1. Click **More info**.
2. Click **Run anyway**.

That warning means "this publisher has not paid for a certificate", not "this file is known to be
malware". Verify the SHA-256 first (3.2); if it matches the value published in the release, the file
is the one that was built. Do not click through the prompt for a file whose checksum you have not
checked.

The Windows build has **not** been installed or smoke-tested on real hardware by the maintainer. Treat
it as a prerelease.

### 3.5 Where your data lives

`%APPDATA%\BrewPhase\` — `brewphase.db` plus `media/`. Same layout, same relocation option
(**Settings → General → Local data → Change location…**) as the macOS build.

### 3.6 Uninstall

**Settings → Apps → Installed apps → BrewPhase → Uninstall**. The installer is configured with
`deleteAppDataOnUninstall: false`, so `%APPDATA%\BrewPhase` survives. Delete that folder by hand if
you want the data gone too.

### 3.7 What the Windows build cannot do

- **No MCP / AI Action Gateway.** The bridge uses a Named Pipe whose permissions have not been
  verified on Windows; it is listed as deliberately absent in the app's own *Settings → General →
  Deliberately not in this version*. Agents connect over MCP on macOS only.
- **No Authenticode signature** — SmartScreen warns on every fresh download.
- **No real-hardware test** — see above.

---

## 4. Updating

There is **no automatic update installer** on either platform (`electron-updater` is not wired in).
The app only *tells* you a newer release exists.

- **Check:** **Settings → General → Check for updates**. BrewPhase reads the latest GitHub release on
  startup and shows a badge when a newer `desktop-v*` version exists. It sends nothing about you or
  your data; only version numbers are fetched.
- **Update:** download the new `.dmg` / `.exe` from Releases and install over the old version. Your
  `brewphase.db` and `media/` are outside the app bundle and are kept. Quit the app before
  installing.
- **Roll back:** releases are independent — installing an older one over a newer one works, but a
  database written by a newer version may not be readable by an older one. Copy
  `Application Support/BrewPhase` somewhere safe before downgrading.

---

## 5. Pair the iPhone with the desktop app

Both devices on the same Wi-Fi.

1. Desktop: **Settings → Device sync** → show the pairing QR code.
2. iPhone: the **Connect desktop** card on the Coffee home screen, or **More → Data → Desktop sync**.
3. Scan. The code is single-use and expires after two minutes.

Sync is **one-way, iOS → Desktop** in v1: the phone pushes, the desktop receives. Pairing and sync
travel over plain HTTP on your LAN — authenticated with a token plus timestamp/nonce/HMAC, but **not
encrypted**. Pair only on a network you trust. Details:
[`Desktop/docs/REAL_DEVICE_SYNC_GUIDE.md`](../Desktop/docs/REAL_DEVICE_SYNC_GUIDE.md),
[`Desktop/docs/SYNC_PROTOCOL.md`](../Desktop/docs/SYNC_PROTOCOL.md).

---

## 6. Connect an AI agent over MCP (macOS)

1. In the desktop app: **Settings → AI connections** → create a client token with the scopes you want
   (8 available). The token is shown once.
2. Point your MCP client at the server inside the installed app:

   ```
   /Applications/BrewPhase.app/Contents/Resources/mcp/stdio.mjs
   ```

   It is a single self-contained file — spawn it with plain `node`, no `npm install`, no build step.
3. Pass the token through the environment variable `BREWPHASE_MCP_TOKEN`, not as a command-line
   argument.

Copy-pasteable `config.toml` and `mcp.json` blocks live in
[`Desktop/README.md`](../Desktop/README.md#mcpai-action-gateway). The tool list and its limits are in
[`Desktop/docs/MCP_TOOLS.md`](../Desktop/docs/MCP_TOOLS.md) and
[`Desktop/docs/MCP_SECURITY.md`](../Desktop/docs/MCP_SECURITY.md) — there are no SQL, filesystem or
delete tools by design.

Windows: not available, see 3.7.

---

## 7. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| macOS: *"BrewPhase is damaged and can't be opened"* | Truncated download, or an old 0.1.2 build | Verify SHA-256 (2.2); if it fails, re-download. If it passes, you are on 0.1.2 — use 0.1.4 |
| macOS: *"You do not have permission to open the application"* | Still running from the mounted `.dmg` | Drag to `/Applications` and launch from there |
| macOS: *"The application is not supported on this Mac"* | Intel Mac | No Intel build exists; nothing to fix |
| macOS: app quits immediately on launch | macOS older than the Electron runtime requires | Update macOS, or check `Desktop/package.json` for the Electron major |
| Windows: *"Windows protected your PC"* | Unsigned installer | **More info → Run anyway**, after verifying the checksum |
| Windows: installer finishes but nothing starts | Antivirus quarantined the unsigned binary | Check the AV quarantine log; add an exclusion only if you verified the checksum |
| App opens with bags you never added | A development build shared the old `brewphase-desktop` folder | Packaged builds use `Application Support/BrewPhase`; the old folder is left untouched and can be deleted |
| iPhone never finds the desktop | Different networks, VPN, or the 2-minute code expired | Same Wi-Fi, VPN off, regenerate the code and scan again |
| Sync pairs but nothing arrives | v1 sync is iOS → Desktop only | Changes made on the desktop are not pushed to the phone |
| MCP client: *"Cannot find module"* | Relative path, or a source checkout instead of the installed app | Use the absolute path in §6 step 2 |
| Update badge never appears | Offline, or GitHub API rate-limited | **Check for updates** again later; the check is read-only |

Still stuck: open an issue at
[github.com/banmu123/BrewPhase/issues](https://github.com/banmu123/BrewPhase/issues) with your
platform, app version (**Settings → General → Application**) and the exact message.

---

## 8. What these builds do not do

Repeated here because it is the most common source of surprise:

- No cloud sync, no account, no telemetry — the phone and the desktop talk directly, or not at all.
- No automatic update install; you download new versions yourself.
- No Intel macOS build, no arm64 Windows build, no Linux build.
- No MCP bridge on Windows.
- LAN sync is unencrypted HTTP (authenticated, not confidential).
- Records / Canvas / desktop sync are **not** in the App Store 1.1 build.

The authoritative, dated list of limitations is
[`docs/PROJECT_STATUS.md`](PROJECT_STATUS.md) §8.
