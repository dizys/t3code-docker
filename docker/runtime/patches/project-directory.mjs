// Patches upstream source, never an executable or a user's project directory.
export const files = [
  "apps/server/src/cli/config.ts",
  "apps/server/src/config.ts",
  "apps/server/src/project/ManagedProjectFolders.ts",
];

function replaceOnce(text, before, after, file) {
  if (text.split(before).length !== 2) throw new Error(`The project-directory patch no longer matches ${file}. Review the upstream source before publishing this runtime.`);
  return text.replace(before, after);
}

export function patchProjectDirectory(source) {
  const next = { ...source };
  const change = (file, before, after) => { next[file] = replaceOnce(next[file], before, after, file); };
  change(files[0],
    '  t3Home: Config.String("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),',
    '  t3Home: Config.String("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),\n  projectsDir: Config.String("T3CODE_PROJECTS_DIR").pipe(\n    Config.option,\n    Config.map(Option.filter((value) => value.trim().length > 0)),\n    Config.map(Option.getOrUndefined),\n  ),');
  change(files[0],
    '  const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));',
    '  const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));\n  const projectsDir = env.projectsDir === undefined\n    ? undefined\n    : path.resolve(yield* expandHomePath(env.projectsDir.trim()));');
  change(files[0], '    baseDir,\n    ...derivedPaths,', '    baseDir,\n    ...(projectsDir === undefined ? {} : { projectsDir }),\n    ...derivedPaths,');
  change(files[1], '    readonly baseDir: string;', '    readonly baseDir: string;\n    readonly projectsDir?: string | undefined;');
  change(files[2], '  const namedProjectsRoot = path.resolve(config.baseDir, "projects");', '  const namedProjectsRoot = config.projectsDir ?? path.resolve(config.baseDir, "projects");');
  return next;
}
