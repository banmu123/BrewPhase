import type { browser as BrowserMessages } from '../zh-CN/browser'

/** English mirror of the zh-CN browser namespace (same keys, same signatures). */
export const browser: typeof BrowserMessages = {
  label: 'Browser',
  open: 'Open browser',
  close: 'Close browser',
  hide: 'Collapse browser',
  titlebarHint: 'Drag the title bar to move the window',
  resizeHint: 'Drag an edge or corner to resize',
  toolbar: {
    start: 'Start page',
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    stop: 'Stop loading',
    openExternal: 'Open in system browser',
    address: 'Enter an address or search term',
    go: 'Go'
  },
  start: {
    title: 'Where would you like to go?',
    hint: 'Browse, discover and collect — all in one place.',
    placeholder: 'Enter an address, or just search',
    recent: 'Recently visited',
    resume: 'Resume last visit',
    returnCurrent: 'Back to current page',
    empty: 'Nothing visited yet.',
    shortcut: 'Search'
  },
  /** Bookmarks imported from Chrome (start page + settings import wizard). */
  bookmarks: {
    roots: {
      bookmarkBar: 'Bookmarks bar',
      other: 'Other bookmarks',
      synced: 'Mobile bookmarks'
    },
    emptyTitle: 'Bring your Chrome bookmarks over',
    emptyHint: 'Import the bookmarks bar, other bookmarks and folders in Settings → Browser. Their hierarchy is kept.',
    import: 'Import bookmarks',
    untitled: 'Untitled bookmark'
  },
  status: {
    loading: 'Loading…',
    untitled: 'Untitled page',
    ready: 'Ready'
  },
  error: {
    title: 'This page did not open',
    blockedScheme: 'BrewPhase Browser only opens http and https addresses.',
    emptyInput: 'Enter an address or a search term first.',
    malformed: 'That address looks incomplete.',
    notFound: 'This site could not be found. Check the spelling.',
    offline: 'The network seems to be offline.',
    timeout: 'The connection timed out. Try again shortly.',
    refused: 'The site refused the connection.',
    certificate: 'This site has a certificate problem, so loading stopped.',
    crashed: 'The page stopped responding.',
    generic: 'The page failed to load.',
    retry: 'Try again',
    backToStart: 'Back to start',
    detail: (description: string) => `Technical detail: ${description}`
  },
  records: {
    openInside: 'Open in BrewPhase',
    openOutside: 'Open in system browser'
  }
}
