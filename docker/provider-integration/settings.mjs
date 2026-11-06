// Pure edits to T3 Code's provider settings, plus the atomic file IO around them.
//
// T3 stores per-provider configuration in `<T3CODE_HOME>/userdata/settings.json`
// (`ServerConfig.deriveServerPaths`). The supported integration seam is that
// file's per-provider `binaryPath`, which the driver spawns verbatim on Linux.
// Two representations exist:
//
//   * `providers.<driverKind>` - the retired one-instance-per-driver map.
//     T3 0.1.0 migrates it into `providerInstances` on load and then rewrites
//     the file without it, so writing it again would only churn. An existing
//     legacy map is still mirrored for older runtimes that share this file.
//   * `providerInstances.<driverKind>.config.binaryPath` - the current
//     driver-agnostic map, keyed here by the default instance id (the driver
//     kind itself). It wins over any legacy mirror.
//
// A missing default instance is created from the legacy blob when one exists,
// carrying its config and explicit `enabled` flag across, so synthesising it
// cannot silently change enablement. Every unrelated key is preserved.
import { randomBytes } from "node:crypto";
import path from "node:path";

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The directory T3 treats as its base (`--base-dir` / `T3CODE_HOME`). */
export function baseDirFor(env = {}, home) {
  const explicit = typeof env.T3CODE_HOME === "string" ? env.T3CODE_HOME.trim() : "";
  if (explicit) return explicit;
  return path.join(home, ".t3");
}

/** The T3 settings file the provider seam lives in. */
export function settingsPathFor(baseDir) {
  return path.join(baseDir, "userdata", "settings.json");
}

/** This module's record of what it wrote, so it can retract only its own edits. */
export function statePathFor(baseDir) {
  return path.join(baseDir, "provider-integration.json");
}

/**
 * Whether the managed path may be written over `current`. Only values nobody
 * chose are ours to replace: absent, empty, T3's own default name, a path this
 * module wrote or manages (`owned`: what it wrote last time, and the managed
 * executable itself, which an older image wrote before launchers), or an
 * absolute path that no longer exists (`dead`) - an old image's
 * /opt/npm-global/bin/claude, say, which T3 could never launch again. A
 * wrapper script or a different install someone pointed T3 at in its settings
 * stays theirs.
 */
export function replaceable(current, { owned = null, defaultBinary = null, dead = null } = {}) {
  if (current === undefined || current === null) return true;
  const value = String(current).trim();
  if (value === "") return true;
  if (defaultBinary && value === defaultBinary) return true;
  if (dead?.has(value)) return true;
  return [].concat(owned ?? []).filter(Boolean).includes(value);
}

/** Both places T3 may hold a provider's binaryPath, for the dead-path check. */
export function binaryPathsFor(settings, driver) {
  return [
    settings.providers?.[driver]?.binaryPath,
    settings.providerInstances?.[driver]?.config?.binaryPath,
  ].filter((value) => typeof value === "string" && value.trim() !== "").map((value) => value.trim());
}

/**
 * Point one provider's default instance, and its legacy mirror when that map
 * is already present, at `executable`. A missing instance is created from the
 * legacy blob, preserving its other config and explicit enablement. A
 * `binaryPath` someone set themselves in either representation is left alone
 * (`kept`), and nothing is changed.
 */
export function applyManaged(settings, driver, executable, ownership = {}) {
  const hasLegacyMap = isObject(settings.providers);
  const providers = hasLegacyMap ? { ...settings.providers } : {};
  const legacy = isObject(providers[driver]) ? { ...providers[driver] } : {};
  const instances = settings.providerInstances;
  const instancesUsable = isObject(instances);
  const instance = instancesUsable && isObject(instances[driver]) ? instances[driver] : null;
  const instanceConfig = instance && isObject(instance.config) ? { ...instance.config } : {};
  const currents = [legacy.binaryPath, instance ? instanceConfig.binaryPath : undefined];
  if (currents.some((value) => value !== undefined && value !== executable && !replaceable(value, ownership))) {
    return { settings, changed: false, kept: true };
  }

  let next = settings;
  let changed = false;
  if (hasLegacyMap && legacy.binaryPath !== executable) {
    legacy.binaryPath = executable;
    providers[driver] = legacy;
    next = { ...next, providers };
    changed = true;
  }

  if (instance) {
    if (instanceConfig.binaryPath !== executable) {
      instanceConfig.binaryPath = executable;
      next = {
        ...next,
        providerInstances: { ...instances, [driver]: { ...instance, config: instanceConfig } },
      };
      changed = true;
    }
  } else if (instances === undefined || instancesUsable) {
    const config = {};
    for (const [key, value] of Object.entries(legacy)) {
      if (key !== "enabled") config[key] = value;
    }
    config.binaryPath = executable;
    next = {
      ...next,
      providerInstances: {
        ...(instancesUsable ? instances : {}),
        [driver]: {
          driver,
          ...(typeof legacy.enabled === "boolean" ? { enabled: legacy.enabled } : {}),
          config,
        },
      },
    };
    changed = true;
  }

  return { settings: next, changed, kept: false };
}

