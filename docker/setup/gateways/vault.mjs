// A gateway's key is a Vault credential of the API token type, so it can be
// rotated in one place and agents can reach the gateway by name too. T3 Code has
// no way to read the Vault itself, so each instance holds a copy in T3's own
// secret store, and `secretChangedAt` says whether that copy is current.
const TOKEN = 'token';

const row = credential => ({ id: credential.id, description: credential.description || '', baseUrl: credential.fields?.baseUrl ?? null, changedAt: credential.secretChangedAt ?? null });

export function createGatewayVault(store) {
  const list = async () => (await store.list()).credentials.filter(credential => credential.type === TOKEN && credential.secretNames?.includes('token')).map(row);
  return {
    list,
    read: async id => (await store.forUse(id)).secrets?.token ?? '',
    available: async id => {
      const taken = new Set((await store.list()).credentials.map(credential => credential.id));
      if (!taken.has(id)) return id;
      for (let index = 2; index < 100; index++) if (!taken.has(`${id}-${index}`)) return `${id}-${index}`;
      throw Object.assign(new Error('Too many similar credentials in the Vault. Remove one and try again.'), { code: 'invalid' });
    },
    create: async ({ id, name, url, key }) => {
      const { credential } = await store.save({ create: true, origin: { by: 'setup' }, credential: { id, type: TOKEN, description: `Key for the ${name} gateway`,
        fields: { baseUrl: `${url}/v1/`, authType: 'bearer', testPath: 'models' }, secrets: { token: key } } });
      return row(credential);
    },
    replace: async (id, key) => {
      const current = await store.public(id);
      const { credential } = await store.save({ revision: current.revision, origin: { by: 'setup' }, credential: { id, type: current.type, secrets: { token: key } } });
      return row(credential);
    },
    remove: async id => { const current = await store.public(id); await store.remove({ id, revision: current.revision }); },
  };
}
