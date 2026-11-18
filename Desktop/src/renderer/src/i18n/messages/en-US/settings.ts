/**
 * Remote access (Remote MCP). Deliberately conservative wording: we do not
 * promise "cannot be compromised"; we only state what is actually true —
 * local final veto, and best-effort auditing.
 */
export const remote = {
  title: 'Remote access',
  lead: 'Let a cloud AI (such as ChatGPT) read records, beans and canvases on this computer through BrewPhase Cloud. Off by default; when off, no connection is ever opened.',
  toggle: 'Allow remote access',
  toggleOnHint: 'On. The cloud AI can call 8 read-only tools.',
  toggleOffHint: 'Off. No outbound connection is made.',
  enable: 'Enable…',
  disable: 'Turn off',
  confirmTitle: 'Confirm the scope before enabling',
  confirmBody: 'Once enabled, the AI clients you authorised on the cloud can read:',
  confirmReadonly: 'Read only. Remote access provides no writing, deletion, command execution or file reading, and never copies your data to the cloud.',
  confirm: 'Enable',
  cancel: 'Cancel',
  state: 'Connection',
  states: {
    idle: 'Not connected',
    connecting: 'Connecting',
    handshaking: 'Handshaking',
    online: 'Connected',
    draining: 'Draining',
    backoff: 'Waiting to reconnect',
    blocked: 'Blocked (needs attention)'
  },
  device: 'Device',
  notPaired: 'Not paired',
  boundUser: 'Bound user',
  noUser: 'Not bound',
  serviceable: 'Serviceable',
  yes: 'Yes',
  no: 'No',
  reasons: {
    remote_disabled: 'switch is off',
    user_mismatch: 'signed-in account differs from the bound user',
    db_unavailable: 'local database is not ready',
    services_unavailable: 'local services are not ready',
    shutting_down: 'shutting down',
    blocked: 'needs attention (blocked)'
  },
  lastActive: 'Last active',
  never: '—',
  blockedTitle: 'Remote access is blocked',
  unbind: 'Unbind and pair again',
  grants: 'Authorised clients',
  noGrants: 'No AI client is authorised right now.',
  noScopes: 'no scopes',
  auditWarning: 'The last {count} remote calls could not be written to the audit log',
  auditWarningBody: 'The calls themselves still returned normally.',
  auditLastFailure: 'Last failure:',
  auditHonesty: 'The counter only covers this run and resets on restart; records that failed to write are not backfilled.',
  register: 'Pair a new device',
  diagnose: 'Diagnostics',
  forget: 'Forget this device',
  pendingTitle: 'Pending device (mock)',
  pendingBody: 'Confirmation code:',
  pendingMockNote: 'This is the mock gateway, not the real cloud; the code only exercises the flow.',
  socket: 'Socket',
  inflight: 'In flight',
  cache: 'Result cache',
  lastClose: 'Last close',
  scopeLabels: {
    records: 'records and notes',
    tags: 'tags',
    coffee: 'beans, brews and tastings',
    canvas: 'canvases and notes'
  }
}

