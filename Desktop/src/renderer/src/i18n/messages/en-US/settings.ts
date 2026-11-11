/** Settings shell: secondary navigation and the General page. */
export const settings = {
  title: 'Settings',
  subtitle: 'Manage the app, data and connections',
  nav: {
    general: 'General',
    sync: 'Device sync',
    browser: 'Browser',
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
  }
}
