# Storage management

**Setup → Storage** brings together disk space, tool caches and maintenance.
The disk meter shows the filesystem shared with the host and other containers;
the inventories describe data visible inside this container. A warning appears
at 80% usage and becomes critical at 90%.

Use [Files](files.md) for projects and personal files: browse, upload, download a
ZIP, or review rebuildable project folders. Expand **Container data → Folder
sizes** to open Projects, T3 Code data or backups directly in Files.

## Review a cleanup

1. Choose **Review cleanup**, or **Review** beside one cache.
2. Review the current sizes and select the caches to clean. Empty, protected and
   unavailable caches explain why they are kept. **Details** opens the same
   review for a cache that cannot be cleaned.
3. Choose **Clean up**. Locations, shared dependencies and relevant tool activity
   are checked again before any command runs.

A review expires after five minutes; **Check again** stays in its action footer.
If a location changes, refresh the review
and confirm the new selection. Checking or closing a review never cleans files.
Cleanup continues if you close its progress panel; **Details** and **View result**
reopen the same operation. If cleanup stops partway through, **Review remaining**
checks only the caches that did not finish. Completed caches are not resubmitted.

Cache sizes describe allocated **cache data**, not guaranteed recoverable disk
space. Package caches can share file blocks with installed projects. Results say
how much cached data was removed; the disk meter reports current available space.
uv can retain entries after a successful prune, including when nothing is unused.

## What can be cleaned

Each cache uses its tool's native command with an explicitly checked location:

| Cache | Command | What stays protected |
| --- | --- | --- |
| Go build cache | `go clean -cache` | Projects, installed tools and other caches. |
| Go modules | `go clean -modcache` | A shared, overlapping or protected location is refused. |
| npm downloads | `npm cache clean --force` | Only `_cacache` downloads are cleaned; `_npx` tools stay. |
| uv cache | `uv cache prune` | Only unused entries are pruned; full or forced cache removal is never used. |
| Bun downloads | `bun pm cache rm` | A populated or unverifiable `links` shared store prevents cleanup, preserving installed dependencies. |
| mise metadata | `mise cache clear` | Installed tools, external task caches and existing environment caches stay in place. |
| Deno modules | `deno clean` | Running Deno commands and unsafe locations prevent cleanup. |

Projects, sign-ins, conversations and backups are excluded. The next build or
install may need to recreate or download cache entries. The installer and cleanup
share a cross-process lock. Relevant builds, installations and tool commands
(including `uv run`, `uvx` and Bun applications) pause their own cache cleanup;
an unrelated long-running Deno server does not prevent cleaning npm downloads.
If process activity cannot be checked, cleanup pauses.

Linked cache locations, aggregate cache roots and overlaps with other caches or
protected folders are refused. A custom location outside the managed home cache
folders must be cleaned from a terminal.

## Storage measurements

The storage inventory includes the workspace and recurses into nested folders.
By default it runs at startup and every ten minutes. For a large workspace on
slow storage, set `T3_STORAGE_SCAN_INTERVAL_MINUTES=60` in Compose's `.env` or
in the container environment, then recreate the container. Set it to `0` to skip
the startup scan, scheduled scans and automatic folder sizing in Files.

**Storage → Refresh**, **Files → Measure again**, and `t3-storage scan` still measure on
request. Polling reads cached sizes and live filesystem space. Automatic cache
cleanup uses the last available inventory and measures selected caches directly.
Inventories and operation results survive service restarts.

## Maintenance

**Maintenance → Configure** contains two independent policies. Changes remain a
local draft until **Save preferences** succeeds. Polling preserves inputs; a
concurrent change asks you to reload the latest preferences before saving. Closing
an edited draft asks before discarding it.

- **Automatic cache cleanup** starts off. When enabled, the selected caches are
  cleaned after ten quiet minutes when they exceed their individual limits.
  **Cache selection & limits** reveals a compact list of cache choices and budgets.
  A limit is a trigger, not a target size. uv still prunes only unused entries.
  An unchanged cache is not repeatedly cleaned for 24 hours after an attempt that
  completed and measured its result; growth allows another review after idle time.
