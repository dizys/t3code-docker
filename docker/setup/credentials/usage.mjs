import * as fs from 'node:fs/promises';
import path from 'node:path';
import { scanSkillFiles, readSkillFile, skillMetadata, skillProviders } from '../skills.mjs';
import { readAgentsMd } from '../context.mjs';

export function credentialMentions(content) {
  return new Set([...String(content).matchAll(/(?:^|[^\w-])t3-(?:ssh|api)\s+(['"]?)([a-z0-9]+(?:-[a-z0-9]+)*)\1(?![\w-])/g)].map(match => match[2]));
}
export function createCredentialUsage({ home = process.env.HOME || '/home/t3', baseDir = process.env.T3CODE_HOME || path.join(home, '.t3'), env = process.env, io = fs, scan = scanSkillFiles, readFile = readSkillFile, instructions = readAgentsMd, installed = async () => [], clock = Date.now, ttlMs = 15000, limits } = {}) {
  let cache = null, pending = null, generation = 0;
  const scanAll = async () => {
    const providers = skillProviders(), warnings = new Set(), files = new Map(), usage = new Map();
    const installedIds = await installed().catch(() => []);
    const scans = await Promise.all(providers.map(async provider => {
      try { return { provider, data: await scan(provider.id, { home, env, io, limits }) }; }
      catch { return { provider, data: { skills: [], warnings: ['scan-failed'] } }; }
    }));
    for (const { provider, data } of scans) {
      if (data.warnings.length) warnings.add('Some ' + provider.name + ' skills could not be read.');
      for (const row of data.skills) {
        if (row.error) { warnings.add('Some skills could not be read.'); continue; }
        try {
          const real = row.resolvedPath || await io.realpath(row.path);
          if (!files.has(real)) files.set(real, { row, providers: new Set() });
          files.get(real).providers.add(provider.id);
        } catch { warnings.add('Some skills could not be read.'); }
      }
    }
    const add = (id, item) => { if (!usage.has(id)) usage.set(id, []); usage.get(id).push(item); };
    let bytes = 0, count = 0;
    for (const [file, entry] of files) {
      // A bounded second pass reads each real file once, even in shared roots.
      if (++count > 512 || bytes + 65536 > 8 * 1024 * 1024) { warnings.add('The skill scan reached its safety limit; some mentions may be missing.'); break; }
      try {
        const read = await readFile(file, 65536, io); bytes += read.bytes;
        const name = skillMetadata(read.content, path.basename(path.dirname(entry.row.path))).name;
        const where = installedIds.length && installedIds.every(id => entry.providers.has(id)) ? 'All agents' : providers.filter(provider => entry.providers.has(provider.id)).map(provider => provider.name).join(', ');
        for (const id of credentialMentions(read.content)) add(id, { kind: 'skill', name, where });
      } catch { warnings.add('Some skills could not be read.'); }
    }
    try {
      const global = await instructions(io, baseDir);
      if (global.error) warnings.add('Global instructions could not be read.');
      else if (global.content) for (const id of credentialMentions(global.content)) add(id, { kind: 'instructions', name: 'Global instructions' });
    } catch { warnings.add('Global instructions could not be read.'); }
    return { usage, usageAt: new Date(clock()).toISOString(), usageWarnings: [...warnings] };
  };
  const read = async () => {
    if (cache && clock() - cache.at < ttlMs) return cache.value;
    if (pending) return pending;
    const seen = generation;
    const work = scanAll(); pending = work;
    try { const value = await work; if (seen === generation) cache = { at: clock(), value }; return value; }
    finally { if (pending === work) pending = null; }
  };
  return { invalidate() { generation++; cache = null; pending = null; }, async annotate(credentials) {
    const value = await read();
    return { credentials: credentials.map(credential => ({ ...credential, usedIn: value.usage.get(credential.id) || [] })), usageAt: value.usageAt, usageWarnings: value.usageWarnings };
  } };
}
