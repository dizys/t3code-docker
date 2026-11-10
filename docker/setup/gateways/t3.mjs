// T3 Code's side of a gateway, through the same API its own settings page uses,
// so T3's validation, secret store and policy checks all apply. Settings go
// through T3 rather than its file: T3 owns that file and writes it too.

const HUB_REPORT_MS = 4000;

/** What T3 knows right now. Throws if it can't be asked. */
export function createGatewayT3(api) {
  const read = async () => {
    // One call: the config carries redacted settings beside the live providers.
    const config = await api.call('server.getConfig', {}), settings = config?.settings;
    if (!settings || typeof settings.providerInstances !== 'object' || settings.providerInstances === null) throw Object.assign(new Error('This version of T3 Code can’t manage provider instances. Update T3 Code on the Updates page.'), { code: 'unsupported' });
    return { instances: settings.providerInstances, providers: Array.isArray(config.providers) ? config.providers : [], preferences: settings.providerModelPreferences ?? {},
      // Older releases have no hubs at all, which is different from having none.
      hubs: 'usageLimitSources' in settings, hubSources: settings.usageLimitSources ?? {},
      customModelCapabilityOverrides: config.customModelCapabilityOverrides === true,
      gatewayModelLimits: config.gatewayModelLimits === true };
  };
  const mutate = (providerInstanceMutation) => api.call('server.updateSettings', { patch: {}, providerInstanceMutation });
  return {
    read,
    upsert: (instanceId, instance) => mutate({ operation: 'upsert', instanceId, instance }),
    remove: instanceId => mutate({ operation: 'remove', instanceId }),
    /** Have T3 check an instance again, for when nothing about it needs changing. */
    refresh: instanceId => api.call('server.refreshProviders', instanceId ? { instanceId } : {}),
    refreshLimits: () => api.call('server.refreshProviders', {}, { timeoutMs: 90_000 }),
    /** A hub for Usage → Limits, or null to remove it. A redacted key sent back keeps the saved one. */
    setHub: (id, source) => api.call('server.updateSettings', { patch: { usageLimitSources: { [id]: source } } }),
    /**
     * What each hub last reported. T3 only sends this on its config stream, to a
     * client that asks, and the stream opens with the current set. So: one look, then
     * close. It rejects rather than answering "none", because that would read as a fact.
     */
    hubReports: ({ timeoutMs = HUB_REPORT_MS } = {}) => new Promise((resolve, reject) => {
      let stream = null, done = false;
      const finish = (value, error) => { if (done) return; done = true; clearTimeout(timer); stream?.close(); if (error) reject(error); else resolve(value); };
      const timer = setTimeout(() => finish(null, new Error('T3 Code sent no hub reports.')), timeoutMs);
      api.subscribe('subscribeServerConfig', { usageLimitSources: true },
        event => { if (event?.type === 'usageLimitSourcesUpdated') finish(Array.isArray(event.payload?.sources) ? event.payload.sources : []); },
        error => finish(null, error ?? new Error('T3 Code closed the config stream.')))
        .then(handle => { stream = handle; if (done) handle.close(); }, error => finish(null, error));
    }),
    /** One change per model: T3 applies these to its current list, so nothing else is overwritten. */
    setModelsHidden: changes => api.call('server.updateSettings', { patch: { setModelsHidden: changes } }),
  };
}
