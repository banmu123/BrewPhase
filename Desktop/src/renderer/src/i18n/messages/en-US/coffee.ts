/** Coffee module wording — keep in sync with zh-CN/coffee.ts. */
export const coffee = {
  title: 'Coffee',
  subtitle: 'Observe & experiment',
  shelfSummary: (n: number) => `Your coffee shelf · ${n} ${n === 1 ? 'bag' : 'bags'} on shelf`,
  currentlyBrewing: 'Currently Brewing',
  addBean: 'Add bean',
  collapseForm: 'Hide form',
  unnamedBean: 'Untitled bean',
  noRoaster: 'No roaster',
  noMethod: 'No method',
  noFlavor: 'No flavor notes',
  beanDetail: 'Bean details',
  closeDetail: 'Close details',
  beanProfile: 'Bean profile',
  editProfile: 'Edit profile',
  phaseWindow: 'Flavor window',
  roastedOn: (date: string) => `Roasted ${date}`,
  dayCount: (n: number) => `Day ${n}`,
  status: {
    active: 'Brewing',
    finished: 'Finished'
  },
  brews: (n: number) => `Brews · ${n}`,
  tastings: (n: number) => `Tastings · ${n}`,
  logBrew: 'Log a brew',
  deleteBrewTitle: 'Delete this brew; stock is restored by the deducted amount',
  deleteBean: 'Delete this bean',
  confirmDeleteBean: (name: string) => `Delete “${name}”? Its brews and tastings will be deleted too.`,
  windowNote: (restMin: number, restMax: number, peakStart: number, peakEnd: number, declineStart: number) =>
    `Rest ${restMin}–${restMax} days · Peak ${peakStart}–${peakEnd} days · Declining from day ${declineStart}`,
  windowNoteHint: 'Estimated from the default window; this is not a best-before conclusion.',
  newBean: 'A new bag of beans',
  form: {
    name: 'Name',
    roaster: 'Roaster',
    roastLevel: 'Roast level',
    roastDate: 'Roast date',
    openDate: 'Opened date',
    weightG: 'Total g',
    remainingG: 'Remaining g',
    price: 'Price'
  },
  placeholder: {
    name: 'e.g. Colombia Pink Bourbon',
    roaster: 'e.g. Onibus'
  },
  roastLevel: {
    light: 'Light',
    medium: 'Medium',
    mediumDark: 'Medium-dark',
    dark: 'Dark',
    espressoBlend: 'Espresso blend'
  },
  phase: {
    resting: { title: 'Resting', hint: 'Still resting' },
    opening: { title: 'Opening up', hint: 'Flavors starting to open' },
    peak: { title: 'Peak flavor', hint: 'Drink now' },
    declining: { title: 'Declining', hint: 'Drink soon' }
  },
  stockNote:
    'Changing “Remaining g” counts as a stocktake: earlier brews no longer auto-restore powder.',
  empty: {
    noBeans: 'No beans yet. Add a bag first; brews and tastings will be attached to it.',
    noBrews: 'No brews yet. Log one and stock will be deducted by the actual dose.',
    noTastings: 'No tastings yet. Logging a brew leaves one automatically.',
    noRule: 'No rule available.'
  },
  brew: {
    method: 'Method',
    grind: 'Grind',
    coffeeG: 'Dose g',
    waterG: 'Water g',
    waterTemp: 'Temp ℃',
    time: 'Time (s)',
    score: 'Score',
    notes: 'Notes',
    save: 'Save this brew'
  }
}
