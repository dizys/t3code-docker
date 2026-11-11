# Working on the console

Choose the environment that matches your change:

| Environment | Use it for | What runs |
| --- | --- | --- |
| Development console | Native T3 behavior, authentication, routing and integration | Real T3 Code and Setup in a scratch home |
| Fixture preview | Layout, interaction states and review screenshots | Real console assets with an in-memory API |

## Development console

Run this inside an image container, from your checkout:

```bash
node scripts/dev-console.mjs
```

Outside the image, set `T3_INFRA_BINARY` to a native T3 executable. The command
starts T3 Code, Setup and the image's one-port router at
`http://127.0.0.1:23780`. Setup is at `/__setup/`, with the development key `dev`.
It prints a pairing link and stops its child processes on Ctrl-C.

The scratch home, Mise state and caches live under `/tmp/t3-dev/home` by
default. Use `--fresh` to reset this development state, `--port` to choose
another port, or `--verbose` for process output. Setup restarts as you edit.
T3's pages use the working copy of `docker/t3-client/setup-bridge.js`.

For changes to instances or process behavior, use real T3 turns and a local
fixture gateway. A synthetic response cannot verify native behavior.

## Fixture preview

```bash
node scripts/console-preview.mjs
```

Open `http://127.0.0.1:23785/__setup/`, using `dev` where an audit asks for a
key. The preview serves real console assets over fixtures from
`scripts/fixtures/console`. It does not connect to production or execute source
files. Writes stay in memory, reload reads current assets, and restarting
resets fixture changes. This is a review tool, not a deployment mode.

Instructions and paths in the fixtures are synthetic. Keep all write fixtures
intercepted, especially Skills drafts and source text. Never redirect an audit
to a production write API.

## Review a UI change

Check both themes at the same viewport, including a narrow phone and the
embedded console. Include empty, loading, unavailable, expanded, hover and
keyboard-focus states, long paths, and both scroll edges. Use the shared Kit
controls, check touch targets, and keep recovery actions readable.

Add a regression to the relevant [browser audit](ui-audits.md), then attach
screenshots of the changed states to the PR. The
[design system](../../docker/setup/design/README.md) documents source mapping
and appearance synchronization.

### Capture screenshots

```bash
node scripts/console-screens.js
```

This captures every Setup page in light/dark themes on phone, tablet, desktop
and inside T3 Code. It covers set-up, first-start and attention-needed states.
Output goes to `/tmp/t3-console-screens`. Use `--routes`, `--sizes`, `--themes`
and `--scenarios` to narrow an iteration.

| Option | Adds |
| --- | --- |
| `--scenarios skills --skill-overlays` | Eight-provider library, policy menu, inspector and all three import steps |
| `--files-overlays` | Archive, extraction and cleanup reviews |

When Overview, Agents or Ports visibly changes, rebuild the published images:

```bash
node scripts/readme-media.js http://127.0.0.1:23785/__setup/ dev
```

With the fixture preview running, this writes the light/dark Setup and Files
images and `docs/media/ports-panel.png` from the same data. Omit the URL to use
the development console on port 23780.

## Shared editor ownership

`docker/setup/client/code-text.js` owns source syntax and viewport limits.
`code-editor.js` owns source rendering and the native input surface. Each
caller owns saving, revisions, conflicts and dirty-close behavior.

Use Kit's `onRender` hook to synchronize an editor after a layer patch.
Destroy it on close to release resize observers and queued animation frames.
