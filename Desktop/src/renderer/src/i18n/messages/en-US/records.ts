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
  journey: {
    typeLabel: 'Agent Journey',
    chip: 'Agent Journey',
    empty: 'No Agent Journey yet.',
    emptyHint: 'Agents create one when they finish a multi-step task.',
    events: (count: number) => `${count} events`,
    links: (count: number) => `${count} links`,
    notes: (count: number) => `${count} notes`,
    status: {
      created: 'Created',
      running: 'Running',
      paused: 'Paused',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
      abandoned: 'Abandoned'
    },
    changesCount: (count: number) => `${count} files`,
    verifyCount: (count: number) => `${count} checks`,
    detail: {
      expand: 'Show details',
      collapse: 'Hide details',
      noDetail: 'No structured execution detail yet',
      overview: 'Overview',
      changes: 'Changed files',
      noChanges: 'No file changes in this step.',
      changeType: {
        created: 'Created',
        modified: 'Modified',
        deleted: 'Deleted',
        renamed: 'Renamed'
      },
      symbols: 'Symbols',
      changeSummary: 'What changed',
      before: 'Before',
      after: 'After',
      why: 'Why this location',
      decision: 'Decision',
      selected: 'Chosen approach',
      rationale: 'Why',
      alternatives: 'Alternatives rejected',
      notSelected: 'Why not',
      tradeoffs: 'Known tradeoffs',
      verification: 'Verification',
      command: 'Command',
      target: 'Target',
      exitCode: 'Exit code',
      result: {
        passed: 'Passed',
        failed: 'Failed',
        not_run: 'Not run',
        skipped: 'Skipped'
      },
      evidenceRef: 'Traceable reference',
      observations: 'Observations',
      impact: 'Impact',
      source: 'Source',
      evidence: 'Evidence source',
      agentReported: 'Agent reported',
      agentReportedHint: 'Submitted by the agent, not independently re-checked by a local runtime; entries with a reference can be traced separately.',
      references: 'References',
      refKind: {
        commit: 'Commit',
        diff: 'Diff',
        test: 'Test',
        file: 'File',
        record: 'Record',
        url: 'URL'
      },
      limitations: 'Open issues'
    },
    detailAria: 'Agent Journey detail',
    goal: 'Goal',
    timeline: 'Execution',
    sequence: (value: number) => `#${value}`,
    eventType: {
      user_input: 'User request',
      plan: 'Plan',
      decision: 'Decision',
      execution: 'Execution',
      observation: 'Observation',
      revision: 'Revision',
      verification: 'Verification',
      outcome: 'Outcome',
      user_annotation: 'User note'
    },
    eventStatus: {
      planned: 'Planned',
      running: 'Running',
      completed: 'Completed',
      failed: 'Failed',
      skipped: 'Skipped',
      cancelled: 'Cancelled'
    },
    edgeLabel: (kind: string) => `Relation: ${kind}`,
    source: (name: string) => `Source: ${name}`,
    selfReported: 'Agent reported',
    addToCanvas: 'Add to canvas',
    addToCanvasPick: 'Pick a canvas',
    addToCanvasDone: (name: string) => `Added to “${name}”`,
    addToCanvasFailed: (error: string) => `Could not add to canvas: ${error}`,
    notesTitle: 'My notes',
    notePlaceholder: 'Your own experience, reminders or critique — never rewrites the agent record.',
    noteSave: 'Save',
    noteDelete: 'Delete',
    noteEventLevel: 'Note on this node',
    noteJourneyLevel: 'Note on the whole journey',
    noteSaving: 'Saving…',
    noteSaved: 'Saved',
    recordUnavailable: 'Record no longer available',
    recordResolving: 'Loading…',
    eventMissing: 'Event removed',
    noteEmpty: 'No notes yet.',
    linksTitle: 'Linked records',
    linkEmpty: 'No linked records yet.',
    linkRemove: 'Remove link',
    linkType: {
      references: 'references',
      supports: 'supports',
      produces: 'produces',
      validates: 'validates',
      related_to: 'related to'
    },
    outcome: 'Outcome'
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