/**
 * T3 0.0.44 can install Codex itself ("managed setup"). When someone chose
 * that, the executable is T3's to pick, and this module stays out of it.
 */
export function t3ManagesItself(settings, driver) {
  if (isObject(settings.providers?.[driver]) && settings.providers[driver].setupMode === "managed") return true;
  const instance = settings.providerInstances?.[driver];
  return isObject(instance) && isObject(instance.config) && instance.config.setupMode === "managed";
}

/**
 * Send an agent back to the CLI's own sign-in, the same switch as T3's "Use
 * existing CLI". Only the mode changes: enablement, every other key and the
 * connection T3 saved in its secret store all stay as they are.
 */
export function useExistingSetup(settings, driver) {
  let next = settings;
  let changed = false;
  const legacy = settings.providers?.[driver];
  if (isObject(legacy) && legacy.setupMode === "managed") {
    next = { ...next, providers: { ...settings.providers, [driver]: { ...legacy, setupMode: "existing" } } };
    changed = true;
  }
  const instance = settings.providerInstances?.[driver];
  if (isObject(instance) && isObject(instance.config) && instance.config.setupMode === "managed") {
    next = {
      ...next,
      providerInstances: {
        ...settings.providerInstances,
        [driver]: { ...instance, config: { ...instance.config, setupMode: "existing" } },
      },
    };
    changed = true;
  }
  return { settings: next, changed };
}

/**
 * Retract a previously written `binaryPath`, but only where it is still exactly
 * the value this module recorded. A user who edited the field themselves keeps
 * their edit; the module stops tracking it.
 */
export function clearManaged(settings, driver, recordedExecutable) {
  let next = settings;
  let changed = false;

  const providers = isObject(settings.providers) ? { ...settings.providers } : {};
  const legacy = providers[driver];
  if (isObject(legacy) && legacy.binaryPath === recordedExecutable) {
    const copy = { ...legacy };
    delete copy.binaryPath;
    providers[driver] = copy;
    next = { ...next, providers };
    changed = true;
  }

  const instances = settings.providerInstances;
  if (isObject(instances) && isObject(instances[driver])) {
    const instance = instances[driver];
    if (isObject(instance.config) && instance.config.binaryPath === recordedExecutable) {
      const config = { ...instance.config };
      delete config.binaryPath;
      next = {
        ...next,
        providerInstances: { ...instances, [driver]: { ...instance, config } },
      };
      changed = true;
    }
  }

  return { settings: next, changed };
}

/**
 * Read a JSON file. A missing file is `null`; malformed JSON is an error the
 * caller must not paper over by overwriting whatever is there.
 */
export async function readJson(fs, file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { value: null, error: null };
    return { value: null, error: String(error?.message ?? error) };
  }
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    return { value: null, error: `${file} is not valid JSON: ${String(error?.message ?? error)}` };
  }
}

/** Replace a file atomically, so a crash never leaves it half-written, and nothing runs half of it.
 * The temp file is created exclusively, and a name collision picks a fresh name. */
export async function writeFileAtomic(fs, file, text, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
    try {
      await fs.writeFile(tmp, text, { encoding: "utf8", mode, flag: "wx" });
    } catch (error) {
      if (error?.code === "EEXIST" && attempt < 4) continue;
      throw error;
    }
    await fs.rename(tmp, file);
    return;
  }
}

/** Replace a JSON file atomically. */
export function writeJsonAtomic(fs, file, value, mode = 0o600) {
  return writeFileAtomic(fs, file, `${JSON.stringify(value, null, 2)}\n`, mode);
}
