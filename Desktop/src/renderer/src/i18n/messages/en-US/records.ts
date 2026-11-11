/** Records module wording — keep in sync with zh-CN/records.ts. */
export const records = {
  title: 'Records',
  subtitle: 'Collect & explore',
  count: (count: string) => `${count} items`,
  searchPlaceholder: 'Search titles, notes, and URLs…',
  allTags: 'All tags',
  empty: 'No records yet. Start with a link, an image, or a note.',
  untitled: 'Untitled record',
  newText: 'New note',
  newLink: 'New link',
  importImage: 'Import image',
  importedImageTitle: 'Imported image',
  carrier: {
    link: 'Link',
    image: 'Image',
    video: 'Video',
    text: 'Text'
  },
  platform: {
    web: 'Web'
  },
  provider: {
    github: 'GitHub',
    youtube: 'YouTube',
    bilibili: 'Bilibili',
    x: 'X',
    generic: 'Web'
  },
  link: {
    invalid: "That isn't a valid web address (http/https only)",
    short: 'Short link — the final address is resolved after saving',
    contentId: 'Content ID found — preview is fetched after saving',
    tryPreview: 'Preview will be fetched after saving',
    recognized: (provider: string) => `Detected ${provider}`
  },
  form: {
    title: 'Title',
    url: 'URL',
    body: 'Body',
    invalidUrlNotSaved: "That isn't a valid web address, so it wasn't saved"
  },
  detail: {
    ariaLabel: 'Record details',
    close: 'Close details'
  },
  errors: {
    recordDeleted: 'The record you tried to open has been deleted.',
    openFailed: (message: string) => `Couldn't open the record: ${message}`
  },
  metadata: {
    pending: 'Fetching preview…',
    ok: 'Preview updated',
    partial: 'Some preview details were fetched',
    unavailable: 'Preview is unavailable for now',
    fetching: 'Fetching…',
    fetch: 'Fetch preview',
    refresh: 'Refresh preview'
  },
  inspector: {
    title: 'Record attributes',
    titleHint: 'Grey text is the title fetched from this Mac; type your own to make it yours',
    note: 'Note',
    tags: 'Tags',
    newTag: 'New tag',
    addTag: 'Add',
    saveChanges: 'Save changes',
    deleteTitle: 'Delete this record?',
    deleteBody: 'Its canvas node will disappear too. This cannot be undone.',
    info: 'Info',
    carrierLine: (name: string) => `Carrier: ${name}`,
    createdLine: (value: string) => `Created: ${value}`,
    updatedLine: (value: string) => `Updated: ${value}`,
    fileLine: (value: string) => `File: ${value}`
  },
  preview: {
    title: 'Preview details',
    repository: 'Repository',
    content: 'Content',
    stats: 'Stats',
    socialPost: 'Social post'
  },
  player: {
    play: (title: string) => `Play: ${title}`,
    note: 'Click the cover to play in the app',
    collapse: 'Collapse',
    expand: 'Expand',
    openBrowser: 'Open in browser'
  }
}
