import { stripVTControlCharacters } from "node:util";
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export type AntigravityTerminalChallenge = (
  url: string,
  submit: (code: string) => Effect.Effect<void, ProviderSetupError>,
) => Effect.Effect<void, ProviderSetupError>;

function authorizationUrl(line: string): string | undefined {
  const value = stripVTControlCharacters(line).trim();
  if (!value.startsWith("https://accounts.google.com/") || value.length > 16_384 || /\s/u.test(value)) return;
  const url = URL.parse(value);
  if (!url || url.origin !== "https://accounts.google.com" || url.username || url.password || url.hash) return;
  if (url.pathname !== "/o/oauth2/auth" && url.pathname !== "/o/oauth2/v2/auth") return;
  const params = url.searchParams;
  const single = (key: string) => params.getAll(key).length === 1 ? params.get(key) : null;
  if (
    single("redirect_uri") !== "https://antigravity.google/oauth-callback" ||
    single("response_type") !== "code" || !single("state") || !single("code_challenge") ||
    single("code_challenge_method") !== "S256"
  ) return;
  return value;
}

export const runAntigravityTerminalLogin = Effect.fn("AntigravityTerminalLogin.run")(function* (
  instanceId: ProviderInstanceId,
  input: { command: string; args: ReadonlyArray<string>; cwd: string; env: NodeJS.ProcessEnv },
  onChallenge: AntigravityTerminalChallenge,
) {
  const error = (detail: string) => new ProviderSetupError({ instanceId, operation: "start", detail });
  const unavailable = error("Antigravity could not start its terminal sign-in. Try again.");
  const challenge = yield* Deferred.make<string, ProviderSetupError>();
  const code = yield* Deferred.make<string>();
  const inputStream = Stream.fromEffect(Deferred.await(code).pipe(
    Effect.map((value) => new TextEncoder().encode(`${value}\n`)),
  ));
  const env = { ...input.env };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  delete env.BROWSER;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(input.command, [...input.args, "--login"], {
    cwd: input.cwd, env, extendEnv: false, shell: false,
    stdin: inputStream, stdout: "pipe", stderr: "ignore", forceKillAfter: "1 second",
  })).pipe(Effect.mapError(() => unavailable));

  // OAuth output may include secrets. Keep only the first validated link and drain the rest.
  const decoder = new TextDecoder();
  let pending = "";
  let bytes = 0;
  let found = false;
  yield* Stream.runForEach(child.stdout, (chunk) => Effect.suspend(() => {
    if (found) return Effect.void;
    bytes += chunk.length;
    if (bytes > 32_768) return Deferred.fail(challenge, unavailable).pipe(Effect.asVoid);
    const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const url = authorizationUrl(line);
      if (url) {
        found = true;
        pending = "";
        return Deferred.succeed(challenge, url).pipe(Effect.asVoid);
      }
    }
    return Effect.void;
  })).pipe(
    Effect.andThen(Deferred.fail(challenge, unavailable)),
    Effect.catch(() => Deferred.fail(challenge, unavailable)),
    Effect.forkScoped,
  );
  const url = yield* Deferred.await(challenge).pipe(Effect.timeoutOrElse({
    duration: "30 seconds",
    orElse: () => Effect.fail(unavailable),
  }));
  yield* onChallenge(url, (value) => Deferred.succeed(code, value).pipe(Effect.asVoid));
  const status = yield* child.exitCode.pipe(Effect.mapError(() => unavailable));
  if (Number(status) !== 0 || !(yield* Deferred.isDone(code))) {
    return yield* error("Google sign-in did not accept the authorization code. Start sign-in again.");
  }
});