/** Settings shell: secondary navigation and the General page. */
export const settings = {
  title: 'Settings',
  subtitle: 'Manage the app, data and connections',
  nav: {
    general: 'General',
    account: 'Cloud account',
    sync: 'Device sync',
    browser: 'Browser',
    chrome: 'Chrome extension',
    mcp: 'AI connections',
    workspace: 'Local workspaces'
  },
  general: {
    title: 'General',
    subtitle: 'Appearance, language, app and local data',
    appearance: 'Appearance',
    appearanceHint:
      'System follows your macOS / Windows appearance. Choosing Light or Dark keeps it fixed.',
    appearanceName: {
      system: 'System',
      light: 'Light',
      dark: 'Dark'
    },
    language: 'Language',
    languageHint: 'Applies immediately across the whole app and is remembered.',
    languageName: {
      'zh-CN': '简体中文',
      'en-US': 'English'
    },
    appInfo: 'Application',
    version: 'Version',
    schemaVersion: 'Database schema',
    syncProtocol: 'Sync protocol',
    platform: 'Platform',
    localData: 'Local data',
    localDataNote:
      "All data lives in this Mac's SQLite database and media folder — no upload, no account, no network required.",
    dataDir: 'Data folder',
    dataDirHint:
      'The database and media files live here. Caches, language preference and sign-in state do not.',
    dataDirChange: 'Change location…',
    dataDirMoving: 'Moving…',
    dataDirReset: 'Use default location',
    dataDirChangeTitle: 'Change where data is stored?',
    dataDirChangeBody:
      'BrewPhase will copy the database and media to the empty folder you pick, then restart. Unsaved input is lost; the original folder is left untouched.',
    dataDirResetTitle: 'Switch back to the default location?',
    dataDirResetBody:
      'The app will use the default data folder again. Data in the custom folder is not moved or deleted — you can clean it up manually later.',
    dataDirRestarting: 'Moved — restarting BrewPhase…',
    dataDirRestartNow: 'Restart now',
    dataDirFailed: 'The move did not finish',
    about: 'About BrewPhase',
    aboutText:
      'A local-first coffee journal and flavour analysis app: log every bag and watch its flavour move. Phase tracking, brew logs and personal patterns all stay on your device — fully usable offline.',
    notDone: 'Deliberately not in this version',
    notDoneItems: [
      'Bonjour auto-discovery (direct QR pairing already works)',
      'TLS transport encryption (sync is LAN HTTP with tokens/signatures)',
      'Two-way sync (currently mobile device → desktop only)',
      'MCP Bridge on Windows (Named Pipe permissions unverified)',
      'Automatic update installation (new versions are only announced; download is manual)'
    ],
    update: {
      title: 'Check for updates',
      hint: 'BrewPhase looks up the latest GitHub release on startup. Only version numbers and download links are read — no device info or journal data is uploaded.',
      check: 'Check for updates',
      checking: 'Checking…',
      idle: 'No update check yet',
      upToDate: (version: string) => `You are up to date (${version})`,
      available: (version: string) => `Version ${version} is available`,
      unavailable: 'Could not check for updates. Try again later.',
      open: 'Open download page',
      lastChecked: (time: string) => `Last checked: ${time}`,
      badge: 'Update available'
    }
  },
  /** Settings → Browser: Chrome bookmark import wizard. */
  browser: {
    title: 'Browser',
    lead: 'Import bookmarks from Chrome on this computer and keep browsing them inside BrewPhase.',
    privacy:
      'Only Chrome’s Bookmarks and Local State are read: no cookies, passwords, extensions or history; Chrome files are never modified and nothing is uploaded.',
    detect: {
      title: 'Chrome',
      checking: 'Looking for Chrome…',
      found: (profiles: number) => `Chrome found · ${profiles} profile${profiles === 1 ? '' : 's'}`,
      notInstalled: 'Google Chrome was not found. Install it and scan again.',
      noProfiles: 'Chrome is installed, but no usable profile was found.',
      rescan: 'Scan again',
      profile: 'Profile',
      bookmarksPresent: 'Bookmarks file found',
      bookmarksMissing: 'No Bookmarks file',
      choose: 'Choose',
      chosen: 'Selected'
    },
    preview: {
      title: 'Preview',
      description: (name: string) => `Bookmarks from “${name}” will be imported; folder hierarchy is kept.`,
      bookmarks: 'Bookmarks',
      folders: 'Folders',
      rootCount: (bookmarks: number, folders: number) =>
        `${bookmarks} bookmark${bookmarks === 1 ? '' : 's'}${
          folders > 0 ? ` · ${folders} folder${folders === 1 ? '' : 's'}` : ''
        }`,
      skipped: 'Cannot import',
      skippedCount: (count: number) => `${count} item${count === 1 ? '' : 's'}`,
      skippedHint: 'Only http and https addresses are imported; javascript:, file:, chrome: and similar are skipped.',
      empty: 'This profile has no importable bookmarks.',
      action: 'Preview bookmarks',
      cancel: 'Cancel',
      confirm: 'Import these bookmarks'
    },
    result: {
      title: 'Import complete',
      added: (count: number) => `${count} added`,
      updated: (count: number) => `${count} updated`,
      skipped: (count: number) => `${count} skipped`,
      total: (count: number) => `${count} bookmarks in total`,
      again: 'Import again',
      open: 'View in browser'
    },
    error: {
      title: 'The import did not finish',
      'profile-not-found': 'That Chrome profile no longer exists.',
      'bookmarks-missing': 'This profile has no Bookmarks file.',
      unreadable: 'Could not read Bookmarks. If Chrome is running, quit Chrome and try again.',
      corrupt: 'Bookmarks is not valid JSON — Chrome may be writing it. Quit Chrome and try again.'
    }
  },
  chrome: {
    title: 'Chrome extension',
    subtitle: 'Browse in Chrome, bring the useful pages back',
    lead: 'Keep using Chrome with your existing sign-ins. Click the extension once to save the current page and your selected text to Records — no re-login, no switching browsers.',
    status: {
      title: 'Connection',
      bridge: 'BrewPhase local service',
      running: 'Running',
      stopped: 'Not running',
      host: 'Native Host',
      installed: 'Installed',
      missing: 'Not installed',
      connected: 'Connected',
      connection: 'Extension link',
      installedIdle: 'Installed, waiting for Chrome',
      invalid: 'Installation looks invalid',
      unknown: 'Unknown',
      lastSeen: (time: string) => `Last request: ${time}`,
      never: 'Last request: nothing from Chrome yet',
      registeredUnknown:
        'Registration state could not be read (system policy). Trust the live connection state instead.',
      selfTest: 'Test local service',
      selfTesting: 'Testing…',
      selfTestOk: 'Local service is healthy',
      selfTestFailed: (message: string) => `Local service error: ${message}`,
      extensionId: 'Extension ID',
      extensionMissing: 'Not generated',
      extensionHint: 'Desktop cannot read Chrome’s loaded extensions; check that the ID on chrome://extensions matches the one above.',
      appVersion: 'Host version'
    },
    actions: {
      install: 'Install / repair',
      recheck: 'Check again',
      uninstall: 'Remove integration',
      installing: 'Installing…',
      uninstalling: 'Removing…'
    },
    result: {
      installed: 'Native Host is registered. You can load the extension in Chrome now.',
      installedPartial:
        'Host files and manifest are in place; the system blocked the registry write. Trust the live “Connected” state instead.',
      removed: 'Registration and local host files were removed.',
      failed: (message: string) => `Could not finish: ${message}`
    },
    steps: {
      title: 'Load the extension in Chrome',
      open: 'Open chrome://extensions',
      devMode: 'Turn on Developer mode (top right)',
      load: 'Choose “Load unpacked” and select this folder:',
      pin: 'Pin BrewPhase to the toolbar. Open any page and click the icon to save.',
      directory: 'Extension folder',
      notBuilt: 'The extension has not been built yet. Run pnpm build in ChromeExtension first.',
      reload: 'After changing extension code, click reload on chrome://extensions.'
    },
    security: {
      title: 'Permissions and data boundary',
      body: 'The extension reads the active tab only when you click: title, URL, selected text and page description. It never reads cookies, passwords or other tabs, and never uploads anything.'
    }
  },

  workspace: {
    title: 'Local workspaces',
    subtitle: 'Register local project folders that AI cards can browse (read-only)',
    add: 'Add local project folder',
    addHint: 'Choose a folder in the system dialog; registering only records access and never modifies files.',
    empty: 'No local workspaces registered yet. Add one, then bind it from any AI card’s BrewPhase button.',
    pathLabel: 'Path',
    statusLabel: 'Status',
    available: 'Available',
    missing: 'Folder missing',
    rename: 'Rename',
    renamePrompt: 'New display name',
    remove: 'Remove access',
    removeConfirmTitle: 'Remove workspace access?',
    removeConfirmBody: (name: string) => `Only the registration is removed — the folder “${name}” and its files are not touched.`,
    boundCards: (n: number) => `${n} card${n === 1 ? '' : 's'} bound`,
    addFailed: 'Could not add this folder'
  },

  account: {
    title: 'Cloud account',
    subtitle: 'Sign in to BrewPhase Cloud for a cross-device identity',
    lead: 'Signing in only establishes a cloud identity. Beans, brews, tastings, records and canvases still live on this computer and are never uploaded automatically.',
    signedOut: 'Not signed in',
    signedOutHint: 'Every local feature works without an account, and the app starts normally when the cloud is unreachable.',
    loginWith: (provider: string) => `Continue with ${provider}`,
    pending: 'Waiting for the browser…',
    pendingHint: 'This page updates by itself once you finish. You can close the browser tab then.',
    pendingExpires: (text: string) => `This attempt is valid until ${text}`,
    cancel: 'Cancel sign-in',
    cancelling: 'Cancelling…',
    signedIn: 'Signed in',
    displayName: 'Name',
    provider: 'Sign-in method',
    providerName: {
      google: 'Google',
      github: 'GitHub'
    },
    accountId: 'Account ID',
    memberSince: 'Member since',
    displayNameFallback: '(no display name)',
    signOut: 'Sign out',
    signOutTitle: 'Sign out of the cloud account?',
    signOutBody: 'Only the credentials on this computer are removed. Beans, records, canvases and media are kept, and device sync is unaffected.',
    checking: 'Confirming the session with the server…',
    verifiedAt: (text: string) => `Last confirmed: ${text}`,
    notVerified: 'Not confirmed with the server since launch (still signed in while offline)',
    storageEncrypted: 'The session is encrypted at rest with the system secret store (safeStorage); no plaintext ever touches disk.',
    storageUnavailable: 'The system secret store is unavailable, so this session stays in memory and will not survive a restart.',
    cloudBase: 'Service address',
    localDataNote: 'Cloud account and device sync are separate credentials: signing in here never changes LAN pairing or sync tokens.',
    refresh: 'Refresh status',
    noticeTitle: 'The last attempt did not finish',
    notice: {
      cancelled: 'Sign-in was cancelled.',
      timeout: 'Timed out waiting for authorization. Please try again.',
      'provider-denied': 'Access was denied on the authorization page.',
      'invalid-state': 'The callback failed validation (state mismatch), so this attempt was discarded.',
      'exchange-failed': 'The authorization code could not be exchanged. Please try again.',
      'cloud-unreachable': 'The cloud service is unreachable. Check your network or the service address.',
      'cloud-timeout': 'The cloud service timed out.',
      'session-expired': 'The session expired. Please sign in again; local data is untouched.',
      'storage-unavailable': 'The system secret store is unavailable, so the session cannot be saved here.',
      'storage-failed': 'Stored credentials could not be read, so you are signed out.',
      'login-in-progress': 'Another sign-in is already waiting for authorization. Finish or cancel it first.',
      'browser-open-failed': 'The system browser could not be opened. Check your default browser.',
      unknown: 'Sign-in did not complete. Please try again.'
    }
  },
  remote
}
