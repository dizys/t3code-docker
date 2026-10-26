# Upgrading T3 Code

Open **Setup → Updates**. **Check for updates** checks T3 Code and every agent
and tool at once. T3 Code checks the selected channel in this image's maintained
runtime distribution. **Update and restart** installs its exact verified build
immediately, without mise's waiting period. The native source comes from an
upstream release with this repository's Setup integration patches applied.

**Stable** is the default. Choose **Nightly** to try new features earlier, or
choose **Stable** again to return to its latest published release. The
confirmation shows the exact target and explains the interruption before
anything is installed. Changing channels can intentionally select an older
release; Update within a channel never downgrades a newer installed version.

Checks run on startup and hourly. By default downloads and restarts happen
only when you confirm an update; the **T3 Code** switch under **Automatic
updates**, on the same page, opts in, independently of the agents' and tools'
switches. **Schedule** beside it sets its own cadence (default every 3
hours); it installs the selected channel's release only after 30 minutes
without activity, and never switches Stable ↔ Nightly.
Turning the T3 Code switch on asks for a separate confirmation first, because
T3 Code is alpha and a release can break T3 Code or its compatibility with
this setup console.
Idle tracks console and client activity, not agent turns: a turn that
outlasts the idle time with every client closed can still be interrupted.
T3 Code keeps running while the release downloads, verifies
its SHA-256 digest against the OCI artifact descriptor and checks the image's
patch revision and container supervisor compatibility. Image builds use the same
source patch set and matching upstream client assets and native libraries.
Once ready, only T3 Code restarts. Active agent turns and its terminals stop;
clients reconnect. The Setup service and container keep running. A failed or
timed-out startup restores the previous version and SQLite snapshot, and an
interrupted update recovers before the server starts again.

The channel, selected native binary, adjacent client assets and cached releases
live in `$T3CODE_HOME/container-runtime` on the state volume. They survive a
container restart or image recreate. The image still supplies the initial
release and the supervisor; an explicitly selected release stays selected
after an image upgrade. Existing images need one image upgrade to gain this
feature, and future releases which require a newer supervisor may still need
a new image.

Older selected runtimes can receive a **container integration update** at the
same native version. The confirmation names that change, and the update follows
the same staging, startup checks and recovery process. Original binaries are kept
separately from patched variants until cache cleanup can remove them safely.

Runtime builds are published as OCI artifacts in the existing public GHCR
package. Downloads use anonymous read access and need no GitHub login or token.
Only builds matching the image's patch set are offered. A registry outage,
missing build, invalid checksum or incompatible startup keeps the running version
selected and reports the error. Failed checks retain the last known compatible
release information and its successful check time.

Staging checks free space before downloading and extracting, reserving
64 MiB of headroom for the running server. Downloads without a verified archive
size or declared response length need room for the 300 MiB download limit as
well. Space is checked again during
the download so other activity on the volume can stop staging safely.

After a successful update, obsolete cached releases are removed. The active
release, its predecessor and the latest known target for each channel are kept.

Current Nightly releases use a newer thread database than Stable 0.0.45.
Nightly seeds it from the older database once; later channel switches keep the
two histories separately. The first switch can take longer while Nightly
imports the existing thread history. Returning to Stable can therefore show
earlier history, and returning to Nightly shows its retained history. Both databases
are preserved on the volume. Device pairings, revocations and consumed pairing
links follow channel switches when the native authentication schemas match;
an incompatible format stops the switch safely. This limitation appears in
the channel confirmation as well.

New permission scopes are limited to what the target release understands.
Switching stops if a restricted credential would gain older broad permissions;
revoke that credential before retrying.
When an unchanged credential returns to a newer release, its previously
granted permissions are restored; revocations still follow the active store.
Existing older credentials may need pairing again to grant newly introduced
permissions, as required by T3 Code itself.
Conversely, credentials first issued on Nightly can contain signed permission
claims Stable 0.0.45 cannot decode. Those devices need pairing again on Stable;
their original credentials work again on Nightly unless revoked or expired.
