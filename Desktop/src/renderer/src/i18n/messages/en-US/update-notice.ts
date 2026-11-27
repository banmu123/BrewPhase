/** In-app update notice and download progress: presentation only. */
export const updateNotice = {
  region: 'Update notice',
  title: 'BrewPhase has a new version',
  description: (version: string) => `Version ${version} is available.`,
  /** Shown **before** the download starts; the app will not ask twice. */
  restartHint: 'The app restarts automatically after updating. Save anything you are editing first.',
  /** Dismiss and remember this version; a newer one will be announced again. */
  later: 'Remind me later',
  /** Background download → verify → silent install → relaunch. */
  updateNow: 'Update now',
  /** Fallback when this build cannot update itself: open the GitHub download page. */
  manual: 'Download page',
  downloading: (percent: number) => `Downloading update… ${percent}%`,
  downloaded: 'Download complete. Preparing to install…',
  installing: 'Installing and restarting…',
  failed: 'Update failed',
  retry: 'Retry'
}
