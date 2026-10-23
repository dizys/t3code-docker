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

## Repository Overview

The same workflow synchronizes Docker Hub's short description and Overview
from the current `main` README. Overview publishing runs independently of image
copying on releases, README/media/sync-code changes, and daily at 06:23 UTC.
The daily run repairs missing or edited content. Unchanged content is verified
without authenticating or submitting another update.

Relative guide links and image URLs point to the README's exact GitHub commit;
GitHub note markers become portable blockquotes. Run commands, Compose examples
and inline code stay unchanged. The sync rejects
empty content and Docker Hub's size limits instead of truncating instructions.
It uses the existing `DOCKERHUB_TOKEN` secret through Docker Hub's short-lived
metadata token API. Credentials are never passed to public verification reads
or included in artifacts. An authorization error identifies the secret and
repository permissions to check.

Successful publication requires an anonymous read-back matching the complete
Overview and short description. Transient failures have bounded retries;
missing, private or unexpected repositories fail before any write. A failed
Overview job is visible in Actions and does not prevent the independent image
copy job. Its artifact contains the rendered Markdown, source commit, content
hash and public verification result.

To backfill or repair the Overview without copying images or changing tags:

```bash
gh workflow run dockerhub.yml -R dizys/t3code-docker \
  --ref main -f overview_only=true
```

Add `-f dry_run=true` to compare without publishing. Manual Overview runs only
execute reviewed code from `main`; they do not run on feature branches.

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

For the latest stable release all **9 tag aliases** are mirrored:

- Browser: version, version-browser, minor, minor-browser, `browser`, and
  `latest`.
- Core: version-core, minor-core, and `core`.

Older releases and prereleases receive only their three full-version tags.
The retired `full` and `slim` aliases are not published for new releases;
tags already pushed under those names are left in place.
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

Overview generation and public checks need only Node and Git, with no registry
copy tool or credentials:

```bash
DOCKERHUB_OVERVIEW_OUTPUT=/tmp/dockerhub-overview.md \
  node scripts/sync-dockerhub-overview.mjs --dry-run
node scripts/sync-dockerhub-overview.mjs --check
node --test tests/dockerhub-overview.test.mjs
```

`--check` fails if the public Overview is missing or differs from the current
checkout's README and source commit. It never writes to Docker Hub. Inspect the
rendered Markdown before enabling a new publisher; after publication, check
the live Overview, including its banner, screenshots, quick start and guides.

The publisher always uses code from `main` in CI, never executes code from the
selected release tag, and passes tag values as process arguments rather than
shell source. No Docker Hub credentials are needed for a dry run.
