// T3 Code's side of a gateway, through the same API its own settings page uses,
// so T3's validation, secret store and policy checks all apply. Settings go
// through T3 rather than its file: T3 owns that file and writes it too.

/** What T3 knows right now. Throws if it can't be asked. */
export function createGatewayT3(api) {
  const read = async () => {
    // One call: the config carries redacted settings beside the live providers.
    const config = await api.call('server.getConfig', {}), settings = config?.settings;
    if (!settings || typeof settings.providerInstances !== 'object' || settings.providerInstances === null) throw Object.assign(new Error('This version of T3 Code can’t manage provider instances. Update T3 Code on the Updates page.'), { code: 'unsupported' });
    return { instances: settings.providerInstances, providers: Array.isArray(config.providers) ? config.providers : [], preferences: settings.providerModelPreferences ?? {} };
  };
  const mutate = (providerInstanceMutation) => api.call('server.updateSettings', { patch: {}, providerInstanceMutation });
  return {
    read,
    upsert: (instanceId, instance) => mutate({ operation: 'upsert', instanceId, instance }),
    remove: instanceId => mutate({ operation: 'remove', instanceId }),
    /** Have T3 check an instance again, for when nothing about it needs changing. */
    refresh: instanceId => api.call('server.refreshProviders', { instanceId }),
    /** One change per model: T3 applies these to its current list, so nothing else is overwritten. */
    setModelsHidden: changes => api.call('server.updateSettings', { patch: { setModelsHidden: changes } }),
  };
}
