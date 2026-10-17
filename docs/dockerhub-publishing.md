# Docker Hub distribution

The optional `publish Docker Hub` workflow copies published releases from
`ghcr.io/dizys/t3code-docker` to the public Docker Hub repository
`dizys/t3code-docker`. It does not build images or change the GHCR release
workflow. Enable it with the account setup below before advertising Docker Hub
as an available download source.

## One-time setup

1. Create `dizys/t3code-docker` on Docker Hub with **Public** visibility. The
   publisher checks visibility without Docker Hub credentials and refuses to
   publish if the repository is missing or private.
2. Create a Docker Hub access token with **Read & Write** repository access.
   Add it to this GitHub repository's Actions secrets as `DOCKERHUB_TOKEN`.
   Do not put it in a workflow file, commit, issue, or chat message.
3. The login defaults to `dizys`. If a different account has write permission
   to that repository, set the GitHub Actions variable `DOCKERHUB_USERNAME`.
4. Merge the workflow onto `main`, then run a dry run for `v0.18.0`. Inspect its
   plan before running the same workflow with `dry_run=false` to backfill it.

```bash
# Read-only validation; no Docker Hub credentials needed.
gh workflow run dockerhub.yml -R dizys/t3code-docker \
  --ref main -f tag=v0.18.0 -f dry_run=true

# Publish the already tested release, without rebuilding.
gh workflow run dockerhub.yml -R dizys/t3code-docker \
  --ref main -f tag=v0.18.0 -f dry_run=false
```

Future GitHub **release publication** events start this workflow automatically.
Creating a tag or draft release does not publish to Docker Hub. The build and
GHCR promotion must finish and their verification evidence must be attached
before publishing the GitHub release, matching our existing release process.
A missing token produces an actionable failure in the separate workflow; it
never prevents GHCR builds or promotion.

## What gets copied

For each release the publisher downloads only these attached evidence files:

- `registry-verification.json`
- `build-core-amd64.json`, `build-core-arm64.json`
- `build-browser-amd64.json`, `build-browser-arm64.json`

It requires a published release, matching tag/commit, four successful build
records, and matching verified index members. Releases without this evidence
cannot be mirrored through this workflow.

The pinned, checksum-verified `regctl` copies complete indexes and their layers
by digest, including embedded build provenance manifests and available OCI
referrers. Both variant indexes are staged and their exact bytes and tested
AMD64/ARM64 members are verified before release tags are written. Every final
tag is checked again. Existing version tags with different indexes are
refused instead of silently overwritten.

For the latest stable release all **15 existing tag aliases** are mirrored:

- Browser: version, version-browser, version-full, minor, minor-browser,
  minor-full, `browser`, `full`, and `latest`.
- Core: version-core, version-slim, minor-core, minor-slim, `core`, and `slim`.

Older releases and prereleases receive only their five full-version tags.
A retry checks GitHub's latest stable release again before moving floating
aliases, so backfilling an old release does not intentionally roll them back.
The workflow serializes publications across variants/releases; it never
cancels an in-progress copy. GitHub concurrency can replace a pending run with
another pending run; use manual dispatch to backfill a skipped release.

Registry tag changes are not transactional. If publishing fails partway
through, the workflow fails visibly and can be rerun; already copied layers
are reused. GHCR remains independently available. The workflow saves successful
verification as a 90-day Actions artifact named
`dockerhub-verification-<run-id>-<attempt>`.

## Pulling from Docker Hub

After the initial publication is verified:

```bash
docker pull dizys/t3code-docker:0.18.0
docker pull dizys/t3code-docker:0.18.0-core
```

Users can set `T3_IMAGE=dizys/t3code-docker:0.18.0` in `.env` using the existing
Compose configuration. This changes only the image registry; keep existing
home, state, and workspace mounts. Docker Hub's normal pull limits apply.

## Local validation

With `gh` and `regctl` on PATH:

```bash
node scripts/publish-dockerhub.mjs v0.18.0 --dry-run
node --test tests/dockerhub-release.test.mjs
```

The publisher always uses code from `main` in CI, never executes code from the
selected release tag, and passes tag values as process arguments rather than
shell source. No Docker Hub credentials are needed for a dry run.
