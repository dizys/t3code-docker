# Making a release

Releases come from tags. Merge reviewed changes and update the README before
tagging the exact commit you intend to ship.

## Create the tag and draft

Prepare release notes, then run:

```bash
git tag -a vX.Y.Z -m 'vX.Y.Z: Title' <merge-commit>
git push origin vX.Y.Z
gh release create vX.Y.Z --draft --verify-tag --title 'vX.Y.Z: Title' --notes-file notes.md
```

Creating the draft yourself keeps it under your name. If no draft exists when
the build finishes, CI creates one from the tag message under `github-actions`.
Use that draft and add notes before publishing.

For a release candidate, use a tag such as `vX.Y.Z-rc.1` and create the draft
with `--prerelease --latest=false`. Resume an existing tag, draft or build
instead of submitting it again.

## Verify the build

Tag CI builds both images for amd64 and arm64. It tests each exact pushed
digest, runs the agent lifecycle test and measures image size on amd64, then
combines the tested digests into manifests without rebuilding.

The build verifies promoted tags against the tested digests and attaches
evidence to the draft. Before publication, verify successful checks, the tagged
source, each platform digest and architecture, provenance, and all attached
test and promotion evidence. `latest` uses the browser image.

## Publish and check delivery

Publish the existing stable draft after verification:

```bash
gh release edit vX.Y.Z --draft=false --latest
```

For a release candidate, keep `--prerelease --latest=false` when publishing.
Publishing triggers the Docker Hub mirror. Verify both registries deliver the
tested images and that aliases follow the release's stable or prerelease
policy. See [Docker Hub publishing](../dockerhub-publishing.md) for the workflow
and evidence format.
