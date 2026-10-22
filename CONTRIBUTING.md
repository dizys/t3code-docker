# Contributing

Issues and pull requests are welcome. Before opening one:

- **`scripts/smoke-test.sh` defines what must keep working.** It starts the
  image and checks, against the running container, the things a user would
  notice if they broke. Run it against your build
  (`./scripts/smoke-test.sh t3code:browser`) and add a check for whatever you
  fixed. Most of its checks were added after something broke.
  The T3 Code archive check stages a real current nightly in a disposable home,
  verifies its checksum, Setup bridge, launcher protocol and native auth probes,
  then deletes it without selecting or starting it. It can also run locally:
  `node scripts/t3-runtime-smoke.mjs docker/runtime docker/t3-client/setup-bridge.js`.
- **CI builds and tests both images on both architectures** before anything is
  published, so a change that only works on amd64 is caught. The slower agent
  lifecycle test runs on amd64 for every build.
- **To work on the setup page or what it adds to T3 Code's pages**, run
  `node scripts/dev-console.mjs` inside a container from this image. It starts
  a scratch T3 Code and the setup page from your working tree behind the
  image's one-port router, as `T3_SINGLE_PORT` would. It restarts the setup
  page as you edit, serves T3 Code's pages with your copy of
  `docker/t3-client/setup-bridge.js`, and prints a pairing link.
  `scripts/setup-bridge-audit.js` checks those pages in a browser, through the
  same router.
  `node scripts/console-screens.js` photographs every setup page in light and
  dark, on a phone, a tablet, a desktop and inside T3 Code, in three states:
  set up, first start, and everything needing attention at once. Its data
  comes from `scripts/fixtures/console`, so the pictures do not depend on the
  machine, and nothing it presses reaches the server. Screenshots go to
  `/tmp/t3-console-screens`; `--routes`, `--sizes`, `--themes` and
  `--scenarios` narrow a run. Attach the pages you changed to the pull request.
  For Skills review without installed agents, `node scripts/console-preview.mjs`
  serves the real console at `http://127.0.0.1:23785/__setup/` with an in-memory
  API. It never connects to production or executes source files. Reload reads the
  current console assets; restart resets fixture mutations. This is a review
  server, not a deployment mode. `--scenarios skills --skill-overlays` adds the
  seven-provider library, policy menu, inspector and all three import steps to
  `console-screens.js`. Fixtures use synthetic instruction text and paths.
  `node scripts/skills-ui-audit.js http://127.0.0.1:23785/__setup/ dev` exercises
  desktop, phone, tablet and embedded flows in both themes, including settings
  serialization, stale saves/plans, late replies, replacement consent and partial
  retry. Like the other audits it uses the existing Playwright installation
  (`NODE_PATH` if needed) and `CHROME_PATH` for Chromium.
  Review console changes beyond the populated mockup: empty, loading, unavailable,
  expanded, hover and keyboard-focus states, long paths, and both scroll edges.
  Compare the changed states at the same viewport in light and dark, including a
  narrow phone and the embedded console. Use the shared Kit controls throughout;
  check touch targets and keep recovery actions readable. Add a regression to the
  relevant browser audit for the defect. `node scripts/context-ui-audit.js
  http://127.0.0.1:23785/__setup/ dev` covers Instructions, including failed reads,
  draft preservation and save conflicts; its screenshots go to
  `/tmp/t3-context-ui-audit` (`T3_CONTEXT_UI_OUTPUT` overrides it).
  `node scripts/readme-media.js` rebuilds the README's picture
  (`docs/media/setup-{light,dark}.png`) and the Ports guide's
  (`docs/media/ports-panel.png`) from the same data; run it when a change
  shows on Overview, Agents or Ports.
  `node scripts/ui-audit.js http://127.0.0.1:23780/__setup/ dev` measures the
  same pages for clipped text, uneven buttons and misaligned glyphs.
  `node scripts/storage-ui-audit.js http://127.0.0.1:23780/__setup/ dev`
  checks storage layouts and keyboard flows in light/dark and embedded modes.
  Its storage data and mutations are intercepted, so it cannot clean a real
  cache or change preferences. Screenshots go to `/tmp/t3-storage-ui-audit`;
  set `T3_STORAGE_UI_OUTPUT` to change that location. The development console
  isolates its home, mise state, and caches under `/tmp/t3-dev/home`.
  `node scripts/access-ui-audit.js http://127.0.0.1:23780/__setup/ dev`
  checks device renaming, revocation and pairing with delayed/failed fixture
  responses, repeated submissions, stale polls and incomplete list refreshes.
  It covers light/dark, phone, tablet, desktop and an actual embedded frame;
  screenshots go to `/tmp/t3-access-ui-audit` (`T3_ACCESS_UI_OUTPUT` overrides
  it). All Access API writes are intercepted and never reach real devices.

For OpenCode credential changes, run
`node scripts/opencode-auth-smoke.mjs /absolute/path/to/opencode` against both
1.x and 2.x (including 2.0.18, the supported V2 floor). It uses an isolated
home and disposable keys, and checks save, account selection, provider
isolation and removal without a model request. The image smoke suite runs it
against the installed release. `node scripts/opencode-auth-ui-audit.mjs`
starts its own disposable setup server and credential CLI, then checks drafts,
slow and failed reads, account removal, keyboard focus and late writes in
light/dark, mobile, desktop and embedded-query layouts. It requires Playwright
and Chromium; set `CHROME_PATH` if needed. Screenshots go to
`/tmp/t3-opencode-auth-ui` (`T3_AUTH_UI_OUTPUT` overrides it). These audits
never read or change your real OpenCode credentials.

Releases are made from tags. Pushing `vX.Y.Z` builds each image for each
architecture, tests each one against the exact digest that was pushed, runs the
agent lifecycle test and measures the image size on amd64, and then combines
the tested digests into one manifest without rebuilding. `latest` points at
`browser`. Published releases are then mirrored to Docker Hub; see
[Docker Hub publishing](docs/dockerhub-publishing.md).
