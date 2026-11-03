// Wait for native discovery completion, never infer readiness from built-in commands.
export const files = [
  "packages/provider-opencode/src/server/driver.ts",
  "packages/provider-opencode/src/server/status.ts",
];

function replaceOnce(text, before, after, file) {
  if (typeof text !== "string" || text.split(before).length !== 2) throw new Error(`The opencode-skills patch no longer matches ${file}. Review the upstream source before publishing this runtime.`);
  return text.replace(before, after);
}

export function patchOpenCodeSkills(source) {
  const next = { ...source };
  const change = (file, before, after) => { next[file] = replaceOnce(next[file], before, after, file); };
  change(files[0],
    "import * as Deferred from \"effect/Deferred\";",
    "import * as Schedule from \"effect/Schedule\";");
  change(files[0],
    "import * as Stream from \"effect/Stream\";\n",
    "");
  change(files[0],
    "openCode2Server.withConnection(({ client, events }) =>",
    "openCode2Server.withConnection(({ client }) =>");
  change(files[0],
    "          const scanned = yield* Deferred.make<void>();\n          const pending = new Set([\"command.updated\", \"skill.updated\"]);\n          const stream = yield* events.pipe(Effect.option);\n          if (stream._tag === \"Some\") {\n            yield* stream.value.pipe(\n              Stream.runForEach((event) =>\n                \"location\" in event &&\n                event.location?.directory === cwd &&\n                pending.delete(event.type) &&\n                pending.size === 0\n                  ? Deferred.succeed(scanned, undefined)\n                  : Effect.void,\n              ),\n              Effect.ignore,\n              Effect.forkScoped,\n            );\n          }\n",
    "          const scanned = client.plugin.list({ location }).pipe(\n            Effect.repeat({\n              until: (plugins) => [\"opencode.config.skill\", \"opencode.config.command\"].every(\n                (id) => plugins.data.some((plugin) => plugin.id === id && plugin.state?.status === \"active\"),\n              ),\n              schedule: Schedule.spaced(\"100 millis\"),\n            }),\n            Effect.asVoid,\n          );\n");
  change(files[0],
    "            Deferred.await(scanned),",
    "            scanned,");
  change(files[1],
    "/**\n * A server scans a directory it has not served yet in the background: its first read lists\n * no commands at all (not even the built-ins), and `command.updated` plus `skill.updated`\n * for the directory end the scan. `scanned` must be listening before `read` runs, since\n * the read is what starts the scan.\n */\n",
    "/** Wait for the native config plugins before caching an inventory, including warm or empty workspaces. */\n");
  change(files[1],
    "  function* <E>(read: Effect.Effect<OpenCode2Workspace, E>, scanned: Effect.Effect<void>) {\n    const first = yield* read;\n    if (first.commands.length > 0) return first;\n    yield* scanned.pipe(Effect.timeoutOption(\"10 seconds\"));\n    return yield* read;\n  },",
    "  function* <E, E2>(read: Effect.Effect<OpenCode2Workspace, E>, scanned: Effect.Effect<void, E2>) {\n    // The first read starts discovery; built-in commands can precede local skills.\n    yield* read;\n    yield* scanned.pipe(Effect.timeout(\"10 seconds\"));\n    return yield* read;\n  },");
  return next;
}
