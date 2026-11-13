/** AI Workspace (Multi-AI) copy. */
export const aiWorkspace = {
  title: 'AI Workspace',
  nav: {
    multi: 'Multi-AI',
    conversations: 'Conversations',
    accounts: 'Accounts'
  },
  providers: {
    chatgpt: 'GPT',
    claude: 'Claude'
  },
  login: {
    logged_in: 'Signed in',
    logged_out: 'Signed out',
    unknown: 'Unknown',
    not_open: 'Page not opened'
  },
  taskState: {
    idle: 'Idle',
    checking: 'Checking page…',
    ready: 'Ready',
    sending: 'Sending…',
    generating: 'Generating…',
    completed: 'Completed',
    login_required: 'Sign-in required',
    page_unavailable: 'Page unavailable',
    unsupported_page: 'Page not operable',
    timeout: 'Timed out',
    failed: 'Failed',
    cancelled: 'Cancelled'
  },
  ask: {
    placeholder: 'Ask one question, hear both sides…',
    submit: 'Ask both',
    submitBusy: 'Running…',
    stop: 'Stop task',
    clear: 'Clear',
    pickHint: 'Pick the platforms to ask (multiple allowed)',
    emptyHint: 'Both answers will appear side by side. First time? Confirm sign-in under "Accounts".'
  },
  result: {
    viewSource: 'View source page',
    copy: 'Copy answer',
    copied: 'Copied',
    noContent: 'Could not extract the answer — the page may have changed. Check the source page.',
    notePrefix: 'Note:'
  },
  accounts: {
    title: 'Accounts & sign-in',
    lead: 'AI Workspace uses the built-in browser’s sign-in state. It never reads or exports credentials. Sign in once and it stays.',
    openLogin: 'Open sign-in page',
    reloadStatus: 'Refresh status',
    urlLabel: 'Current page',
    empty: 'This platform has no open page yet. Click "Open sign-in page" to start.'
  },
  conversations: {
    title: 'Conversations',
    lead: 'Every "Ask both" is saved here with your question and each platform’s answer.',
    empty: 'No records yet. Start your first discussion in Multi-AI.',
    delete: 'Delete',
    back: 'Back to list',
    question: 'Question'
  }
}
