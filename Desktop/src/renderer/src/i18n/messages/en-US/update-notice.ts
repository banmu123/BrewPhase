/** In-app update notice (global banner): announces only, never downloads. */
export const updateNotice = {
  region: 'Update notice',
  title: 'BrewPhase has a new version',
  description: (version: string) => `Version ${version} is out. Open the download page to get it.`,
  /** Dismiss and remember this version; a newer one will be announced again. */
  later: 'Remind me later',
  /** Opens the GitHub download page (URL whitelisted by the main process). */
  open: 'View update'
}
