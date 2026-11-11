/** Device sync (LAN pairing, device revocation, conflict resolution). */
export const sync = {
  overline: 'Device sync',
  headline: 'What you record on a mobile device lands here on the desktop.',
  enable: 'Enable LAN sync',
  disable: 'Disable LAN sync',
  pairNew: 'Connect a new device',
  running: (port: number, address: string) => `Running · port ${port} · ${address}`,
  startFailed: 'Service failed to start',
  pairing: {
    alt: 'Pairing QR code',
    scanHint: 'Scan with BrewPhase on your mobile device',
    instructions:
      'Open BrewPhase on your mobile device and scan from its desktop sync entry (on iOS: More → Data → Desktop sync, or the Connect desktop card on the home screen). The code is valid for two minutes and can be used only once.',
    expiresIn: (clock: string) => `expires in ${clock}`,
    regenerate: 'New code'
  },
  devices: {
    title: 'Paired devices',
    empty: 'No paired devices yet.',
    lastSync: (when: string) => `Last sync ${when}`,
    revoke: 'Revoke access',
    revokeExplain:
      'Once revoked, this device can no longer sync. You can also clear what it synced here: records, tags, canvases and media files — plus all coffee data (beans, brews and tastings, including anything entered on the Mac) — are deleted. Canvases, notes and strokes you created on the Mac, and card positions you adjusted here, are deleted too. Clearing cannot be undone.',
    cancel: 'Cancel',
    revokeOnly: 'Revoke only',
    revokeAndWipe: 'Revoke and clear content',
    wiped: (
      records: number,
      tags: number,
      canvases: number,
      beans: number,
      brews: number,
      tastings: number,
      media: number
    ) =>
      `Cleared ${records} records, ${tags} tags, ${canvases} canvases, ${beans} beans (incl. ${brews} brews, ${tastings} tastings) and ${media} media files`
  },
  conflicts: {
    title: 'Conflicts',
    titleWithCount: (n: number) => `Conflicts · ${n}`,
    empty: 'When the same item changed on both sides it stops here for your decision — never silently overwritten.',
    deleteExplain:
      'The mobile device deleted this record but the desktop edited it. Keep keeps both copies; accept deletes it on the desktop.',
    keepLocal: 'Keep desktop version',
    acceptDelete: 'Accept deletion',
    acceptRemote: 'Accept mobile version',
    deleteTitle: 'Delete this record on the desktop?',
    deleteBody: 'It was already deleted on the mobile device. Accepting removes this copy too — this cannot be undone.'
  }
}
