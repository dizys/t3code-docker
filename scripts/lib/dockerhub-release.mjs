// Distribution only: copy the immutable release indexes, never rebuild them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const REPOSITORY = 'dizys/t3code-docker';
export const SOURCE = `ghcr.io/${REPOSITORY}`;
export const DESTINATION = `docker.io/${REPOSITORY}`;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
export function releaseVersion(tag) {
  assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/, 'Expected a release tag such as v0.18.0');
  return tag.slice(1);
}
export function releasePlan({ tag, release, latest, sourceSha, verification, builds }) {
  const version = releaseVersion(tag);
  assert.equal(release.tag_name, tag);
  assert.equal(release.draft, false, 'Only published releases can be mirrored');
  assert.equal(release.prerelease, version.includes('-'), 'Prerelease metadata disagrees with the tag');
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(verification.version, tag);
  assert.equal(verification.sourceSha, sourceSha);
  assert.equal(builds.length, 4, 'Expected four tested build records');
  const floating = !release.prerelease && latest === tag;
  const minor = version.split('.').slice(0, 2).join('.');
  return ['core', 'browser'].map((variant) => {
    const records = builds.filter((b) => b.target === variant);
    assert.equal(records.length, 2);
    const members = ['amd64', 'arm64'].map((arch) => {
      const b = records.find((b) => b.platform === `linux/${arch}`);
      assert.ok(b, `Missing ${variant}/${arch}`);
      assert.equal(b.tested, true); assert.equal(b.sourceSha, sourceSha);
      assert.match(b.digest, DIGEST); assert.match(b.indexDigest, DIGEST);
      assert.equal(b.ref, `${SOURCE}@${b.digest}`);
      assert.equal(b.indexRef, `${SOURCE}@${b.indexDigest}`);
      return { platform: b.platform, digest: b.digest };
    });
    const index = verification.tags.find((t) => t.tag === `${version}-${variant}` && t.variant === variant);
    assert.ok(index, `Missing verified ${variant} release index`);
    assert.match(index.digest, DIGEST);
    assert.deepEqual([...index.members].sort((a,b) => a.platform.localeCompare(b.platform)), members);
    const alias = variant === 'core' ? 'slim' : 'full';
    const tags = [`${version}-${variant}`, `${version}-${alias}`, ...(variant === 'browser' ? [version] : [])];
    if (floating) tags.push(variant, alias, `${minor}-${variant}`, `${minor}-${alias}`, ...(variant === 'browser' ? [minor, 'latest'] : []));
    return { variant, digest: index.digest, members, tags };
  });
}
export function verifyIndex(raw, plan) {
  const digest = 'sha256:' + createHash('sha256').update(raw).digest('hex');
  assert.equal(digest, plan.digest, 'Index bytes differ from the verified release');
  const index = JSON.parse(raw);
  const members = index.manifests.filter((m) => !(m.platform?.os === 'unknown' && m.platform?.architecture === 'unknown'))
    .map((m) => ({ platform: `${m.platform?.os}/${m.platform?.architecture}`, digest: m.digest }))
    .sort((a,b) => a.platform.localeCompare(b.platform));
  assert.deepEqual(members, plan.members, 'Index members differ from the tested builds');
}
/** All sources and both staged copies must pass before any release tag moves.
 * The whole index is copied, retaining embedded provenance manifests. */
export async function publishPlan(plans, { read, copy, latest, tag, existing, report = () => {} }) {
  for (const p of plans) verifyIndex(await read(`${SOURCE}@${p.digest}`), p);
  for (const p of plans) {
    const staging = `${DESTINATION}:candidate-${p.digest.slice(7, 23)}-${p.variant}`;
    await copy(`${SOURCE}@${p.digest}`, staging);
    verifyIndex(await read(staging), p);
  }
  // A queued retry of an older release must not overwrite a newer latest.
  const moveFloating = await latest() === tag;
  // Refuse to silently rewrite an existing versioned Docker Hub release.
  for (const p of plans) for (const imageTag of p.tags.filter((t) => t.startsWith(tag.slice(1)))) {
    const raw = await existing(`${DESTINATION}:${imageTag}`);
    if (raw !== null) verifyIndex(raw, p);
  }
  const results = [];
  for (const p of plans) for (const imageTag of p.tags) {
    if (!imageTag.startsWith(tag.slice(1)) && !moveFloating) continue;
    const ref = `${DESTINATION}:${imageTag}`;
    await copy(`${DESTINATION}@${p.digest}`, ref);
    verifyIndex(await read(ref), p);
    results.push({ tag: imageTag, variant: p.variant, digest: p.digest });
    report(`Verified ${ref}`);
  }
  return results;
}
