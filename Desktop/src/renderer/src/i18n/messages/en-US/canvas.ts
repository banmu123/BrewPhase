/** Canvas module wording — keep in sync with zh-CN/canvas.ts. */
export const canvas = {
  title: 'Canvas',
  subtitle: 'Connect & create',

  untitledCanvas: 'Untitled canvas',
  untitledRecord: 'Untitled record',
  untitledVideo: 'Untitled video',
  untitledLink: 'Untitled link',
  newCanvasName: 'New canvas',
  updatedAt: (date: string) => `Updated ${date}`,
  gallerySubtitle: (count: number) => `Your creative spaces · ${count} canvas${count === 1 ? '' : 'es'}`,

  gallery: {
    newCanvas: 'New canvas',
    loading: 'Loading canvases…',
    emptyTitle: 'No canvases yet.',
    emptyBody: 'A canvas is a space you name yourself — gather things from your records and connect them to create.',
    rename: 'Rename',
    deleteCanvas: 'Delete canvas',
    renameNamed: (name: string) => `Rename ${name}`,
    deleteNamed: (name: string) => `Delete ${name}`
  },

  workspace: {
    back: 'Back to gallery',
    switchCanvas: 'Switch canvas',
    myCanvases: 'My Canvases',
    newCanvas: 'New',
    focusMode: 'Focus mode',
    focus: 'Focus',
    noCanvas: 'No canvas yet. Go back to the gallery and create one to start.',
    loading: 'Loading canvas…',
    loadFailed: "Couldn't load this canvas.",
    reload: 'Reload',
    noteHint: 'Click the canvas to place a note',
    closePanel: 'Close panel'
  },

  zoom: {
    out: 'Zoom out',
    in: 'Zoom in',
    fit: 'Fit all content',
    fitTitle: 'Fit all (0)',
    fitLabel: 'Fit',
    reset: 'Back to 100%',
    resetTitle: '100% (1)'
  },

  carrier: {
    all: 'All',
    image: 'Image',
    video: 'Video',
    link: 'Link',
    text: 'Text'
  },

  picker: {
    title: 'Add records',
    subtitle: 'Pick something from your collection',
    searchPlaceholder: 'Search title, note, source, author…',
    alreadyOnCanvas: ' · On canvas',
    selected: ' · Selected',
    loading: 'Loading…',
    loadingMore: 'Loading more…',
    empty: 'No matching records.',
    clearSearch: 'Clear search',
    addCount: (count: number) => `Add ${count}`,
    batchPartial: (added: number, names: string[], failed: number, error: string) =>
      `Added ${added}${names.length ? ` (${names.join(', ')})` : ''}; ${failed} failed to add: ${error}`
  },

  inspector: {
    title: 'Selected item',
    overline: 'Selected',
    play: '▶ Play',
    stopPlay: '⏸ Stop',
    annotationLabel: 'Canvas note',
    annotationPlaceholder: "Belongs to this canvas only — the record itself stays unchanged.",
    editAnnotation: 'Edit canvas note',
    remove: 'Remove from canvas',
    removeHint: 'This only removes the reference; the original record stays in your library.',
    annotationQuote: (text: string) => `“${text}”`
  },

  contextMenu: {
    openRecord: 'Open original record',
    openSource: 'Open original source'
  },

  player: {
    videoTitle: 'Video playback',
    loadFailed: 'Video failed to load.',
    openInBrowser: 'Open in browser',
    stop: 'Stop playback',
    stopTitle: 'Stop playback (Esc)'
  },

  dialog: {
    createTitle: 'New canvas',
    renameTitle: 'Rename canvas',
    deleteTitle: 'Delete this canvas?',
    deleteBody: "Nodes, notes, and strokes on this canvas will be removed too. Source records aren't affected, and deletion can't be undone.",
    namePlaceholder: 'What to call this canvas',
    confirmDelete: 'Delete'
  },

  tools: {
    selectHint: 'Select (V)',
    handHint: 'Hand (H / Space)',
    penHint: 'Pen (P)',
    eraserHint: 'Erase by stroke (E)',
    noteHint: 'Click canvas to place a note (N)',
    penColor: (color: string) => `Pen color ${color}`
  },

  toolbar: {
    note: 'Note',
    newNoteTitle: 'New note (N)',
    image: 'Image',
    importImageTitle: 'Import image',
    record: 'Record',
    addRecordTitle: 'Add record'
  },

  save: {
    saved: 'Saved',
    failed: 'Save failed'
  },

  note: {
    defaultTitle: 'Note',
    defaultBody: 'Double-click to edit this thought.',
    titlePlaceholder: 'Title',
    bodyPlaceholder: 'Write something…',
    colorLabel: (color: string) => `Note color ${color}`,
    delete: 'Delete note',
    done: 'Done'
  },

  textCard: {
    noBody: '(No body text)'
  },

  empty: {
    overline: 'Start with a small move',
    addRecord: 'Add a record',
    addImage: 'Import an image',
    addNote: 'Create a note',
    draw: 'Draw a stroke'
  }
}
