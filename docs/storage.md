# Storage management

**Setup → Storage** shows available filesystem space, Go build
cache and npm download sizes, and a folder inventory. A warning appears in
Overview and navigation at 80% usage; it becomes critical at 90%. Filesystem
usage includes other containers and host files, while the inventory covers
folders visible inside this container. Sizes use decimal GB and allocated disk
space. Scans run in the background, at startup and every ten minutes; polling
reads the cached inventory and current filesystem space. The refresh button
beside **Disk** requests a new scan. The latest inventory survives setup service
restarts.

**Clear caches** at the top of the page, or **Clear** on one cache, previews the
estimated space and asks for confirmation. Cleanup uses
`go clean -cache` and `npm cache clean --force`, leaving npm's `_npx` tools,
project files, installed tools, credentials, conversations, and backups alone.
The next build or install may take longer. Cleanup shares the installation
lock, refuses to run during detected build/install activity, and rejects linked
or external cache locations. A custom cache outside managed home cache folders
must be cleaned from a terminal. Operation results survive service restarts.

**Settings**, under the caches, controls two independent policies:

- **Automatic cache cleanup** starts off. When enabled, a cache above its limit
  is cleared after ten minutes without detected build/install activity. This
  clears the whole cache; the limit is a trigger, not a target size. Defaults
  are 10 GB for Go and 2 GB for npm. Limits range from 0.25 to 500 GB.
- **Keep managed versions bounded** starts on. After a verified install or
  update, older versions owned by the setup manager are trimmed. The current
  and previous selections, versions required by mise's tracked project configs
  or tool selections, configured provider paths, and running processes are
  protected. Unmanaged installs are kept. If references cannot be verified,
  trimming stops. **Older tool versions → Review** provides a manual preview;
  the server checks it again before removing anything.

In the manual review, **Also remove previous versions** includes every unused
noncurrent managed version, including the immediate previous selection. It is
off each time you open the review and never changes automatic retention. This
removes local rollback copies: switching back requires reinstalling them.
Current versions, project/tool requirements, configured provider selections,
running processes, unmanaged installs and unverified locations remain protected.
Changing this option requests a new preview; its confirmation is bound to both
the selected mode and the versions shown, and references are rechecked before
each removal.

Preferences live in `~/.t3/setup/storage-policy.json` (under `T3CODE_HOME` when
set) and persist with T3 state. Invalid preferences pause automatic cleanup.
The CLI uses the same service and policies:

```bash
t3-storage status                 # cheap filesystem/cached inventory read
t3-storage scan --json            # measure folders now
t3-storage clean all              # preview only
t3-storage clean go --yes          # explicitly clear the Go cache
t3-storage trim                   # review older managed versions
t3-storage trim --yes             # recheck and remove eligible versions
t3-storage policy --automatic on --go-budget 10 --npm-budget 2
```

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
