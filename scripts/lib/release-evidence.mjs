// Proves a release tag's images are the ones CI tested, and records that proof
// on the GitHub release. The Docker Hub mirror refuses a release without it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EVIDENCE_FILES, REPOSITORY, SOURCE, releaseVersion } from './dockerhub-release.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACCEPT = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
const VARIANTS = ['core', 'browser'], ARCHES = ['amd64', 'arm64'];
// The planner drops duplicates, so a pinned version equal to nightly leaves one
// native job per architecture. Those are checked separately below.
const REQUIRED_JOBS = ['lint', 'versions', 'native-runtime / plan', 'native-runtime / publish', 'core (amd64)', 'core (arm64)', 'browser (amd64)', 'browser (arm64)', 'merge (core)', 'merge (browser)'];
export const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

/** Every tag `merge` promotes in build.yml. A prerelease leaves the floating names alone. */
export function releaseTags(tag, variant) {
  const version = releaseVersion(tag);
  if (version.includes('-')) return variant === 'core' ? [`${version}-core`] : [`${version}-browser`, version];
  const minor = version.split('.').slice(0, 2).join('.');
  return variant === 'core' ? [`${version}-core`, `${minor}-core`, 'core']
    : [`${version}-browser`, version, `${minor}-browser`, minor, 'browser', 'latest'];
}

