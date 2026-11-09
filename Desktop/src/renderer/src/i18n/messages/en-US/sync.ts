/** Device sync (LAN pairing, device revocation, conflict resolution). */
export const sync = {
  overline: 'Device sync',
  headline: 'What you record on iPhone lands here on the desktop.',
  enable: 'Enable LAN sync',
  disable: 'Disable LAN sync',
  pairNew: 'Connect a new phone',
  running: (port: number, address: string) => `Running · port ${port} · ${address}`,
  startFailed: 'Service failed to start',
  pairing: {
    alt: 'Pairing QR code',
    scanHint: 'Scan with BrewPhase for iOS',
    instructions:
      "Open the camera in iPhone's More → Data → Desktop sync (or the Connect desktop card on the home screen) and scan. The code is valid for two minutes and can be used only once.",
    expiresIn: (clock: string) => `expires in ${clock}`,
    regenerate: 'New code'
  },
  devices: {
    title: 'Paired devices',
    empty: 'No paired devices yet.',
    lastSync: (when: string) => `Last sync ${when}`,
    revoke: 'Revoke access',
    revokeExplain:
      'Once revoked, this phone can no longer sync. You can also clear what it synced here: records, tags, canvases and media files — plus all coffee data (beans, brews and tastings, including anything entered on the Mac) — are deleted. Clearing cannot be undone.',
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
      'The phone deleted this record but the desktop edited it. Keep keeps both copies; accept deletes it on the desktop.',
    keepLocal: 'Keep desktop version',
    acceptDelete: 'Accept deletion',
    acceptRemote: 'Accept phone version',
    confirmDelete: 'Delete this record on the desktop? (already deleted on the phone)'
  }
}
