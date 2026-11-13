/** Studio Home and the global top bar. Must match the zh-CN key set exactly. */
export const studio = {
  brand: 'BREWPHASE',
  appMenu: 'App menu (Alt also opens it)',
  overline: 'YOUR PERSONAL STUDIO',
  // Brand line kept for About / marketing surfaces; Studio Home now uses the
  // time-based greeting below. Do not remove this key as part of that change.
  title: 'Make room for what matters.',
  subtitle: 'Your desk. Your collections. Your ideas.',
  /**
   * Natural English, not a word-for-word rendering of the five Chinese buckets:
   * English has no "Good noon", so midday and afternoon share "Good afternoon".
   * The keys still map 1:1 to the local-time rules in shared/greeting.ts.
   */
  greeting: {
    lateNight: "It's late",
    morning: 'Good morning',
    midday: 'Good afternoon',
    afternoon: 'Good afternoon',
    evening: 'Good evening'
  },
  greetingSubtitle: 'Take today at your own pace.',
  back: 'Back to Studio',
  search: 'Search records',
  quickAdd: 'Quick add',
  settings: 'Settings',
  searchTitle: 'Search',
  searchPlaceholder: 'Type to find a record',
  searchEmpty: 'Type a keyword to start searching.',
  searchNoResults: 'No matching records.',
  quickAddTitle: 'Put something on the desk',
  quickAddHint: 'Pick a kind, then finish it inside its own space.',
  newBean: 'Add a bag of beans',
  newText: 'Write a note',
  newLink: 'Save a link',
  newCanvas: 'Start a canvas',
  workContext: {
    overline: 'WORK CONTEXT',
    title: 'Continue working',
    nextStep: 'Next step',
    status: { active: 'Active', paused: 'Paused', completed: 'Completed' },
    counts: (records: number, canvases: number, urls: number) =>
      `${records} records · ${canvases} canvases · ${urls} links`
  },
  coffee: {
    overline: 'COFFEE / SHELF',
    hint: 'Like bags on a shelf, kept one layer at a time.',
    open: 'Open Shelf',
    emptyTitle: 'Your coffee shelf is waiting.',
    emptyHint: 'Start collecting the coffees you love.',
    emptyAction: 'Add your first bean',
    count: (n: number) => `${n} bags`,
    unnamed: 'Unnamed beans',
    noRoaster: 'Roaster not recorded'
  },
  records: {
    overline: 'RECORDS / LIBRARY',
    hint: 'Images, links and words, slowly becoming a library.',
    open: 'Open Library',
    emptyTitle: 'Collect things worth keeping.',
    emptyHint: 'Save a thought, a link, or a moment.',
    emptyNote: 'Add a note',
    emptyLink: 'Save a link',
    untitled: 'Untitled record'
  },
  canvas: {
    overline: 'CANVAS / CREATIVE SPACE',
    hint: 'Projects laid out, left just as you arranged them.',
    open: 'Open Canvas',
    emptyTitle: 'Every idea starts somewhere.',
    emptyHint: 'Give your thoughts a space to take shape.',
    emptyAction: 'Create a canvas',
    count: (n: number) => `${n} canvases`,
    untitled: 'Untitled canvas',
    updated: (date: string) => `Updated ${date}`
  }
}
