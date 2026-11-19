import { readFileSync } from "node:fs";

const authFile = "apps/server/src/provider/AntigravityAuth.ts";
const driverFile = "apps/server/src/provider/Drivers/AntigravityDriver.ts";
export const files = [authFile, driverFile];
export const creates = ["apps/server/src/provider/antigravityTerminalLogin.ts"];
export const assets = [new URL("./antigravity-terminal-login.ts", import.meta.url)];

export function patchAntigravitySignIn(source) {
  const next = { ...source };
  const drift = (file) => new Error(`The Antigravity sign-in patch no longer matches ${file}. Review the upstream source before publishing.`);
  const change = (file, before, after) => {
    if (typeof next[file] !== "string" || next[file].split(before).length !== 2) throw drift(file);
    next[file] = next[file].replace(before, after);
  };
  if (Object.hasOwn(next, creates[0])) throw drift(creates[0]);
  next[creates[0]] = readFileSync(assets[0], "utf8");

  change(authFile, 'import type { ProviderAuthController }', `import type { AntigravityTerminalChallenge } from "./antigravityTerminalLogin.ts";
import type { ProviderAuthController }`);
  change(authFile, '  readonly usesBrowser?: boolean;', `  readonly usesBrowser?: boolean;
  readonly terminalLogin?: (onChallenge: AntigravityTerminalChallenge) =>
    Effect.Effect<void, ProviderSetupError, Scope.Scope>;`);
  change(authFile, '  callbackSent: boolean;', `  callbackSent: boolean;
  submitCode?: Parameters<AntigravityTerminalChallenge>[1] | undefined;`);
  change(authFile, 'const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);', `const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const needsTerminalLogin = (error: unknown) =>
  isAcpRequestError(error) && error.method === "authenticate" && error.code === -32603 &&
  error.errorMessage.startsWith("No browser is available here") &&
  error.errorMessage.includes("agy acp --login");`);
  change(authFile, '          phase: Exit.isSuccess(result) ? "succeeded" : "failed",', `          phase: Exit.isSuccess(result) ? "succeeded" : "failed",
          interaction: null,`);
  change(authFile, '        flow.pending = undefined;\n        yield* publishFlow(flow, {', '        flow.pending = undefined;\n        flow.submitCode = undefined;\n        yield* publishFlow(flow, {');
  change(authFile, '              phase,\n              authorizationUrl: null,', '              phase,\n              interaction: null,\n              authorizationUrl: null,');
  change(authFile, '                  phase: "cancelled",\n                  authorizationUrl: null,', '                  phase: "cancelled",\n                  interaction: null,\n                  authorizationUrl: null,');
  change(authFile, '            interaction:\n              state.phase === "waiting" && state.authorizationUrl && state.flowId',
    '            interaction: state.interaction ?? (\n              state.phase === "waiting" && state.authorizationUrl && state.flowId');
  change(authFile, '                    acceptsCallback: true,\n                  }\n                : null,',
    '                    acceptsCallback: true,\n                  }\n                : null),');

  const oldRunStart = '      const runtime = yield* options.makeRuntime({\n        onAuthorizationUrl: (url) => receiveAuthorizationUrl(flow, url),\n      });';
  const oldRunEnd = '      yield* options.onAuthenticated(started, runtime);';
  const auth = next[authFile];
  const startAcp = auth.indexOf(oldRunStart);
  const endAcp = auth.indexOf(oldRunEnd, startAcp) + oldRunEnd.length;
  if (startAcp < 0 || endAcp < startAcp || auth.split(oldRunStart).length !== 2 ||
      auth.split(oldRunEnd).length !== 2) throw drift(authFile);
  const runAcp = auth.slice(startAcp, endAcp).split("\n").map(line => line ? "  " + line : line).join("\n");
  change(authFile, auth.slice(startAcp, endAcp), `      const runAcp = Effect.gen(function* () {
${runAcp}
      }).pipe(Effect.scoped);
      const terminalLogin = options.terminalLogin;
      yield* terminalLogin ? runAcp.pipe(Effect.catchIf(needsTerminalLogin, () =>
        terminalLogin((url, submit) => lock.withPermits(1)(
          Effect.gen(function* () {
            if (activeFlow !== flow || operation !== "auth") return;
            flow.submitCode = submit;
            yield* publishFlow(flow, {
              ...flow.state,
              phase: "waiting",
              authorizationUrl: url,
              message: "Open Google sign-in and paste the authorization code.",
              interaction: {
                type: "credentials", id: flow.id,
                fields: [{ name: "authorizationCode", label: "Google authorization code", secret: true }],
              },
            });
          }),
        )).pipe(Effect.scoped, Effect.andThen(runAcp)),
      )) : runAcp;`);
  change(authFile, '    complete: Effect.fn("AntigravityAuth.complete")', `    respond: Effect.fn("AntigravityAuth.respond")(function* (ownerSessionId, input) {
      return yield* lock.withPermits(1)(Effect.gen(function* () {
        const flow = yield* requireFlow(ownerSessionId, input.flowId, "respond");
        if (!flow.submitCode || flow.state.phase !== "waiting" || input.interactionId !== flow.id) {
          return yield* setupError("respond", "This Google authorization code request is no longer active.");
        }
        const code = input.response.type === "credentials" ? input.response.values.authorizationCode?.trim() : undefined;
        if (!code || !/^[!-~]{1,4096}$/u.test(code)) {
          return yield* setupError("respond", "Paste the authorization code shown by Google.");
        }
        yield* flow.submitCode(code);
        flow.submitCode = undefined;
        flow.callbackSent = true;
        yield* publishFlow(flow, {
          ...flow.state,
          phase: "verifying",
          interaction: null,
          authorizationUrl: null,
          message: "Waiting for Google to finish sign-in.",
        });
        return flow.state;
      }));
    }),
    complete: Effect.fn("AntigravityAuth.complete")`);

  change(driverFile, 'import { makeAntigravityAuth, type AntigravityAuth }', `import { runAntigravityTerminalLogin, type AntigravityTerminalChallenge } from "../antigravityTerminalLogin.ts";
import { makeAntigravityAuth, type AntigravityAuth }`);
  const driver = next[driverFile];
  const runtimeDeclaration = '    const makeRuntime = Effect.fn("AntigravityDriver.makeRuntime")';
  const signature = driver.indexOf(runtimeDeclaration);
  const body = driver.indexOf('      if (authConfigIssue !== null) {', signature);
  const runtime = driver.indexOf('      const runtime = yield* makeAntigravityAcpRuntime({', body);
  const threadEnv = driver.indexOf('      // \`buildAntigravityAcpSpawnInput\` sets', body);
  if (signature < 0 || body < signature || runtime < body ||
      driver.split(runtimeDeclaration).length !== 2) throw drift(driverFile);
  const end = threadEnv >= body && threadEnv < runtime ? threadEnv : runtime;
  const preparation = driver.slice(body, end);
  if (!preparation.includes('const profile = yield* prepareAntigravityProfile(') ||
      !preparation.includes('const runtimeTempDirectory = yield* Effect.acquireRelease(')) throw drift(driverFile);
  change(driverFile, driver.slice(signature, end), `    const prepareRuntime = Effect.fn("AntigravityDriver.prepareRuntime")(function* () {
${preparation}      return { executable, profile, runtimeTempDirectory };
    });

${driver.slice(signature, body)}      const { executable, profile, runtimeTempDirectory } = yield* prepareRuntime();
`);
  change(driverFile, '    const authFlow: AntigravityAuth = yield* makeAntigravityAuth({', `    const terminalLogin = Effect.fn("AntigravityDriver.terminalLogin")(function* (onChallenge: AntigravityTerminalChallenge) {
      const { executable, profile, runtimeTempDirectory } = yield* prepareRuntime();
      if (executable.harnessPath !== null) {
        return yield* new ProviderSetupError({ instanceId, operation: "start", detail: "Terminal sign-in requires the Antigravity CLI." });
      }
      const spawn = buildAntigravityAcpSpawnInput({
        installation: executable, profile, cwd: runtimeTempDirectory,
        baseEnv: processEnvironment, auth, runtimeTempDirectory,
      });
      yield* runAntigravityTerminalLogin(instanceId, {
        command: spawn.command, args: spawn.args ?? [], cwd: runtimeTempDirectory, env: spawn.env ?? {},
      }, onChallenge).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    });

    const authFlow: AntigravityAuth = yield* makeAntigravityAuth({
      ...(auth.authMethod === "oauth-personal" ? { terminalLogin } : {}),`);
  return next;
}
