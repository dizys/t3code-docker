const T3ServiceModel = (() => {
  'use strict';
  const STATES = {
    running: ['Running', 'ok'], ready: ['Locally ready', 'ok'], starting: ['Starting', 'info'], restarting: ['Restarting', 'info'], uninstalled: ['Uninstalled', 'muted'],
    unhealthy: ['Unhealthy', 'warn'], failed: ['Failed', 'danger'], exited: ['Exited', 'muted'], stopped: ['Stopped for now', 'muted'], disabled: ['Disabled', 'muted'],
    'tool-unavailable': ['Tool unavailable', 'warn'], unavailable: ['Status unavailable', 'warn'], unknown: ['Not checked', 'muted'],
  };
  const state = row => {
    const value = row?.observation?.state || 'unknown', network = row?.observation?.networking;
    let pair = value === 'uninstalled' && !row.removal?.softwareRemoved ? ['Software cached', 'muted'] : STATES[value] || STATES.unknown;
    if (!row?.observation?.lastKnown) {
      if (['error', 'blocked'].includes(network?.state)) pair = ['Networking needs attention', 'warn'];
      else if (row?.config?.networkMode === 'kernel' && ['running', 'ready'].includes(value)) pair = ({ ready: network?.dns === 'ready' ? ['Network ready', 'ok'] : ['Connected · IP access', 'info'], 'needs-login': ['Sign-in needed', 'warn'], 'needs-approval': ['Approval needed', 'warn'], connecting: ['Connecting', 'info'] })[network?.state] || ['Networking not checked', 'muted'];
    }
    return { value, label: pair[0], tone: pair[1], busy: ['starting', 'restarting'].includes(value) || network?.state === 'connecting' };
  };
  const attention = row => ['unhealthy', 'failed', 'tool-unavailable', 'unavailable'].includes(state(row).value) || ['error', 'blocked', 'needs-login', 'needs-approval'].includes(row?.observation?.networking?.state);
  const networking = row => {
    const observed = row.observation?.networking;
    if (row.id !== 'tailscale' || row.domain !== 'system') return null;
    if (row.observation?.lastKnown) return { label: 'Networking status unavailable', message: 'Refresh Services before relying on last-known networking state.' };
    if ((row.config.networkMode || 'userspace') === 'userspace' && observed?.state !== 'error') return { label: 'Published routes only', message: observed?.message || 'Ordinary programs use deployment networking.' };
    const labels = { ready: observed?.dns === 'ready' ? 'Full networking · MagicDNS verified' : 'Full networking · MagicDNS off', 'needs-login': 'Full networking · Sign-in needed', 'needs-approval': 'Full networking · Approval needed', connecting: 'Full networking · Connecting', inactive: 'Full networking · Stopped', blocked: 'Full networking · Deployment change needed', error: 'Networking needs attention' };
    return { label: labels[observed?.state] || 'Full networking · Not checked', message: observed?.message || 'Networking readiness has not been checked yet.' };
  };
  const command = row => !row.config.mode ? row.config.name || row.id : row.config.mode === 'script' ? row.config.shell + ' · shell script' : [row.config.executable, ...(row.config.argv || [])].map(value => /^[\w./:@+-]+$/.test(value) ? value : JSON.stringify(value)).join(' ');
  const matches = (row, query) => [row.config.name, row.id, command(row), ...(row.config.tools || []).map(item => item.tool + '@' + item.version)].join(' ').toLowerCase().includes(query.toLowerCase());
  const terminal = operation => ['succeeded', 'failed', 'rolled-back', 'cancelled'].includes(operation?.state);
  const operationLabel = operation => ({ committed: 'Queued', 'network-control': 'Updating connector', 'waiting-for-connector': 'Waiting for connector', preflight: 'Checking prerequisites', stage: 'Downloading and verifying', configure: 'Saving configuration', activate: 'Starting and checking', restore: 'Restoring previous configuration', stopping: 'Stopping', 'removing-software': 'Removing software', succeeded: 'Completed', failed: 'Needs attention', 'rolled-back': 'Previous configuration restored' })[operation?.phase] || 'Working';
  const key = row => row.domain + ':' + row.id;
  const LIFECYCLE = {
    start: { label: 'Start', icon: 'play' }, restart: { label: 'Restart', icon: 'rotate-cw' }, stop: { label: 'Stop for now', icon: 'pause' },
    disable: { label: 'Disable at startup', icon: 'power' }, enable: { label: 'Enable', icon: 'power' }, install: { label: 'Install again…', icon: 'download' },
  };
  const lifecycleActions = (row, operations = []) => {
    const observed = row.observation;
    if (!observed || observed.lastKnown || ['unknown', 'unavailable'].includes(observed.state) || operations.some(op => op.domain === row.domain && op.target === row.id && !terminal(op))) return [];
    let actions;
    if (row.uninstalled) actions = ['install'];
    else if (!row.enabled) actions = ['enable'];
    else if (['stopped', 'exited', 'failed', 'tool-unavailable'].includes(observed.state) && !observed.process?.up) actions = ['start', 'disable'];
    else if (['starting', 'restarting'].includes(observed.state)) actions = ['stop', 'disable'];
    else actions = ['restart', 'stop', 'disable'];
    return actions.map(action => ({ action, ...LIFECYCLE[action] }));
  };
  const authenticationActions = (row, operations = []) => {
    if (row.domain !== 'system' || row.id !== 'tailscale' || !row.enabled || !row.artifact || row.uninstalled || row.observation?.lastKnown || !['running', 'ready'].includes(row.observation?.state)) return [];
    const connection = row.observation.connection;
    const starting = operations.some(operation => operation.domain === row.domain && operation.target === row.id && operation.action === 'sign-in' && !terminal(operation));
    if (connection?.state === 'NeedsLogin') return [connection.signInPending === true || starting ? 'continue-sign-in' : 'sign-in'];
    if (connection?.state === 'NeedsMachineAuth') return ['check-approval', 'sign-out'];
    return ['Running', 'Stopped'].includes(connection?.state) ? ['sign-out'] : [];
  };
  return { STATES, state, attention, networking, matches, command, terminal, operationLabel, key, authenticationActions, lifecycleActions };
})();
