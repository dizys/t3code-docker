const T3ServiceModel = (() => {
  'use strict';
  const STATES = {
    running: ['Running', 'ok'], ready: ['Locally ready', 'ok'], starting: ['Starting', 'info'], restarting: ['Restarting', 'info'], uninstalled: ['Payload removed', 'muted'],
    unhealthy: ['Unhealthy', 'warn'], failed: ['Failed', 'danger'], exited: ['Exited', 'muted'], stopped: ['Stopped for now', 'muted'], disabled: ['Disabled', 'muted'],
    'tool-unavailable': ['Tool unavailable', 'warn'], unavailable: ['Status unavailable', 'warn'], unknown: ['Not checked', 'muted'],
  };
  const state = row => { const value = row?.observation?.state || 'unknown', pair = STATES[value] || STATES.unknown; return { value, label: pair[0], tone: pair[1], busy: ['starting', 'restarting'].includes(value) }; };
  const attention = row => ['unhealthy', 'failed', 'tool-unavailable', 'unavailable'].includes(state(row).value);
  const command = row => !row.config.mode ? row.config.name || row.id : row.config.mode === 'script' ? row.config.shell + ' · shell script' : [row.config.executable, ...(row.config.argv || [])].map(value => /^[\w./:@+-]+$/.test(value) ? value : JSON.stringify(value)).join(' ');
  const matches = (row, query) => [row.config.name, row.id, command(row), ...(row.config.tools || []).map(item => item.tool + '@' + item.version)].join(' ').toLowerCase().includes(query.toLowerCase());
  const terminal = operation => ['succeeded', 'failed', 'rolled-back', 'cancelled'].includes(operation?.state);
  const operationLabel = operation => ({ committed: 'Queued', 'network-control': 'Updating connector', 'waiting-for-connector': 'Waiting for connector', preflight: 'Checking prerequisites', stage: 'Downloading and verifying', configure: 'Saving configuration', activate: 'Starting and checking', restore: 'Restoring previous configuration', stopping: 'Stopping', succeeded: 'Completed', failed: 'Needs attention', 'rolled-back': 'Previous configuration restored' })[operation?.phase] || 'Working';
  const key = row => row.domain + ':' + row.id;
  const authenticationActions = (row, operations = []) => {
    if (row.domain !== 'system' || row.id !== 'tailscale' || !row.enabled || !row.artifact || row.uninstalled || row.observation?.lastKnown || !['running', 'ready'].includes(row.observation?.state)) return [];
    const connection = row.observation.connection;
    const starting = operations.some(operation => operation.domain === row.domain && operation.target === row.id && operation.action === 'sign-in' && !terminal(operation));
    if (connection?.state === 'NeedsLogin') return [connection.signInPending === true || starting ? 'continue-sign-in' : 'sign-in'];
    if (connection?.state === 'NeedsMachineAuth') return ['check-approval', 'sign-out'];
    return ['Running', 'Stopped'].includes(connection?.state) ? ['sign-out'] : [];
  };
  return { STATES, state, attention, matches, command, terminal, operationLabel, key, authenticationActions };
})();
