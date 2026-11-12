/**
 * Personal Direction copy (English).
 *
 * Same tone rules as the Chinese: no nudging, no scoring, no promises.
 * Nothing here should make the user feel they are being graded.
 */
export const direction = {
  overline: 'PERSONAL DIRECTION',
  title: 'My direction',
  subtitle: 'From where you are to where you want to be',

  empty: {
    title: 'No direction written down yet',
    body: 'Describe what you are doing now and where you want to go. Nothing has to be complete — you can add to it later.',
    action: 'Start mapping'
  },

  status: {
    proposed: 'Proposed',
    active: 'In progress',
    paused: 'Paused',
    completed: 'Completed',
    achieved: 'Achieved',
    dropped: 'Set aside',
    revised: 'Revised'
  },

  currentState: {
    title: 'Where I am',
    review: 'Continue mapping',
    empty: 'Not described yet'
  },

  stage: {
    current: 'Current stage',
    none: 'No stage yet',
    criteria: 'Done when',
    noCriteria: 'No completion criteria yet',
    horizon: 'Time frame'
  },

  proposal: {
    title: 'WorkBuddy left a proposal',
    more: (count: number) => `${count} more waiting`,
    hint: 'It becomes part of your record only after you confirm it',
    fromState: 'About your current state',
    fromDirection: 'A direction',
    fromStage: 'A stage goal',
    confirm: 'Confirm',
    discard: 'Dismiss'
  },

  wizard: {
    title: 'Map my direction',
    step: (current: number, total: number) => `Step ${current} of ${total}`,
    skip: 'Skip this step',
    back: 'Back',
    next: 'Next',
    finish: 'Save',
    saving: 'Saving…',
    saveError: 'Could not save. Please try again.',
    saved: 'Saved. You can change any of it later.',

    state: {
      title: 'Where you are now',
      hint: 'Write as much or as little as you like. Only you can see this, and it can change later.',
      summary: 'Describe yourself in a sentence or two',
      summaryPlaceholder: 'e.g. A steady job, and evenings spent trying to build my own product.',
      workStatus: 'Work and career',
      capabilities: 'Skills, experience and resources',
      ongoing: 'What you are working on',
      capacity: 'Time and energy you can give',
      constraints: 'Limits, difficulties, what you are unhappy with',
      other: 'Anything else that matters'
    },

    dir: {
      title: 'What you want to become',
      hint: 'No need to quantify it or turn it into a KPI. Describe the state you actually want.',
      name: 'Direction',
      namePlaceholder: 'e.g. Become an independent developer',
      description: 'What that looks like',
      descriptionPlaceholder: 'What would your days, income and pace look like then?',
      motivation: 'Why you want it'
    },

    stage: {
      title: 'How this stretch goes',
      hint: 'Cut the direction into one verifiable stretch. It is fine to save it without criteria.',
      name: 'Stage name',
      namePlaceholder: 'e.g. Ship the first version people can pay for',
      goal: 'What this stage is for',
      criteria: 'Done when',
      criteriaPlaceholder: 'How would you know it is done? Write something observable.',
      horizon: 'Expected time frame',
      horizonPlaceholder: 'e.g. Three to six months'
    },

    review: {
      title: 'One last look',
      hint: 'You can change any of this later. Writing it down is not a commitment.',
      state: 'Current state',
      directionLabel: 'Direction',
      stageLabel: 'Stage',
      nothing: 'Nothing filled in yet. You can save just a direction, or go back and add more.'
    }
  },

  actions: {
    addStage: 'Add a stage',
    pause: 'Pause',
    resume: 'Resume',
    achieve: 'Mark achieved',
    drop: 'Set aside',
    edit: 'Edit',
    remove: 'Delete',
    removeConfirm: 'Delete this direction? Its stages go with it.'
  }
}
