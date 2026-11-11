import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ServiceError, hash } from "./store.mjs";
import { packageSpec, createMisePackages } from "./mise-packages.mjs";
import { protectedDirectory, protectedPath, protectedWrite, manifest } from "./storage.mjs";
export { protectedDirectory, protectedPath, protectedWrite, manifest, downloadVerified, systemStorage } from "./storage.mjs";
const exec = promisify(execFile);
export const CATALOGUE_FILE = "/opt/t3-services/catalogue.json";
export async function readCatalogue(file = CATALOGUE_FILE) {
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  if (data.schema !== 1 || !["arm64", "amd64"].includes(data.arch) || data.arch !== (process.arch === "x64" ? "amd64" : process.arch)) throw new ServiceError("catalogue", "This service catalogue does not match this image architecture.");
  return data;
}
export function createArtifacts({ root, catalogue, fetchImpl = fetch, run = exec, signal, packages: suppliedPackages, storage = { directory: protectedDirectory, path: protectedPath, write: protectedWrite, manifest } }) {
  const packages = suppliedPackages || createMisePackages({ root, fetchImpl, run, signal, storage });
  const selection = id => {
    const definition = catalogue.services[id];
    if (!definition) throw new ServiceError("invalid", "Choose an image-approved service.");
    return { ...definition, manager: 'mise', digest: hash(definition), arch: catalogue.arch, catalogue: hash(catalogue) };
  };
  const install = async (id, expected) => {
    const selected = selection(id);
    if (hash(selected) !== hash(expected)) throw new ServiceError("conflict", "The service catalogue changed. Review this installation again.");
    const directory = path.join(root, 'artifacts', id, 'mise-' + selected.digest);
    const specs = selected.payloads.map(item => packageSpec(item, selected.version, selected.arch));
    await storage.directory(directory);
    let receipt;
    try {
      await storage.path(directory + '/receipt.json', { directory: false });
      receipt = JSON.parse(await fs.readFile(directory + '/receipt.json', 'utf8'));
      if (receipt.manager !== 'mise' || receipt.digest !== selected.digest || receipt.arch !== selected.arch || hash(receipt.payloads) !== hash(selected.payloads)) throw new Error('receipt');
      if (receipt.complete) { for (const component of receipt.components) await packages.verify(component); return { ...receipt, recordPath: directory }; }
    } catch (error) { if (error.code !== 'ENOENT') throw new ServiceError('artifact-unsafe', 'An existing service installation is incomplete or unsafe. It was kept for inspection.'); }
    const space = await fs.statfs(root), bytes = selected.payloads.reduce((total, item) => total + item.bytes, 0);
    if (Number(space.bavail) * Number(space.bsize) < bytes * 8 + 128 * 1024 * 1024) throw new ServiceError('space', 'Free space is too low to stage and retain this service safely. Open Storage and retry.');
    // Persist ownership before installing any component. An interrupted stage
    // can be resumed or explicitly uninstalled without orphaning packages.
    receipt = { id, version: selected.version, manager: 'mise', arch: selected.arch, digest: selected.digest, catalogue: selected.catalogue, payloads: selected.payloads, components: specs, complete: false };
    await storage.write(directory + '/receipt.json', JSON.stringify(receipt) + '\n', 0o644);
    const components = [];
    const protectedComponents = (await Promise.all(Object.keys(catalogue.services).filter(other => other !== id).map(records))).flat().filter(item => item.complete && !item.cleanupOnly).flatMap(item => item.components || []);
    for (const spec of specs) components.push(await packages.install(spec, { keepIncomplete: protectedComponents.some(item => item.key === spec.key) }));
    const primary = components.find(item => item.name === (id === 'openssh' ? 'openssh-server' : id)) || components[0];
    const executable = await fs.realpath(path.join(primary.path, selected.executable));
    if (!executable.startsWith(primary.path + '/')) throw new ServiceError('artifact-unsafe', 'The service executable leaves its verified Mise package.');
    await fs.access(executable, constants.X_OK);
    receipt = { ...receipt, components, path: primary.path, recordPath: directory, complete: true, installedAt: Date.now() };
    await storage.write(directory + '/receipt.json', JSON.stringify(receipt) + '\n', 0o644);
    return receipt;
  };
  const records = async id => {
    if (!Object.hasOwn(catalogue.services, id)) throw new ServiceError('invalid', 'Choose an image-approved service.');
    const parent = path.join(root, 'artifacts', id);
    try { await storage.path(parent); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const name of await fs.readdir(parent)) {
      if (!/^(?:mise-)?[a-f0-9]{64}$/.test(name)) throw new ServiceError('artifact-unsafe', 'Unrecognized files in service storage were kept for inspection.');
      const directory = path.join(parent, name); await storage.path(directory);
      await storage.path(directory + '/receipt.json', { directory: false });
      const receipt = JSON.parse(await fs.readFile(directory + '/receipt.json', 'utf8'));
      if (receipt.id !== id || !Array.isArray(receipt.payloads) || receipt.manager === 'mise' && !Array.isArray(receipt.components)) throw new ServiceError('artifact-unsafe', 'A service installation record could not be verified for removal.');
      result.push({ ...receipt, recordPath: directory });
    }
    return result;
  };
  const remove = async (id, { references = () => [] } = {}) => {
    const owned = await records(id);
    const foreign = (await Promise.all(Object.keys(catalogue.services).filter(other => other !== id).map(records))).flat();
    const components = new Map(); let removed = 0;
    for (const receipt of owned) {
      if (references().some(item => (item.recordPath || item.path) === receipt.recordPath)) continue;
      for (const component of receipt.components || []) components.set(component.key, component);
      // Keep the receipt until package removal is complete, so repeating after
      // a crash knows exactly which installations still need to be removed.
    }
    const retained = [];
    for (const component of components.values()) {
      const needed = [...foreign.filter(item => !item.cleanupOnly), ...references()].some(item => item.components?.some(other => other.key === component.key) || item.payloads?.some(other => other.name === component.name && (other.version || item.version) === component.version && other.sha256 === component.sha256));
      if (needed) retained.push({ name: component.name, version: component.version });
      else await packages.remove(component);
    }
    for (const receipt of owned) {
      if (references().some(item => (item.recordPath || item.path) === receipt.recordPath)) continue;
      await storage.path(receipt.recordPath);
      if (receipt.components?.some(component => retained.some(item => item.name === component.name && item.version === component.version))) {
        await storage.write(receipt.recordPath + '/receipt.json', JSON.stringify({ ...receipt, complete: false, cleanupOnly: true }) + '\n', 0o644);
      } else { await fs.rm(receipt.recordPath, { recursive: true, force: true }); removed++; }
    }
    return { softwareRemoved: true, removedInstallations: removed, retainedPackages: retained, settingsRetained: true, identitiesRetained: true };
  };
  return { selection, install, remove };
}