- **Trim older tool versions** starts on. After verified installs or updates,
  unneeded versions owned by Setup are trimmed. Current and previous selections,
  tracked project requirements, configured provider paths and running tools are
  protected. Unmanaged installs are kept. If references cannot be checked,
  trimming stops. **Older tool versions → Review** provides a manual preview;
  its optional **Also remove previous versions** choice affects that review only.

Default cache limits are 10 GB for Go builds, 5 GB for mise, 2 GB for Go modules,
npm, uv and Bun, and 1 GB for Deno. Values range from 0.25 to 500 GB. Automatic
cleanup still skips protected or unavailable caches.

Preferences live in `~/.t3/setup/storage-policy.json` (under `T3CODE_HOME` when
set). **Existing preferences keep their original Go/npm background-cleanup scope**;
upgrading the image does not opt additional tools into automatic cleanup. Select
other caches explicitly in Configure. Missing budgets receive the defaults above;
invalid preferences pause automatic maintenance.

## Command line

The CLI uses the same safety checks and fresh previews:

```bash
t3-storage status                         # filesystem and cached inventory
t3-storage scan --json                    # measure visible folders
t3-storage clean all                      # review eligible and protected caches
t3-storage clean uv --yes                 # review, then prune unused uv entries
t3-storage trim                           # review older managed versions
t3-storage trim --yes                      # recheck and trim eligible versions
t3-storage policy --automatic on --automatic-caches go,npm,uv
t3-storage policy --uv-budget 3 --mise-budget 5
```

`clean all` measures the relevant caches directly; it does not require a full home
scan. `--yes` applies a newly checked eligible selection. Protected or unavailable
caches are reported and kept. Every cache has a `--<id>-budget <GB>` option;
`--automatic-caches none` is valid when automatic cleanup is off.

## Development and verification

The cache catalogue, command scopes and ownership guards live in
`docker/harness/storage/caches.mjs`; orchestration and durable results live in
`manager.mjs`. Storage presentation, cleanup review and maintenance drafts have
separate client modules and use the shared Kit controls and design tokens.

The authenticated API uses `POST /storage/clean/preview` with `{ids}` to return a
short-lived, single-use review token and eligibility details. `POST /storage/clean`
requires `{ids, token}`; the selection must be a subset of the reviewed eligible
caches. Cache identity and safety are rechecked under the install lock. Previews
are bounded in memory and invalid after a Setup restart. A stale review returns
409 and starts no cleanup. `removedCacheBytes` describes cache data removed;
`reclaimedBytes` is null because directory size changes cannot prove recovered
filesystem blocks. Preferences can be saved as `{policy, revision}` using the
`policyRevision` returned by Storage; revision conflicts return 409.

`scripts/storage-native-smoke.mjs` runs real Go, Bun, Deno, uv and mise commands in
throwaway homes, with local packages and no downloads. It verifies npx boundaries,
shared Bun dependencies, external mise caches, and hardlinked and symlinked Python
environments. The image smoke suite runs it after first-start tools are installed
on both variants and architectures. `scripts/storage-ui-audit.js` uses only
in-memory responses and covers selection, expiry, late replies, duplicate submits,
background progress, partial retries, draft conflicts and version retention in
light/dark, short viewports, phone, tablet, desktop and actual embedded frames.
See [Contributing](../CONTRIBUTING.md) for local browser verification.

`t3-doctor` includes filesystem pressure and the cached inventory. Project
storage such as Wrangler/R2 state, test artifacts, and local databases belongs
to the project that creates it. Backup retention belongs to the upgrade or
backup process that produces the copies. Neither is automatically deleted here.
Unused host Docker volumes and host build caches need host administration;
the storage service does not require the Docker socket.

The supplied Compose file rotates each service's Docker logs at 10 MB, keeping
three files. For an existing deployment, apply the changed Compose configuration
by recreating the container while reusing its home and workspace volumes.
In **1Panel**, add the same `logging` block from `compose.yaml` to the stack's
Compose definition before redeploying. Rotation is a container/daemon setting,
so updating the image alone cannot apply it. Keep the existing volume mappings
when redeploying, especially if home uses an anonymous volume.
