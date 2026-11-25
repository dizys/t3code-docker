// Excerpts from upstream Nightly 5209 at 84e4264bb347e36e97f6c3bd95d666eecfa12e07.
export const scansSource = {
  "packages/provider-opencode/src/server/driver.ts": `import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
  followOpenCode2Scans,
    const catalogWatch = yield* makeOpenCode2CatalogWatch(processEnv);
    // An external server may not have the host's cwd; without a location it uses its own default.
    const machineDirectory = (connection: OpenCode2Server.OpenCode2Connection) =>
      connection.external ? undefined : host.paths.cwd;
    const followMachineCatalog = (connection: OpenCode2Server.OpenCode2Connection) =>
      catalogWatch.follow(
        connection.url,
        connection.events,
        loadOpenCode2DirectoryCatalog(connection.client, machineDirectory(connection)),
      );
    // Locations whose scan T3 saw end on the current server; a scan is announced only once.
    let scans = { url: "", scanned: new Set<string>() };
    const followScans = (connection: OpenCode2Server.OpenCode2Connection) =>
      Effect.suspend(() => {
        const scanned = new Set<string>();
        scans = { url: connection.url, scanned };
        return connection.events.pipe(
          Effect.flatMap((events) =>
            followOpenCode2Scans(events, (directory) => Effect.sync(() => scanned.add(directory))),
          ),
          Effect.scoped,
          Effect.ignore,
          Effect.forkScoped,
        );
      });
    // A session or text generation can start the server too, and reads no catalog when it does.
    yield* Stream.runForEach(openCode2Server.connections, (connection) =>
      followScans(connection).pipe(Effect.andThen(followMachineCatalog(connection))),
    ).pipe(Effect.forkScoped);
    const loadOpenCode2Models = yield* makeOpenCode2ModelLoader(
      openCode2Server.withConnection((connection) =>
        followMachineCatalog(connection).pipe(
          Effect.andThen(loadOpenCode2Catalog(connection.client, machineDirectory(connection))),
        ),
      ),
      processEnv,
    );
    const listOpenCode2Workspace = (cwd: string) =>
      openCode2Server.withConnection(({ client, events, url }) =>
        Effect.gen(function* () {
          // OpenCode names a location by its resolved path (no trailing slash or \`..\`).
          const directory = pathService.resolve(cwd);
          const location = { directory };
          if (scans.url !== url) scans = { url, scanned: new Set() };
          const { scanned: seen } = scans;
          const scanned = yield* Deferred.make<void>();
          const stream = yield* events.pipe(Effect.option);
          if (stream._tag === "Some") {
            yield* followOpenCode2Scans(stream.value, (scannedDirectory) =>
              scannedDirectory === directory
                ? Deferred.succeed(scanned, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ).pipe(Effect.forkScoped);
          }
          const workspace = yield* loadOpenCode2Workspace(
            Effect.all(
              {
                skills: client.skill.list({ location }).pipe(Effect.map((list) => list.data)),
                commands: client.command.list({ location }).pipe(Effect.map((list) => list.data)),
              },
              { concurrency: "unbounded" },
            ),
            Deferred.await(scanned),
            // Without events no scan can be awaited, so trust the first read as before.
            stream._tag === "None" || seen.has(directory),
            processEnv,
          );
          // A location loaded before T3 watched never announces its scan; wait for it only once.
          seen.add(directory);
          return workspace;
        }).pipe(Effect.scoped),
      );
`,
  "packages/provider-opencode/src/server/status.ts": `/**
 * Until its scan ends a location lists only built-ins, even once the server lists it as loaded,
 * and nothing but the scan's end tells the two apart. Unless the caller saw that scan end, read to
 * boot the location, wait for its scan (\`scanned\` must listen before \`read\`), and read again.
 */
export const loadOpenCode2Workspace = Effect.fn("OpencodeProviderStatus.loadOpenCode2Workspace")(
  function* <E>(
    read: Effect.Effect<OpenCode2Workspace, E>,
    scanned: Effect.Effect<void>,
    sawScan: boolean,
    environment?: NodeJS.ProcessEnv,
  ) {
    const first = yield* read;
    if (sawScan) return first;
    yield* scanned.pipe(
      Effect.timeoutOption(resolveProviderProbeTimeoutMs("opencode", 10_000, environment)),
    );
    return yield* read;
  },
);

`,
};
