/** Settings shell: secondary navigation and the General page. */
export const settings = {
  title: 'Settings',
  subtitle: 'Manage the app, data and connections',
  nav: {
    general: 'General',
    sync: 'Device sync',
    browser: 'Browser',
    chrome: 'Chrome extension',
    mcp: 'AI connections'
  },
  general: {
    title: 'General',
    subtitle: 'Language, app and local data',
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
      'Code signing / notarization / auto-update'
    ]
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
  }
}
