/** Settings shell: secondary navigation and the General page. */
export const settings = {
  title: 'Settings',
  subtitle: 'Manage the app, data and connections',
  nav: {
    general: 'General',
    sync: 'Device sync',
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
      'Two-way sync (currently iPhone → desktop only)',
      'MCP Bridge on Windows (Named Pipe permissions unverified)',
      'Code signing / notarization / auto-update'
    ]
  }
}