/** `self` is the running job when called from inside the run, which can't have finished yet. */
export function checkRun({ run, jobs, tag, sourceSha, self = null }) {
  assert.equal(run.head_sha, sourceSha);
  assert.equal(run.head_branch, tag);
  assert.equal(run.event, 'push');
  assert.equal(run.repository.full_name, REPOSITORY);
  assert.equal(run.path, '.github/workflows/build.yml');
  if (!self) { assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success'); }
  const others = jobs.filter((job) => job.name !== self);
  for (const job of others) {
    assert.equal(job.status, 'completed', job.name);
    assert.ok(['success', 'skipped'].includes(job.conclusion), `${job.name}: ${job.conclusion}`);
  }
  for (const name of REQUIRED_JOBS) {
    const matches = others.filter((job) => job.name === name);
    assert.equal(matches.length, 1, `Expected exactly one ${name} job`);
    assert.equal(matches[0].conclusion, 'success', name);
  }
  for (const arch of ARCHES) {
    const native = others.filter((job) => job.name.startsWith('native-runtime / native ') && job.name.endsWith(`(${arch})`));
    assert.ok(native.length > 0, `No native runtime job ran on ${arch}`);
    assert.ok(native.every((job) => job.conclusion === 'success'), `A native runtime job was skipped on ${arch}`);
  }
}

export function checkBuilds(builds, { sourceSha, runUrl }) {
  assert.equal(builds.length, 4, 'Expected four tested build records');
  for (const variant of VARIANTS) for (const arch of ARCHES) {
    const matches = builds.filter((build) => build.target === variant && build.platform === `linux/${arch}`);
    assert.equal(matches.length, 1, `Expected one ${variant}/${arch} build record`);
    const [build] = matches;
    assert.equal(build.tested, true); assert.equal(build.sourceSha, sourceSha);
    assert.match(build.digest, DIGEST); assert.match(build.indexDigest, DIGEST);
    assert.equal(build.ref, `${SOURCE}@${build.digest}`);
    assert.equal(build.indexRef, `${SOURCE}@${build.indexDigest}`);
    assert.equal(build.runUrl, runUrl);
  }
}

const sortMembers = (members) => [...members].sort((a, b) => a.platform.localeCompare(b.platform));
function verifyMembers(index, expected, name) {
  assert.ok(Array.isArray(index.manifests), 'Multi-platform index missing');
  const isProvenance = (member) => member.platform?.os === 'unknown' && member.platform?.architecture === 'unknown';
  const members = sortMembers(index.manifests.filter((member) => !isProvenance(member))
    .map((member) => ({ platform: `${member.platform?.os}/${member.platform?.architecture}`, digest: member.digest })));
  assert.deepEqual(members, sortMembers(expected), `${name} differs from the tested platform digests`);
  const provenance = index.manifests.filter(isProvenance);
  assert.deepEqual(provenance.map((member) => member.annotations?.['vnd.docker.reference.digest']).sort(), expected.map((member) => member.digest).sort(), 'Provenance must cover each tested image');
  for (const member of provenance) {
    assert.match(member.digest, DIGEST);
    assert.equal(member.annotations?.['vnd.docker.reference.type'], 'attestation-manifest');
  }
  return members;
}

/** Reads registry metadata only, never layers. Returns what `registry-verification.json` holds. */
export async function verifyRelease({ tag, sourceSha, run, builds: records, read, report = () => {} }) {
  const runUrl = `https://github.com/${REPOSITORY}/actions/runs/${run.id}`;
  checkBuilds(records, { sourceSha, runUrl });
  const builds = VARIANTS.flatMap((variant) => ARCHES.map((arch) => records.find((build) => build.target === variant && build.platform === `linux/${arch}`)));
  const result = { version: tag, sourceSha, runId: run.id, runUrl, runAttempt: run.run_attempt, verifiedAt: new Date().toISOString(), registry: 'ghcr.io', tags: [], images: [], platforms: [], originalIndexes: [] };
  const descriptors = new Map();
  for (const build of builds) {
    const { data: original } = await read('manifests', build.indexDigest);
    verifyMembers(original, [{ platform: build.platform, digest: build.digest }], build.indexDigest);
    descriptors.set(build.target, [...(descriptors.get(build.target) ?? []), ...original.manifests]);
    result.originalIndexes.push({ variant: build.target, platform: build.platform, digest: build.indexDigest, descriptors: original.manifests });
    const { data: manifest } = await read('manifests', build.digest);
    assert.match(manifest.config.digest, DIGEST);
    const { data: config } = await read('blobs', manifest.config.digest);
    assert.equal(config.os, 'linux'); assert.equal(config.architecture, build.platform.split('/')[1]);
    const stamp = (name) => {
      const values = config.config.Env.filter((entry) => entry.startsWith(`${name}=`));
      assert.equal(values.length, 1, `Expected one ${name} image stamp`);
      return values[0].slice(name.length + 1);
    };
    assert.equal(stamp('T3_IMAGE_VERSION'), tag); assert.equal(stamp('T3_IMAGE_VARIANT'), build.target);
    assert.equal(config.config.Labels['org.opencontainers.image.revision'], sourceSha);
    assert.ok([tag, tag.slice(1)].includes(config.config.Labels['org.opencontainers.image.version']));
    assert.equal(config.config.Labels['org.opencontainers.image.source'], `https://github.com/${REPOSITORY}`);
    result.images.push({ variant: build.target, platform: build.platform, digest: build.digest, imageVersion: tag, sourceSha });
    result.platforms.push({ variant: build.target, platform: build.platform, digest: build.digest, configDigest: manifest.config.digest });
    report(`Verified original index, config and labels: ${build.target}/${build.platform}`);
  }
  const byDigest = (members) => [...members].sort((a, b) => a.digest.localeCompare(b.digest));
  for (const variant of VARIANTS) {
    const expected = builds.filter((build) => build.target === variant).map((build) => ({ platform: build.platform, digest: build.digest }));
    let indexDigest;
    for (const imageTag of releaseTags(tag, variant)) {
      const { data: index, digest } = await read('manifests', imageTag);
      const members = verifyMembers(index, expected, imageTag);
      assert.deepEqual(byDigest(index.manifests), byDigest(descriptors.get(variant)), 'Promotion changed the original image or provenance descriptors');
      if (indexDigest) assert.equal(digest, indexDigest, `${variant} tags point at different indexes`);
      indexDigest = digest;
      result.tags.push({ tag: imageTag, variant, members, digest });
      report(`Verified ${SOURCE}:${imageTag}`);
    }
  }
  return result;
}

/** Anonymous GHCR metadata reads. Every response is hashed against the digest it claims. */
export async function ghcrReader(request = fetch) {
  const get = async (url, options = {}) => {
    const response = await request(url, { ...options, signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `${new URL(url).pathname}: HTTP ${response.status}`);
    return response;
  };
  const auth = new URL('https://ghcr.io/token');
  auth.searchParams.set('service', 'ghcr.io');
  auth.searchParams.set('scope', `repository:${REPOSITORY}:pull`);
  const { token } = await (await get(auth)).json();
  assert.ok(typeof token === 'string' && token.length > 0, 'Public pull token missing');
  const cache = new Map();
  return async (kind, reference) => {
    assert.ok(['manifests', 'blobs'].includes(kind));
    assert.match(reference, /^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9_][a-zA-Z0-9_.-]*)$/);
    const key = `${kind}/${reference}`;
    if (cache.has(key)) return cache.get(key);
    const response = await get(`https://ghcr.io/v2/${REPOSITORY}/${key}`, { headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT } });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length < 4 * 1024 * 1024, 'Registry metadata exceeds 4 MiB');
    const digest = sha256(bytes), header = response.headers.get('docker-content-digest');
    if (header) assert.equal(digest, header, 'Registry digest disagrees with the bytes it sent');
    if (reference.startsWith('sha256:')) assert.equal(digest, reference, 'Content digest mismatch');
    const document = { data: JSON.parse(bytes), digest, bytes };
    cache.set(key, document);
    return document;
  };
}

