# Project Status

Objective status of the BrewPhase repository. Every statement below belongs to one of three kinds,
and the kind matters:

1. **Repository state** — visible in the files, code and git history of this repository.
2. **Reproducible results** — produced by the build / test / verification commands listed below.
3. **External or maintainer-held facts** — App Store listings, GitHub Releases, GitHub Pages,
   repository secrets, signing identities and local test runs. These cannot be re-derived from the
   source tree alone; the checking method and date are stated where they are used.

**This document is the single source of truth** for platform requirements, distribution status,
test counts, signing state and known limitations. `README.md` and `README.zh-CN.md` link here instead
of repeating numbers. If two files disagree, fix the other one.

**No adoption metrics are claimed.** Install counts, ratings, download counts and tester numbers live
in App Store Connect / GitHub and are not verifiable from this repository.

**Last reviewed: 2026-11-10** (Asia/Shanghai). Repository is public; default branch `main`.

---

## 1. Development status

| | |
|---|---|
| Status | **Actively developed.** The iPhone app has a shipped App Store release; the desktop app, Records/Canvas and MCP are implemented in `main` but not distributed |
| Main branch | `main`; all work lands here, no maintenance branches |
| Latest shipped release | **iOS 1.1**, App Store, published 2026-10-13; version 1.1 refreshed 2026-10-28 |
| Version in `main` | iOS `MARKETING_VERSION = 2.0`, `CURRENT_PROJECT_VERSION = 1`; Desktop `0.1.0` (`Desktop/package.json`) |
| Repository visibility | **Public** (verified via `GET /repos/banmu123/BrewPhase`, 2026-11-10) |
| Maintainers | 1 active maintainer (`banmu123`) — see [Maintenance](#9-maintenance) |
| Languages | English + Simplified Chinese in the UI; 1,141 localisation keys |

> The version gap is real and intentional to record: the **shipped** App Store build (1.1) contains
> the Coffee notebook only. `main` (2.0 in Xcode) additionally contains Records, Canvas, LAN sync
> and the desktop companion. Nothing in this document treats "implemented in `main`" as "shipped".

### 1.1 Distribution status

*Built* means an artifact can be produced from this repository. It does **not** mean it is publicly
available.

| Surface | Stage | What exists today | How to get it | Evidence |
|---|---|---|---|---|
| iPhone app | **Available** | App Store 1.1, `com.brewphase.ios`, free, US storefront, EN + ZH | [App Store](https://apps.apple.com/us/app/brewphase/id6815591631) | iTunes Lookup API `?bundleId=com.brewphase.ios&country=us`, 2026-11-10 |
| iPhone app, `main` (2.0) | **In development — not published** | Coffee + Records + Canvas + LAN sync in source | Build from source | `BrewPhase.xcodeproj/project.pbxproj`, `BrewPhase/Features/` |
| macOS Desktop | **Built, not published** | arm64 `.dmg` + `.zip`, Developer ID signed, notarized, stapled; 4 assets in draft release `439332432` | No public download; draft assets require an authorised session | GitHub Releases API, 2026-11-10; `Desktop/release/` is gitignored |
| Windows Desktop | **In development — no artifact** | NSIS packaging configured in CI | Build from source | `.github/workflows/desktop-release.yml`, `Desktop/electron-builder.yml` |
| Linux Desktop | **Not supported yet** | `AppImage` target kept in config; no build, no verification | — | `Desktop/electron-builder.yml` |
| MCP / AI Action Gateway | **Built, not published** | Ships with the desktop app; 18 tools, 8 scopes | Run from source | `Desktop/docs/MCP_TOOLS.md`, `Desktop/src/mcp/` |

There is **no published GitHub Release**. `GET /repos/banmu123/BrewPhase/releases` returns one
release, `draft: true`, `prerelease: true`, `published_at: null`, tag
`untagged-1bd2b9c2896888aff7d5`, 4 assets. A draft is not listed on the public Releases page and
its assets are not anonymously downloadable. The desktop download page used by the iOS app
(`https://www.commitbrew.com/brewphase`) returned **HTTP 404** on 2026-11-10.

## 2. Supported platforms & minimum requirements

| Platform | Requirement | Notes | Evidence |
|---|---|---|---|
| iPhone (App Store) | **iOS 18.0+**, iPhone only | Bundle `com.brewphase.ios`; `TARGETED_DEVICE_FAMILY = 1`; Swift 5.0 | `BrewPhase.xcodeproj/project.pbxproj`; iTunes `minimumOsVersion: 18.0` |
| macOS Desktop | **Not declared in the repository** | Only arm64 has been built. No minimum macOS version is specified in config or docs, so it **cannot be confirmed** here | `Desktop/electron-builder.yml`, `Desktop/README.md` |
| Windows Desktop | **Cannot be confirmed** | Config targets NSIS x64; no build, no install, no device test has occurred | `.github/workflows/desktop-release.yml` |
| Linux Desktop | **Not supported** | `AppImage` target retained in config only | `Desktop/electron-builder.yml` |
| MCP | macOS / Linux (Unix domain socket) | Windows Named Pipe ACL unverified; no TCP fallback; V1 explicitly does not support Windows | `Desktop/docs/MCP_ARCHITECTURE.md`, `Desktop/docs/MCP_SECURITY.md` |
| LAN sync | Both devices on the same local network | Plain HTTP, preferred port 47821; no TLS, no public relay | `Desktop/docs/SYNC_PROTOCOL.md`, `BrewPhase/Sync/SyncNetworkClient.swift` |
| Development toolchain | Node 22, pnpm 10.34.5, Xcode for iOS | CI pins Node 22 and pnpm 10.34.5 | `.github/workflows/desktop-release.yml` |

App Store availability was confirmed on the **US** storefront. The `country=cn` iTunes lookup
returned no result on 2026-11-10; whether the app is available in other storefronts is a
maintainer-side fact (see [§10](#10-items-requiring-maintainer-confirmation)).

## 3. Implemented features

**Shipped in iOS 1.1** (from the App Store listing, corroborated by `BrewPhase/Features/Coffee|Bean|Brew|Ask|Insights`):
bean lifecycle with roast/opening dates and remaining-weight tracking; editable flavour-phase rules and
reminders; brew and tasting records; on-device insights and Ask over a bundled coffee knowledge base;
optional user-configured Ollama endpoint; JSON/CSV export and full backup with integrity-checked
restore. Refinements added later in `main` (inventory ledger rules, flavour timeline, quick log) are
not claimed as shipped 1.1 features.

**Implemented in `main`, not shipped**:
- **Records** — four carriers (`link`, `image`, `video`, `text`), local media persistence,
  many-to-many tags, search and filters, platform-aware cards (`BrewPhase/Features/Records/`,
  `BrewPhase/Services/Link/`).
- **Canvas** — infinite canvas, world-coordinate nodes, multiple canvases, node notes
  (`BrewPhase/Features/Canvas/`, `Desktop/docs/CANVAS_SPEC.md`).
- **LAN sync** — pairing QR, snapshot + change log, chunked media with SHA-256 and resume, conflict
  reporting, device revocation, scoped wipe (`BrewPhase/Sync/`, `Desktop/docs/SYNC_PROTOCOL.md`).
- **Desktop companion** — Coffee / Records / Canvas on Electron with local SQLite, guarded link
  metadata resolution, derived-metadata table that cannot create sync conflicts
  (`Desktop/README.md` §已实现).
- **MCP V1** — 18 tools, 8 scopes, per-client tokens, stdio server + Unix socket bridge, write
  audit and idempotency (`Desktop/docs/MCP_*.md`).

**Explicitly not implemented**: bidirectional sync, TLS for LAN sync, Bonjour auto-discovery,
desktop video playback and system reminder scheduling, Canvas drawing tools, automatic updates,
Windows MCP support. `Desktop/README.md` §未实现 is the authoritative list.

## 4. Test & CI status

Unit, integration and e2e tests live next to the code. The iOS suite runs in the simulator; Desktop
unit/integration tests run without a device; Playwright e2e drives a real Electron app and needs a
graphical session.

| Suite | Where | Count | How counted | Last known execution |
|---|---|---|---|---|
| iOS XCTest | `BrewPhaseTests/` | **40 files / 702 test methods** (44 `XCTestCase` subclasses) | Static: `find … -name '*.swift' \| wc -l`; `grep -rhoE 'func test[A-Za-z0-9_]*\(' \| wc -l` | 702 passed, 0 failures — maintainer's local `xcodebuild test` run, 2026-11-09 |
| Desktop Vitest | `Desktop/tests/unit/`, `Desktop/tests/integration/` | **335 passed**; 33 test files in `Desktop/tests/`, 340 textual `it(`/`test(` occurrences | `pnpm test` (config includes unit + integration only) | Local run, 2026-11-10 |
| Desktop e2e | `Desktop/tests/e2e/` | **13 passed / 2 skipped** | `pnpm e2e` (Playwright + real Electron) | Local run, 2026-11-09 |
| Localisation | `Tools/Localization/` | **1,141 keys** in both `.lproj` tables | `python3 Tools/Localization/check.py` | Local run, 2026-11-10 |
| Typecheck / build | `Desktop/` | passed | `pnpm typecheck`, `pnpm build` | Local run, 2026-11-10 |

> **Honesty note on these numbers.** The execution counts are maintainer-side local records (kept in
> `.workbuddy/memory/`, which is not tracked by git), not CI-reproducible results. Static method
> counts are reproducible with the commands above. The 340 textual `it(`/`test(` matches do not equal
> the 335 executed cases (conditional/skipped cases); the difference has not been investigated.
> No count here is presented as a CI badge result.

**CI.** [`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml) is the
only workflow in the repository. `name: Desktop Release`; triggers are `push` on `desktop-v*` tags
and `workflow_dispatch`. Two build jobs (`macos-latest`, `windows-latest`) run install → typecheck →
unit tests → build → packaging → artifact upload (14-day retention); a third job creates a **draft**
`--prerelease` GitHub Release on tag builds. e2e is deliberately not in CI.

- `GET /actions/workflows/412335292/runs` → **total_count: 0**. The workflow has **never run**.
- `GET /actions/secrets` → **total_count: 0**. None of the seven signing/notarisation secrets are
  configured, so a CI build would produce unsigned packages.
- There is **no pull-request CI, no test-on-push workflow, and no nightly job**. The README badge
  points to the packaging workflow only.
- The 97 historical Actions runs in this repository are all `pages build and deployment` (latest
  2026-10-28). `GET /repos/.../pages` currently returns **404**, i.e. Pages is not active now.

## 5. Build & release

| Step | Command / mechanism | Source |
|---|---|---|
| Desktop dev | `pnpm install` → `pnpm dev` | `Desktop/package.json` |
| Desktop verification | `pnpm typecheck && pnpm test && pnpm build && pnpm e2e` | `Desktop/package.json` |
| Desktop packaging | `pnpm dist` (`electron-vite build && electron-builder`), or `pnpm exec electron-builder --mac --arm64` | `Desktop/package.json`, `Desktop/README.md` |
| MCP server | `pnpm mcp:build` → `pnpm mcp:start` | `Desktop/package.json` |
| iOS | `Tools/run.sh` (build → install → simulator → screenshots → OSLog); `xcodebuild test` for the suite | `Tools/run.sh`, `BrewPhase.xcodeproj/` |
| Localisation | `python3 Tools/Localization/generate.py` then `check.py` | `Tools/Localization/` |
| CI release | `desktop-v*` tag → draft prerelease with dmg/zip/exe | `.github/workflows/desktop-release.yml` |

Artifact names follow `BrewPhase-${version}-${os}-${arch}.${ext}`. Targets: macOS `dmg + zip`,
Windows NSIS `exe`, Linux `AppImage` (config only). `npmRebuild: false` + `asarUnpack` are used
because `better-sqlite3` 13 loads platform N-API prebuilds shared between Node and Electron.

**Release state (2026-11-10):** the only release is draft `439332432` with 4 uploaded assets —
`BrewPhase-0.1.0-mac-arm64.dmg` (141,152,610 B), `.zip` (141,660,586 B) and two `.sha256` files.
It is not published, and no remote tag `desktop-artifacts-20261109` exists (drafts do not create
tags until published). Automatic updates (`electron-updater`) are not implemented.

## 6. Code signing & notarization

| Artifact | State | Evidence |
|---|---|---|
| macOS arm64 `.app` | Signed with `Developer ID Application: Zhenkang Chen (TGA82PM3DZ)`, hardened runtime (`flags=0x10000(runtime)`), secure timestamp | `codesign -dv --verbose=4`, `codesign --verify --deep --strict` |
| macOS arm64 `.app` | Apple notarization **Accepted**, ticket stapled | submission `19c5f8b2-76f7-49ad-beaa-a02e670cee04`; `xcrun stapler staple/validate` |
| macOS arm64 `.dmg` | Signed separately, Apple notarization **Accepted**, ticket stapled | submission `fb79888c-0612-4649-81d5-fdfcb85c1e23`; `codesign -dv`, `stapler validate` |
| Gatekeeper | `spctl --assess` → `accepted / source=Notarized Developer ID` for both app and dmg | Local verification, 2026-11-10 |
| Release `.zip` | Rebuilt from the stapled `.app` with `ditto -c -k --keepParent`; `.zip` itself cannot be stapled | Local verification, 2026-11-10 |
| SHA-256 | Two `.sha256` files, `shasum -a 256 -c` passes | `Desktop/release/` (gitignored) |
| Windows | No signing; no certificate, no `signtool` run | No artifact exists |
| CI signing | **Not configured** — 0 repository secrets | `GET /actions/secrets`, 2026-11-10 |

Notarization was performed **locally** with the keychain profile `BrewPingNotary` (same Apple Team
ID, inherited from the maintainer's other project) using `xcrun notarytool submit` +
`notarytool info` polling, not through electron-builder's `mac.notarize` or an App Store Connect API
key. No `.p8` file is required for this local path. CI would need the seven secrets listed in
`Desktop/README.md` (`MAC_CERT_P12_B64`, `MAC_CERT_PASSWORD`, `APPLE_API_KEY_P8_B64`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `WIN_CERT_P12_B64`, `WIN_CERT_PASSWORD`).

Signed and notarized do **not** mean published: these artifacts are still in an unpublished draft.

## 7. Privacy & security status

- No account system, no telemetry, no analytics / advertising / crash-reporting SDK in either target
  (verified against `project.pbxproj` framework lists and `Desktop/package.json` dependencies).
- Data at rest: iOS SwiftData in the app sandbox; Desktop `brewphase.db` (SQLite) plus a media
  directory under Electron `userData`. iOS pairing token in Keychain; Desktop stores only
  `sha256(token)`. MCP token is shown once, passed via `BREWPHASE_MCP_TOKEN`, and stored hashed.
- MCP boundary: 8 scopes, per-request validation in Electron main, write-only audit in
  `mcp_operation_log`, no SQL / filesystem / delete / media-upload tool, no TCP listener. Writes are
  `desktop_local_only` and are not pushed back to iOS.
- Electron boundary: `contextIsolation`, sandbox, no Node integration, Zod-validated IPC with sender
  checks, custom media protocol, CSP restricting embeds to YouTube and Bilibili player domains.
- **LAN sync is unencrypted HTTP**, without TLS. Bearer identity plus timestamp/nonce/HMAC-SHA256
  provide authentication, integrity and replay protection — **not confidentiality**. The pairing
  code, token, sync JSON and media chunks travel in plaintext on the LAN.
- **Optional external egress exists**: link metadata resolution (SSRF-guarded with DNS and redirect
  checks), remote preview images, YouTube/Bilibili embeds, and a user-configured Ollama server.
  Core coffee logging works offline, but the app is not "fully offline" in the current `main`.
- Privacy policy source: [`docs/privacy.html`](privacy.html) (bilingual). Its public URL
  `https://banmu123.github.io/BrewPhase/privacy.html` returned **HTTP 404** on 2026-11-10 because
  GitHub Pages is not enabled. The policy also predates Records / Canvas / LAN sync and still states
  that core features make no network requests — it needs an update before those features ship.

## 8. Known limitations

1. **Two different products share one README.** App Store 1.1 ships Coffee only; Records, Canvas,
   sync and Desktop exist only in `main` (2.0).
2. **No public desktop download.** The only Release is a draft, with no published tag. A public
   repository does not make a draft or its assets downloadable.
3. **No LICENSE file.** `GET /repos/.../license` → 404; GitHub reports `license: None`. Until one is
   added, the repository is all-rights-reserved by default.
4. **No `CONTRIBUTING.md`, `SECURITY.md`, PR CI or test-on-push workflow.**
5. **GitHub Pages is not enabled**, so the privacy policy URL embedded in the app is a 404; the
   policy text is also out of date relative to `main`.
6. **The desktop download page is not deployed** (`https://www.commitbrew.com/brewphase` → 404),
   yet two iOS entry points link to it (`BrewPhase/Shared/Utilities/AppLinks.swift`).
7. **LAN sync has no TLS** and is one-way (iOS → Desktop). MCP writes stay on the desktop.
8. **Real-device end-to-end sync validation is incomplete.** Coverage is integration-level (real
   HTTP + real SQLite); the iPhone ↔ Mac pass is still in progress
   (`Desktop/docs/REAL_DEVICE_SYNC_GUIDE.md`).
9. **Windows is unverified.** No Windows artifact, no install test, and MCP V1 does not support
   Windows Named Pipes. Linux has no build or verification.
10. **macOS is arm64 only** — no Intel or universal build.
11. **No automatic updates** for the desktop app.
12. **Unfinished capabilities**: Bonjour auto-discovery, TLS, bidirectional sync, Canvas drawing,
    desktop video playback, system reminder scheduling
    (`Desktop/README.md` §未实现, `Desktop/docs/ROADMAP.md`).
13. **Version metadata is not aligned**: Xcode `MARKETING_VERSION = 2.0`, Desktop `0.1.0`, App Store
    `1.1`, draft release assets named `0.1.0`.
14. **Screenshots in `docs/screenshots/` predate the current three-tab UI** and are verification
    evidence, not current product imagery. Three App Store 1.1 frames were added for the README;
    no Records / Canvas / Desktop / MCP screenshots exist.
15. **Single maintainer** — bus factor 1; response times depend on one person.
16. **App Store metrics and regional availability are not in the repository** and are not claimed.

## 9. Maintenance

| Process | How it works |
|---|---|
| Maintainer | One active maintainer (`banmu123`): reviews PRs, builds and signs packages, handles releases |
| iOS release | Built and submitted from Xcode / App Store Connect; repository has no iOS release workflow |
| macOS release (actual) | Built locally, signed with the keychain Developer ID, notarized with `BrewPingNotary`, stapled, then uploaded to a draft GitHub Release through the API |
| macOS / Windows release (configured) | `desktop-v*` tag → `.github/workflows/desktop-release.yml` → artifacts + draft prerelease. **Never executed; secrets not configured** |
| Issue / PR process | GitHub Issues / PRs; no templates and no required CI checks yet |
| Security reports | No `SECURITY.md`; use a private GitHub Security Advisory or an issue |
| Repository conventions | Localised strings via `L()` + `Tools/Localization/`; no destructive SwiftData schema changes without a migration plan; changes land on `main` |

## 10. Items requiring maintainer confirmation

These cannot be derived from the source tree. They are deliberately **not** asserted above.

| Item | Why it cannot be confirmed here | Where to check |
|---|---|---|
| App Store availability outside the US storefront; whether 2.0 has been submitted; TestFlight status | Store distribution is managed in App Store Connect, not in git | App Store Connect |
| Whether the draft release `439332432` should be published, and under which tag | A publishing decision, not a repository fact | GitHub Releases |
| Whether GitHub Pages will be enabled for `docs/`, and when the privacy policy will be rewritten | Pages config returns 404; policy text is stale | Repository Settings → Pages; `docs/privacy.html` |
| Deployment date for `https://www.commitbrew.com/brewphase` | External website, not in this repository | Site deployment |
| Choice of open-source license | No LICENSE file exists | Maintainer decision |
| Whether signing secrets will be added to CI, and whether a Windows code-signing certificate exists | `GET /actions/secrets` → 0; certificates are external | Repository Settings → Secrets; Apple Developer / certificate provider |
| Developer ID certificate expiry and Apple notary credential validity | Keychain / Apple account state, not tracked in git | Local Keychain, Apple Developer account |

## 11. Reproducing this status

```bash
# Repository state
git status --short
git ls-files | grep -E '(^|/)(node_modules|out|release|DerivedData)/' || echo "no build artifacts tracked"
test -f LICENSE && echo "license present" || echo "no LICENSE"
test -f README.md && test -f README.zh-CN.md && test -f docs/PROJECT_STATUS.md && echo "docs present"

# iOS project settings
grep -nE 'IPHONEOS_DEPLOYMENT_TARGET|MARKETING_VERSION|PRODUCT_BUNDLE_IDENTIFIER|TARGETED_DEVICE_FAMILY' BrewPhase.xcodeproj/project.pbxproj

# iOS test method count (static)
find ./BrewPhaseTests -type f -name '*.swift' | wc -l
grep -rhoE 'func test[A-Za-z0-9_]*\(' ./BrewPhaseTests --include='*.swift' | wc -l

# Localisation
python3 Tools/Localization/check.py

# Desktop verification
cd Desktop && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build && pnpm e2e

# Local packaging (unsigned unless a Developer ID identity is available)
cd Desktop && pnpm dist

# macOS artifact verification
codesign --verify --deep --strict --verbose=2 release/mac-arm64/BrewPhase.app
xcrun stapler validate release/mac-arm64/BrewPhase.app
xcrun stapler validate release/BrewPhase-0.1.0-mac-arm64.dmg
spctl --assess --type execute --verbose=4 release/mac-arm64/BrewPhase.app

# External state (requires a token with repo scope)
# GET /repos/banmu123/BrewPhase                       — visibility, license
# GET /repos/banmu123/BrewPhase/releases             — draft / published state
# GET /repos/banmu123/BrewPhase/actions/secrets      — secret names only
# GET /repos/banmu123/BrewPhase/actions/workflows/<id>/runs
# GET /repos/banmu123/BrewPhase/pages                — Pages status
# https://itunes.apple.com/lookup?bundleId=com.brewphase.ios&country=us
```
