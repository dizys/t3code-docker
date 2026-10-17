import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { releasePlan, releaseVersion, verifyIndex, publishPlan, SOURCE, DESTINATION } from '../scripts/lib/dockerhub-release.mjs';
const hash = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
function fixture(tag = 'v0.18.0', latest = tag) {
  const sha = 'a'.repeat(40), builds = [], tags = [], raw = new Map();
  for (const variant of ['core', 'browser']) {
    const members = ['amd64', 'arm64'].map((arch) => {
      const digest = hash(variant + arch), indexDigest = hash('index' + variant + arch);
      builds.push({ target: variant, platform: `linux/${arch}`, digest, indexDigest, sourceSha: sha, tested: true,
        ref: `${SOURCE}@${digest}`, indexRef: `${SOURCE}@${indexDigest}` });
      return { platform: `linux/${arch}`, digest };
    });
    const body = JSON.stringify({ schemaVersion: 2, manifests: [...members.map((m) => ({ digest: m.digest, platform: { os: 'linux', architecture: m.platform.split('/')[1] } })), { digest: hash('attestation'), platform: { os: 'unknown', architecture: 'unknown' } }] });
    const digest = hash(body); raw.set(digest, body);
    tags.push({ tag: `${tag.slice(1)}-${variant}`, variant, digest, members });
  }
  const input = { tag, latest, release: { tag_name: tag, draft: false, prerelease: tag.includes('-') }, sourceSha: sha,
    verification: { version: tag, sourceSha: sha, tags }, builds };
  return { input, raw, plans: releasePlan(input) };
}
test('stable latest mirrors all 15 aliases; old releases and prereleases only get version tags', () => {
  assert.equal(fixture().plans.flatMap((p) => p.tags).length, 15);
  for (const [tag, latest] of [['v0.17.0','v0.18.0'], ['v0.19.0-rc.1','v0.18.0']]) {
    const { plans } = fixture(tag, latest);
    assert.equal(plans.flatMap((p) => p.tags).length, 5);
    assert.ok(plans.every((p) => p.tags.every((t) => t.startsWith(tag.slice(1)))));
  }
});
test('published metadata, exact commit, four builds, and tested platforms are required', () => {
  const mutations = [
    (x) => { x.release.draft = true; }, (x) => { x.release.prerelease = true; },
    (x) => { x.sourceSha = 'b'.repeat(40); }, (x) => { x.builds.pop(); },
    (x) => { x.builds[0].tested = false; }, (x) => { x.builds[0].platform = 'linux/arm64'; },
    (x) => { x.builds[0].ref = 'untrusted/image'; }, (x) => { x.verification.tags[0].members.pop(); },
  ];
  for (const mutate of mutations) { const { input } = fixture(); mutate(input); assert.throws(() => releasePlan(input)); }
  for (const tag of ['main', '../../x', 'v1.2', 'v01.2.3', 'v1.2.3;echo x']) assert.throws(() => releaseVersion(tag));
});
test('index bytes, both platforms, and provenance descriptors are preserved', () => {
  const { plans, raw } = fixture(); const p = plans[0], body = raw.get(p.digest);
  verifyIndex(body, p);
  assert.throws(() => verifyIndex(body + ' ', p), /bytes differ/);
  assert.throws(() => verifyIndex(body, { ...p, members: p.members.slice(1) }), /members differ/);
});
function registry(world, { brokenStage = false, latest = world.input.tag, collision = false } = {}) {
  const writes = [], images = new Map([...world.raw].map(([digest, body]) => [`${SOURCE}@${digest}`, body]));
  for (const [digest, body] of world.raw) images.set(`${DESTINATION}@${digest}`, body);
  return { writes, images, driver: {
    tag: world.input.tag, latest: async () => latest,
    read: async (ref) => { assert.ok(images.has(ref), ref); return images.get(ref); },
    existing: async () => collision ? '{}' : null,
    copy: async (src, dst) => {
      writes.push({ src, dst });
      images.set(dst, brokenStage && dst.includes('candidate-') ? '{}' : images.get(src));
    },
  } };
}
test('copies indexes by digest, validates both staged variants, and verifies all final tags', async () => {
  const world = fixture(), fake = registry(world);
  const result = await publishPlan(world.plans, fake.driver);
  assert.equal(result.length, 15);
  assert.equal(fake.writes.length, 17);
  assert.ok(fake.writes.slice(0,2).every((w) => w.src.startsWith(SOURCE + '@') && w.dst.includes('candidate-')));
  for (const p of world.plans) for (const tag of p.tags) verifyIndex(fake.images.get(`${DESTINATION}:${tag}`), p);
});
test('a damaged staged index or existing version collision cannot move release tags', async () => {
  for (const options of [{ brokenStage: true }, { collision: true }]) {
    const world = fixture(), fake = registry(world, options);
    await assert.rejects(publishPlan(world.plans, fake.driver));
    assert.ok(fake.writes.every((w) => w.dst.includes('candidate-')));
  }
});
test('a newer release published during copying prevents updating floating aliases', async () => {
  const world = fixture(), fake = registry(world, { latest: 'v0.19.0' });
  const result = await publishPlan(world.plans, fake.driver);
  assert.equal(result.length, 5);
  assert.ok(result.every((r) => r.tag.startsWith('0.18.0')));
});