/**
 * A draft may be replaced, since nothing has read it yet. A published release
 * only gains what it lacks: its mirror may already have used what's there. If
 * it lacked anything, its mirror failed at publish time, so it must run again.
 */
export function attachPlan(release) {
  if (!release) return { create: true, upload: EVIDENCE_FILES, clobber: false, mirror: false };
  if (release.isDraft) return { create: false, upload: EVIDENCE_FILES, clobber: true, mirror: false };
  const attached = new Set(release.assets.map((asset) => asset.name));
  const upload = EVIDENCE_FILES.filter((name) => !attached.has(name));
  return { create: false, upload, clobber: false, mirror: upload.length > 0 };
}

export async function findRelease(gh, tag) {
  try {
    return JSON.parse(await gh(['release', 'view', tag, '-R', REPOSITORY, '--json', 'isDraft,assets']));
  } catch (error) {
    if (/release not found/i.test(error.stderr ?? '')) return null;
    throw error;
  }
}

/** The annotated tag's subject, which is how releases here are titled. */
async function tagTitle(gh, tag) {
  const { object } = JSON.parse(await gh(['api', `repos/${REPOSITORY}/git/ref/tags/${tag}`]));
  if (object.type !== 'tag') return tag;
  const { message } = JSON.parse(await gh(['api', `repos/${REPOSITORY}/git/tags/${object.sha}`]));
  return message.split('\n')[0].trim() || tag;
}

/** `files` holds `{ name, path, digest }` for each evidence file. */
export async function attachEvidence({ tag, files, gh }) {
  const plan = attachPlan(await findRelease(gh, tag));
  const chosen = plan.upload.map((name) => {
    const file = files.find((entry) => entry.name === name);
    assert.ok(file, `Missing evidence file ${name}`);
    return file;
  });
  const paths = chosen.map((file) => file.path);
  if (plan.create) {
    await gh(['release', 'create', tag, '-R', REPOSITORY, '--draft', '--verify-tag', '--title', await tagTitle(gh, tag), '--notes', '', ...(tag.includes('-') ? ['--prerelease'] : []), ...paths]);
  } else if (paths.length) {
    await gh(['release', 'upload', tag, '-R', REPOSITORY, ...(plan.clobber ? ['--clobber'] : []), ...paths]);
  }
  if (chosen.length) {
    const { assets } = await findRelease(gh, tag);
    for (const file of chosen) {
      const asset = assets.find((entry) => entry.name === file.name);
      assert.ok(asset, `${file.name} isn't on the release after uploading it`);
      assert.equal(asset.digest, file.digest, `${file.name} differs from what was uploaded`);
    }
  }
  // A release event can't start this from a job token, but a dispatch can.
  if (plan.mirror) await gh(['workflow', 'run', 'dockerhub.yml', '-R', REPOSITORY, '--ref', 'main', '-f', `tag=${tag}`, '-f', 'dry_run=false']);
  return plan;
}
