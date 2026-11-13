/** AI connections (MCP client authorization, tokens, config copy, bridge status). */
export const mcp = {
  overline: 'AI connections',
  reopenGuide: 'Reopen the setup guide',
  headline: 'Let agents like Codex or WorkBuddy read and write your BrewPhase.',
  intro:
    'Each client is authorized and revoked separately; permission checks run in the desktop main process. Agents get no database access and no delete capability. Writes stay on this Mac (nothing is pushed back to the mobile device automatically).',
  bridge: {
    running: (socket: string) => `Bridge: running · ${socket}`,
    stopped: 'Bridge: not running',
    unsupported: '(local Bridge is not supported on this platform in V1)'
  },
  created: {
    title: (name: string) => `"${name}" created — the token is shown only this once`,
    copyToken: 'Copy token',
    copyCodex: 'Copy Codex config',
    copyWorkBuddy: 'Copy WorkBuddy config',
    dismiss: 'Saved — hide'
  },
  create: {
    title: 'New client',
    name: 'Name',
    namePlaceholder: 'e.g. Codex / WorkBuddy',
    submit: 'Create and generate token',
    scopeGroup: {
      records: 'Records',
      tags: 'Tags',
      coffee: 'Coffee',
      workContext: 'Work context',
      canvas: 'Canvas',
      direction: 'Personal direction'
    }
  },
  clients: {
    title: 'Authorized clients',
    empty: 'No authorized clients yet.',
    revoked: '(revoked)',
    lastUsed: (when: string) => `Last used: ${when}`,
    revoke: 'Revoke',
    revokeConfirm: 'Confirm revoke'
  },
  local: {
    title: 'Local connection info',
    entry: 'MCP entry',
    dataDir: 'Data folder',
    command: 'Launch command',
    buildHint: (command: string) => `Run ${command} first and keep BrewPhase Desktop open.`,
    copyInfo: 'Copy launch info'
  }
}
