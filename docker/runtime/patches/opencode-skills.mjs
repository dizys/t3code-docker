// Wait for native discovery completion, never infer readiness from built-in commands.
export const files = [
  "packages/provider-opencode/src/server/driver.ts",
  "packages/provider-opencode/src/server/status.ts",
];

const shapes = [
  {
    directory: "cwd",
    comment: "/**\n * A server scans a directory it has not served yet in the background: its first read lists\n * no commands at all (not even the built-ins), and `command.updated` plus `skill.updated`\n * for the directory end the scan. `scanned` must be listening before `read` runs, since\n * the read is what starts the scan.\n */\n",
    loader: `  function* <E>(read: Effect.Effect<OpenCode2Workspace, E>, scanned: Effect.Effect<void>) {
    const first = yield* read;
    if (first.commands.length > 0) return first;
    yield* scanned.pipe(Effect.timeoutOption("10 seconds"));
    return yield* read;
  },`,
    argument: "            Deferred.await(scanned),",
  },
  // Reviewed against v0.1.10-nightly.20261112.4564 (bc647ed53595888efacdd8ca435967d48888a952).
  {
    directory: "directory",
    comment: "/**\n * Reading a location the server has not loaded boots its scan, and only reads after the scan's\n * `command.updated` plus `skill.updated` are complete; `scanned` must listen before `read`. A\n * loaded location listing no commands is still scanning. OpenCode exposes no readiness signal,\n * so one another caller booted moments earlier can still read partial.\n */\n",
    loader: `  function* <E>(
    read: Effect.Effect<OpenCode2Workspace, E>,
    scanned: Effect.Effect<void>,
    loaded: Effect.Effect<boolean>,
  ) {
    const wasLoaded = yield* loaded;
    const first = yield* read;
    if (wasLoaded && first.commands.length > 0) return first;
    yield* scanned.pipe(Effect.timeoutOption("10 seconds"));
    return yield* read;
  },`,
    argument: `            Deferred.await(scanned),
            // Without events no scan can be awaited, so trust the first read as before.
            stream._tag === "None"
              ? Effect.succeed(true)
              : client.debug.location.list().pipe(
                  Effect.map((loaded) => loaded.some((entry) => entry.directory === directory)),
                  Effect.timeout("2 seconds"),
                  Effect.orElseSucceed(() => true),
                ),`,
  },
  // Reviewed against v0.1.10-nightly.20261112.4606 (d8f3feff0c1749ca020941427b153005755baca6).
  // Upstream adds a provider-catalog barrier for an already loading location.
  // Native plugin readiness replaces that heuristic alongside the event wait.
  {
    directory: "directory",
    comment: "/**\n * Reading a location the server has not loaded boots its scan, and only reads after the scan's\n * `command.updated` plus `skill.updated` are complete; `scanned` must listen before `read`. A\n * loaded location listing no commands is still scanning. A location another caller booted\n * moments earlier lists as loaded with only built-ins, so `settled` waits out its scan first.\n */\n",
    loader: `  function* <E>(
    read: Effect.Effect<OpenCode2Workspace, E>,
    scanned: Effect.Effect<void>,
    loaded: Effect.Effect<boolean>,
    settled: Effect.Effect<void> = Effect.void,
  ) {
    const wasLoaded = yield* loaded;
    yield* settled;
    const first = yield* read;
    if (wasLoaded && first.commands.length > 0) return first;
    yield* scanned.pipe(Effect.timeoutOption("10 seconds"));
    return yield* read;
  },`,
    argument: `            Deferred.await(scanned),
            // Without events no scan can be awaited, so trust the first read as before.
            stream._tag === "None"
              ? Effect.succeed(true)
              : client.debug.location.list().pipe(
                  Effect.map((loaded) => loaded.some((entry) => entry.directory === directory)),
                  Effect.timeout("2 seconds"),
                  Effect.orElseSucceed(() => true),
                ),
            // OpenCode answers provider.list for a location only once its skill scan has ended.
            client.provider.list({ location }).pipe(Effect.timeout("10 seconds"), Effect.ignore),`,
  },
];

function mismatch(file) {
  return new Error(`The opencode-skills patch no longer matches ${file}. Review the upstream source before publishing this runtime.`);
}
function replaceOnce(text, before, after, file) {
  if (typeof text !== "string" || text.split(before).length !== 2) throw mismatch(file);
  return text.replace(before, after);
}

export function patchOpenCodeSkills(source) {
  const matches = shapes.filter(shape => source[files[1]]?.includes(shape.loader));
  if (matches.length !== 1) throw mismatch(files[1]);
  const [shape] = matches, next = { ...source };
  const change = (file, before, after) => { next[file] = replaceOnce(next[file], before, after, file); };
  if (shape.directory === "directory") {
    const normalized = "          const directory = pathService.resolve(cwd);\n          const location = { directory };";
    change(files[0], normalized, normalized);
  }
  change(files[0], 'import * as Deferred from "effect/Deferred";', 'import * as Schedule from "effect/Schedule";');
  change(files[0], 'import * as Stream from "effect/Stream";\n', "");
  change(files[0], "openCode2Server.withConnection(({ client, events }) =>", "openCode2Server.withConnection(({ client }) =>");
  change(files[0],
    `          const scanned = yield* Deferred.make<void>();
          const pending = new Set(["command.updated", "skill.updated"]);
          const stream = yield* events.pipe(Effect.option);
          if (stream._tag === "Some") {
            yield* stream.value.pipe(
              Stream.runForEach((event) =>
                "location" in event &&
                event.location?.directory === ${shape.directory} &&
                pending.delete(event.type) &&
                pending.size === 0
                  ? Deferred.succeed(scanned, undefined)
                  : Effect.void,
              ),
              Effect.ignore,
              Effect.forkScoped,
            );
          }
`,
    `          const scanned = client.plugin.list({ location }).pipe(
            Effect.repeat({
              until: (plugins) => ["opencode.config.skill", "opencode.config.command"].every(
                (id) => plugins.data.some((plugin) => plugin.id === id && plugin.state?.status === "active"),
              ),
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.asVoid,
          );
`);
  change(files[0], shape.argument, "            scanned,");
  change(files[1], shape.comment, "/** Wait for the native config plugins before caching an inventory, including warm or empty workspaces. */\n");
  change(files[1], shape.loader,
    `  function* <E, E2>(read: Effect.Effect<OpenCode2Workspace, E>, scanned: Effect.Effect<void, E2>) {
    // The first read starts discovery; built-in commands can precede local skills.
    yield* read;
    yield* scanned.pipe(Effect.timeout("10 seconds"));
    return yield* read;
  },`);
  return next;
}
