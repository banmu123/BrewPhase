/**
 * First-run onboarding: the shared entry (connect an agent / pair a phone / skip)
 * plus the AI connection flow. Both paths are optional — nothing here should
 * imply that not connecting is falling behind.
 */
export const onboarding = {
  overline: 'BREWPHASE / DESKTOP',
  title: 'Extend your personal space to the desktop',
  lead: 'BrewPhase Desktop is the desktop companion to BrewPhase on your mobile device: beans, brews, tastings, saved records and canvases, synced over your local network. It ships with no data of its own — pairing takes three steps:',
  step1: 'On your mobile device, open BrewPhase and find the desktop sync entry (on iOS: More → Data → Desktop sync).',
  step2: 'Back here, open Settings → Device sync, enable sync and generate the pairing QR code.',
  step3: 'Scan the code with your mobile device to pair — your data starts syncing right away.',
  openSettings: 'Open device sync settings',
  later: 'Look around first',
  privacyNote: 'Data travels only between this Mac and your mobile device over the local network — no cloud, no account.',

  // MARK: - Shared entry

  welcome: {
    title: 'Your personal space, connected to the tools you trust.',
    lead: 'BrewPhase keeps your data on this machine. You can optionally connect an AI agent, and let it read and help organise your material within the permissions you grant.',
    connectAgent: 'Connect an AI agent',
    pairDevice: 'Pair a mobile device',
    skip: 'Skip for now and open BrewPhase',
    note: 'Both paths are optional. You can set either up later in Settings.'
  },

  // MARK: - AI connection

  agent: {
    title: 'Connect an AI agent',
    lead: 'Pick an agent. BrewPhase creates a separate client for it, scoped to exactly what you tick.',
    bridgeDownTitle: 'The local connection is not ready',
    bridgeDownBody: 'BrewPhase’s local bridge is not running yet, so an agent cannot connect right now. Wait a moment, or check Settings → AI connections.',
    back: 'Back',
    kindTitle: 'Which agent',
    kinds: {
      workbuddy: 'WorkBuddy',
      codex: 'Codex',
      other: 'Other MCP client'
    },
    kindHints: {
      workbuddy: 'Config goes in ~/.workbuddy/mcp.json',
      codex: 'Config goes in ~/.codex/config.toml',
      other: 'Generic JSON; adjust fields to your client'
    },
    unsupportedTitle: 'Cannot connect on this machine',
    unsupportedBody:
      'The local bridge is not available on this platform, so an agent cannot reach BrewPhase. The app still works normally.',
    scopeTitle: 'Permissions',
    presets: {
      fullAccess: 'Everything (recommended)',
      personalGrowthCollab: 'Read + drafts',
      personalGrowth: 'Core reads only',
      recordsOnly: 'Records only'
    },
    presetHints: {
      fullAccess: 'Everything by default: read state, directions, stages, work context, records, coffee and canvas, and also organize records, arrange the canvas and write drafts. Confirming a direction stays yours alone, in the app.',
      personalGrowthCollab: 'Can read, and can write drafts you confirm. Does not modify your existing records or canvas.',
      personalGrowth: 'Read your current state, directions, stages, work context and records. No write access at all.',
      recordsOnly: 'Read your records only.'
    },
    scopeLabel: {
      'records:read': 'Read the records you saved',
      'records:create': 'Create records',
      'records:update': 'Edit existing records',
      'tags:read': 'Read tags',
      'tags:create': 'Create tags',
      'coffee:read': 'Read beans, brews and tastings',
      'canvas:read': 'Read canvas content',
      'canvas:write': 'Add and move things on the canvas',
      'work_context:read': 'Read ongoing work contexts',
      'work_context:create': 'Create work contexts',
      'work_context:update': 'Update work contexts',
      'work_context:link': 'Link records, canvas nodes and URLs to a work context',
      'direction:read': 'Read your confirmed current state, directions and stages',
      'direction:propose': 'Create direction drafts for you to confirm (cannot confirm)'
    },
    custom: 'Custom permissions',
    scopeCount: (picked: number, total: number) => `${picked} of ${total} selected`,
    scopeSummaryAll: (total: number) => `all ${total}, tighten anytime`,
    scopeAdjust: 'Adjust',
    scopeCollapse: 'Hide',
    create: 'Create client',
    creating: 'Creating…',

    created: (name: string) => `“${name}” created`,
    tokenOnce: 'The token is shown once. Copy it before closing this.',
    copyToken: 'Copy token',
    copyConfig: 'Copy config',
    configHint: {
      workbuddy:
        'Open WorkBuddy’s MCP config (usually ~/.workbuddy/mcp.json), merge this into mcpServers, save, then restart WorkBuddy.',
      codex: 'Open ~/.codex/config.toml, append this, save, then restart Codex.',
      other: 'Merge this into your client’s MCP config per its documentation, save, then restart it.'
    },

    verifyTitle: 'Confirm it actually connected',
    verifyHint: 'Copying the config is not a connection. Send this inside the agent so it reads once:',
    verifyPrompt: 'Read my BrewPhase direction and current stage, and tell me briefly what you found.',
    verifyWaiting: 'Waiting for the first call…',
    verifySuccess: 'Connected — the agent just called BrewPhase successfully.',
    verifyTimeout:
      'No call detected yet. Check that the config was saved, the agent was restarted, and BrewPhase is still running.',
    verifyRetry: 'Check again',
    revokeHint: 'You can revoke this client any time in Settings → AI connections.',
    auto: {
      badgeReady: 'Ready to configure',
      badgeConfigured: 'Already configured',
      badgeUnknown: 'Config path unknown',
      badgeNotDetected: 'Not detected',
      badgeInvalid: 'Config cannot be parsed',
      oneClick: 'Write config for me',
      manual: 'Copy config manually',
      planTitle: 'Confirm the write',
      planPath: 'Config file',
      planBackup: 'Backup',
      planConflict: 'An existing brewphase entry will be replaced; your other MCP servers are untouched.',
      planNoConflict: 'A new brewphase entry will be added; nothing else in the file changes.',
      confirm: 'Write it',
      cancel: 'Cancel',
      writing: 'Writing…',
      successTitle: 'Config written',
      successHint: (name: string) => `Restart ${name} to pick it up.`,
      backupHint: (path: string) => `Original backed up to: ${path}`,
      failed: 'The write failed; the original file was restored.',
      rollbackFailed: 'The write failed and the automatic restore failed too. Restore the backup manually before using this agent.',
      fallback: 'Configure manually instead'
    },

    done: 'Done'
  }
}
