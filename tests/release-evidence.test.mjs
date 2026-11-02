import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { EVIDENCE_FILES, REPOSITORY, SOURCE, releasePlan, verifyIndex } from '../scripts/lib/dockerhub-release.mjs';
import { attachEvidence, attachPlan, checkRun, ghcrReader, releaseTags, sha256, verifyRelease } from '../scripts/lib/release-evidence.mjs';

const SHA = 'a'.repeat(40), RUN_URL = `https://github.com/${REPOSITORY}/actions/runs/7`;
const file = (name) => ({ name, path: `/tmp/evidence/${name}`, digest: sha256(name) });
const FILES = EVIDENCE_FILES.map(file);
const PATHS = FILES.map((entry) => entry.path);

function world(tag = 'v0.18.0', { provenance = true } = {}) {
  const documents = new Map(), builds = [];
  const put = (kind, data) => {
    const bytes = Buffer.from(JSON.stringify(data)), digest = sha256(bytes), document = { data, digest, bytes };
    documents.set(`${kind}/${digest}`, document);
    return document;
  };
  const image = (variant, arch, overrides = {}) => put('blobs', { os: 'linux', architecture: arch, config: {
    Env: [`T3_IMAGE_VERSION=${tag}`, `T3_IMAGE_VARIANT=${variant}`],
    Labels: { 'org.opencontainers.image.revision': SHA, 'org.opencontainers.image.version': tag.slice(1), 'org.opencontainers.image.source': `https://github.com/${REPOSITORY}` },
    ...overrides,
  } });
  const promoted = new Map();
  for (const variant of ['core', 'browser']) {
    const descriptors = [];
    for (const arch of ['amd64', 'arm64']) {
      const manifest = put('manifests', { config: { digest: image(variant, arch).digest } });
      const own = [
        { digest: manifest.digest, platform: { os: 'linux', architecture: arch } },
        ...(provenance ? [{ digest: sha256(`provenance ${variant} ${arch}`), platform: { os: 'unknown', architecture: 'unknown' },
          annotations: { 'vnd.docker.reference.digest': manifest.digest, 'vnd.docker.reference.type': 'attestation-manifest' } }] : []),
      ];
      descriptors.push(...own);
      const index = put('manifests', { manifests: own });
      builds.push({ target: variant, platform: `linux/${arch}`, digest: manifest.digest, indexDigest: index.digest, ref: `${SOURCE}@${manifest.digest}`, indexRef: `${SOURCE}@${index.digest}`, tested: true, sourceSha: SHA, runUrl: RUN_URL });
    }
    promoted.set(variant, put('manifests', { manifests: descriptors }));
    for (const imageTag of releaseTags(tag, variant)) documents.set(`manifests/${imageTag}`, promoted.get(variant));
  }
  const read = async (kind, reference) => {
    const document = documents.get(`${kind}/${reference}`);
    assert.ok(document, `${kind}/${reference} isn't in the registry`);
    return document;
  };
  const input = () => ({ tag, sourceSha: SHA, run: { id: 7, run_attempt: 1 }, builds, read });
  return { tag, documents, builds, put, image, promoted, read, input };
}

test('a stable release proves all nine tags, in a form the Docker Hub publisher accepts', async () => {
  const w = world();
  const verification = await verifyRelease(w.input());
  assert.equal(verification.tags.length, 9);
  assert.equal(verification.images.length, 4);
  const plans = releasePlan({ tag: w.tag, release: { tag_name: w.tag, draft: false, prerelease: false }, latest: w.tag, sourceSha: SHA, verification, builds: w.builds });
  assert.equal(plans.flatMap((plan) => plan.tags).length, 9);
  assert.deepEqual(plans.flatMap((plan) => plan.tags).sort(), verification.tags.map((entry) => entry.tag).sort());
  for (const plan of plans) verifyIndex(w.promoted.get(plan.variant).bytes, plan);
});

test('a prerelease proves only its own tags, leaving the floating names alone', async () => {
  const w = world('v0.19.0-rc.1');
  const verification = await verifyRelease(w.input());
  assert.deepEqual(verification.tags.map((entry) => entry.tag), ['0.19.0-rc.1-core', '0.19.0-rc.1-browser', '0.19.0-rc.1']);
  const plans = releasePlan({ tag: w.tag, release: { tag_name: w.tag, draft: false, prerelease: true }, latest: 'v0.18.0', sourceSha: SHA, verification, builds: w.builds });
  assert.equal(plans.flatMap((plan) => plan.tags).length, 3);
});

test('build records can arrive in any order and the output stays the same', async () => {
  const w = world();
  const shuffled = await verifyRelease({ ...w.input(), builds: [...w.builds].reverse() });
  assert.deepEqual(shuffled.images, (await verifyRelease(w.input())).images);
  assert.deepEqual(shuffled.images.map((entry) => `${entry.variant} ${entry.platform}`), ['core linux/amd64', 'core linux/arm64', 'browser linux/amd64', 'browser linux/arm64']);
});

test('a tag or image that differs from what was tested is refused', async () => {
  const swapConfig = (overrides) => (w) => {
    const build = w.builds[0], manifest = w.put('manifests', { config: { digest: w.image(build.target, 'amd64', overrides).digest } });
    w.documents.set(`manifests/${build.digest}`, { ...manifest, digest: build.digest });
  };
  const labels = (name, value) => ({ Labels: { 'org.opencontainers.image.revision': SHA, 'org.opencontainers.image.version': '0.18.0', 'org.opencontainers.image.source': `https://github.com/${REPOSITORY}`, [name]: value } });
  const cases = {
    'a floating tag points at the other variant': (w) => w.documents.set('manifests/latest', w.promoted.get('core')),
    'one tag of a variant has its own index': (w) => w.documents.set('manifests/0.18', w.put('manifests', { manifests: [...w.promoted.get('browser').data.manifests].reverse() })),
    'a tag is missing': (w) => w.documents.delete('manifests/core'),
    'promotion dropped provenance': (w) => w.documents.set('manifests/core', w.put('manifests', { manifests: w.promoted.get('core').data.manifests.filter((entry) => entry.platform.os !== 'unknown') })),
    'the image has another version stamp': swapConfig({ Env: ['T3_IMAGE_VERSION=v0.17.0', 'T3_IMAGE_VARIANT=core'] }),
    'the image has another variant stamp': swapConfig({ Env: ['T3_IMAGE_VERSION=v0.18.0', 'T3_IMAGE_VARIANT=browser'] }),
    'the image was built from another commit': swapConfig(labels('org.opencontainers.image.revision', 'b'.repeat(40))),
    'a record is not marked as tested': (w) => { w.builds[0].tested = false; },
    'a record is for another commit': (w) => { w.builds[0].sourceSha = 'b'.repeat(40); },
    'a record is from another run': (w) => { w.builds[0].runUrl = 'https://example.com/run'; },
    'a record is missing': (w) => { w.builds.pop(); },
    'a record is duplicated': (w) => { w.builds[3] = w.builds[2]; },
    'a record names another image': (w) => { w.builds[0].ref = 'untrusted/image'; },
  };
  for (const [label, damage] of Object.entries(cases)) {
    const w = world();
    damage(w);
    await assert.rejects(verifyRelease(w.input()), undefined, label);
  }
});

test('images built without provenance are refused, even when every tag agrees', async () => {
  await assert.rejects(verifyRelease(world('v0.18.0', { provenance: false }).input()), /Provenance must cover each tested image/);
});

test('promotion must keep the original provenance, not just some provenance', async () => {
  const w = world();
  const manifests = w.promoted.get('core').data.manifests.map((entry) => (entry.platform.os === 'unknown' ? { ...entry, digest: sha256(`forged ${entry.digest}`) } : entry));
  const forged = w.put('manifests', { manifests });
  for (const imageTag of releaseTags(w.tag, 'core')) w.documents.set(`manifests/${imageTag}`, forged);
  await assert.rejects(verifyRelease(w.input()), /Promotion changed the original/);
});

const job = (name, conclusion = 'success', status = 'completed') => ({ name, status, conclusion });
const jobs = () => ['lint', 'versions', 'native-runtime / plan', 'native-runtime / publish', 'native-runtime / native 0.1.6 (amd64)', 'native-runtime / native 0.1.6 (arm64)', 'native-runtime / native 0.1.7-nightly.1 (amd64)', 'native-runtime / native 0.1.7-nightly.1 (arm64)', 'core (amd64)', 'core (arm64)', 'browser (amd64)', 'browser (arm64)', 'merge (core)', 'merge (browser)'].map((name) => job(name));
const finished = { head_sha: SHA, head_branch: 'v0.18.0', event: 'push', repository: { full_name: REPOSITORY }, path: '.github/workflows/build.yml', status: 'completed', conclusion: 'success' };
const running = { ...finished, status: 'in_progress', conclusion: null };
const check = (overrides = {}) => checkRun({ run: finished, jobs: jobs(), tag: 'v0.18.0', sourceSha: SHA, ...overrides });

test('a finished run must have passed; from inside the run, every job but this one must have', () => {
  check();
  check({ run: running, jobs: [...jobs(), job('release-evidence', null, 'in_progress')], self: 'release-evidence' });
  assert.throws(() => check({ run: running }), /in_progress/);
  assert.throws(() => check({ run: { ...finished, conclusion: 'failure' } }));
  // `self` only excuses itself.
  assert.throws(() => check({ run: running, jobs: [...jobs(), job('release-evidence', null, 'in_progress'), job('late', null, 'in_progress')], self: 'release-evidence' }), /late/);
});

test('a failed, missing or skipped required job fails the check, and so does the wrong run', () => {
  const without = (name) => jobs().filter((entry) => entry.name !== name);
  for (const name of ['lint', 'versions', 'native-runtime / publish', 'core (arm64)', 'browser (amd64)', 'merge (browser)']) {
    assert.throws(() => check({ jobs: without(name) }), undefined, `${name} missing`);
    assert.throws(() => check({ jobs: [...without(name), job(name, 'failure')] }), undefined, `${name} failed`);
    assert.throws(() => check({ jobs: [...without(name), job(name, 'skipped')] }), undefined, `${name} skipped`);
  }
  for (const run of [{ ...finished, head_sha: 'b'.repeat(40) }, { ...finished, head_branch: 'v0.17.0' }, { ...finished, event: 'workflow_dispatch' }, { ...finished, path: '.github/workflows/other.yml' }, { ...finished, repository: { full_name: 'someone/fork' } }]) assert.throws(() => check({ run }));
});

test('one native version per architecture is enough, but none is not', () => {
  // The planner drops duplicates, so this is what a pin equal to nightly looks like.
  check({ jobs: jobs().filter((entry) => !entry.name.includes('nightly')) });
  const noArm = jobs().filter((entry) => !/native .*\(arm64\)/.test(entry.name));
  assert.throws(() => check({ jobs: noArm }), /No native runtime job ran on arm64/);
  const skipped = jobs().map((entry) => (/nightly.*\(amd64\)/.test(entry.name) ? job(entry.name, 'skipped') : entry));
  assert.throws(() => check({ jobs: skipped }), /skipped on amd64/);
});

// The fake only knows what the job does, so an unexpected write fails the test.
function github({ release = null, tagType = 'tag', mangle = false, viewError = null } = {}) {
  let state = release;
  const calls = [];
  const attached = (args) => args.filter((arg) => arg.startsWith('/tmp/evidence/')).map((arg) => {
    const name = arg.split('/').pop();
    return { name, digest: mangle ? sha256('mangled') : sha256(name) };
  });
  const gh = async (args) => {
    calls.push(args);
    const [group, action] = args;
    if (group === 'release' && action === 'view') {
      if (viewError) throw Object.assign(new Error('failed'), { stderr: viewError });
      if (!state) throw Object.assign(new Error('failed'), { stderr: 'release not found\n' });
      return JSON.stringify(state);
    }
    if (group === 'release' && action === 'create') { state = { isDraft: true, assets: attached(args) }; return ''; }
    if (group === 'release' && action === 'upload') {
      const fresh = attached(args);
      state = { ...state, assets: [...state.assets.filter((asset) => !fresh.some((entry) => entry.name === asset.name)), ...fresh] };
      return '';
    }
    if (group === 'workflow' && action === 'run') return '';
    if (group === 'api' && action.includes('/git/ref/tags/')) return JSON.stringify({ object: { type: tagType, sha: 'c'.repeat(40) } });
    if (group === 'api' && action.endsWith(`/git/tags/${'c'.repeat(40)}`)) return JSON.stringify({ message: 'v0.18.0: A good title\n\nMore words\n' });
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  };
  const writes = () => calls.filter(([group, action]) => !(group === 'release' && action === 'view') && group !== 'api');
  return { gh, calls, writes, state: () => state };
}
const attach = (fake, tag = 'v0.18.0') => attachEvidence({ tag, files: FILES, gh: fake.gh });
const dispatch = ['workflow', 'run', 'dockerhub.yml', '-R', REPOSITORY, '--ref', 'main', '-f', 'tag=v0.18.0', '-f', 'dry_run=false'];

test('with no release yet, a draft is created with the evidence and the tag message as its title', async () => {
  const fake = github();
  await attach(fake);
  assert.deepEqual(fake.writes(), [['release', 'create', 'v0.18.0', '-R', REPOSITORY, '--draft', '--verify-tag', '--title', 'v0.18.0: A good title', '--notes', '', ...PATHS]]);
  assert.equal(fake.state().isDraft, true);
});

test('a lightweight tag titles the draft with its name, and a prerelease draft is marked as one', async () => {
  const lightweight = github({ tagType: 'commit' });
  await attach(lightweight);
  assert.equal(lightweight.writes()[0][lightweight.writes()[0].indexOf('--title') + 1], 'v0.18.0');
  const prerelease = github();
  await attach(prerelease, 'v0.19.0-rc.1');
  assert.ok(prerelease.writes()[0].includes('--prerelease'));
});

test("a maintainer's draft gets the evidence, replacing a rerun's older copies, and stays a draft", async () => {
  const fake = github({ release: { isDraft: true, assets: [{ name: 'registry-verification.json', digest: sha256('older') }] } });
  await attach(fake);
  assert.deepEqual(fake.writes(), [['release', 'upload', 'v0.18.0', '-R', REPOSITORY, '--clobber', ...PATHS]]);
  assert.equal(fake.state().assets.length, 5);
  assert.ok(fake.state().assets.every((asset) => asset.digest !== sha256('older')));
});

test('a release published too early gets its evidence and then its mirror', async () => {
  const fake = github({ release: { isDraft: false, assets: [] } });
  await attach(fake);
  assert.deepEqual(fake.writes(), [['release', 'upload', 'v0.18.0', '-R', REPOSITORY, ...PATHS], dispatch]);
});

test('a published release keeps the evidence it has and only gains what it lacks', async () => {
  const [kept, ...rest] = FILES;
  const fake = github({ release: { isDraft: false, assets: [{ name: kept.name, digest: sha256('original') }] } });
  await attach(fake);
  assert.deepEqual(fake.writes(), [['release', 'upload', 'v0.18.0', '-R', REPOSITORY, ...rest.map((entry) => entry.path)], dispatch]);
  assert.equal(fake.state().assets.find((asset) => asset.name === kept.name).digest, sha256('original'));
});

test('a published release with all its evidence is left alone, so a rerun changes nothing', async () => {
  const fake = github({ release: { isDraft: false, assets: FILES.map(({ name, digest }) => ({ name, digest })) } });
  const plan = await attach(fake);
  assert.deepEqual(fake.writes(), []);
  assert.deepEqual(plan, { create: false, upload: [], clobber: false, mirror: false });
});

test('an upload that differs from the local file fails before the mirror starts', async () => {
  const fake = github({ release: { isDraft: false, assets: [] }, mangle: true });
  await assert.rejects(attach(fake), /differs from what was uploaded/);
  assert.ok(!fake.writes().some(([group]) => group === 'workflow'));
});

test('only a missing release counts as missing; other GitHub errors stop the job', async () => {
  const fake = github({ viewError: 'HTTP 502: Bad Gateway\n' });
  await assert.rejects(attach(fake));
  assert.deepEqual(fake.writes(), []);
  assert.deepEqual(attachPlan(null).upload, EVIDENCE_FILES);
});

test('registry reads are anonymous and each response must match the digest it claims', async () => {
  const body = Buffer.from('{"ok":true}'), digest = sha256(body);
  const seen = [];
  const request = (headers = {}, bytes = body) => async (url, options) => {
    seen.push({ url: String(url), options });
    if (String(url).startsWith('https://ghcr.io/token')) return new Response(JSON.stringify({ token: 'pull-token' }));
    return new Response(bytes, { headers });
  };
  const read = await ghcrReader(request());
  assert.deepEqual((await read('manifests', digest)).data, { ok: true });
  await read('manifests', digest);
  assert.equal(seen.filter((entry) => entry.url.includes('/v2/')).length, 1, 'repeat reads come from the cache');
  assert.equal(new URL(seen[0].url).searchParams.get('scope'), `repository:${REPOSITORY}:pull`);
  await assert.rejects((await ghcrReader(request({}, Buffer.from('{"ok":false}'))))('manifests', digest), /digest mismatch/);
  await assert.rejects((await ghcrReader(request({ 'docker-content-digest': sha256('other') })))('manifests', '0.18.0'), /disagrees/);
  await assert.rejects(read('manifests', '../../other'));
  await assert.rejects(read('layers', digest));
});

test('the command refuses bad arguments before contacting anything', () => {
  const script = new URL('../scripts/release-evidence.mjs', import.meta.url).pathname;
  const dir = '/tmp/nowhere', run = '7';
  for (const args of [[], ['v0.18.0', SHA, run], ['main', SHA, run, dir], ['v0.18.0;echo', SHA, run, dir], ['v0.18.0', 'abc', run, dir], ['v0.18.0', SHA, 'x', dir], ['v0.18.0', SHA, run, dir, '--force']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.notEqual(result.status, 0, args.join(' '));
    assert.doesNotMatch(result.stderr, /ENOENT|spawn gh/, `${args.join(' ')} got as far as calling gh`);
  }
});

test('the workflows stay wired to this job', () => {
  const build = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
  const start = build.indexOf('\n  release-evidence:\n');
  assert.ok(start > 0, 'build.yml has no release-evidence job');
  const job = build.slice(start + 1);
  assert.ok(job.split('\n').slice(1).every((line) => !/^ {2}\S/.test(line)), 'release-evidence should be the last job');
  assert.match(job, /if: github\.event_name == 'push' && github\.ref_type == 'tag' && github\.repository == 'dizys\/t3code-docker'/);
  assert.match(job, /needs: \[lint, versions, native-runtime, build, merge\]/);
  assert.match(job, /actions: write\n\s+contents: write/);
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /pattern: build-evidence-\*/);
  // checkRun excuses this job by GITHUB_JOB, which only equals its name without a `name:`.
  assert.doesNotMatch(job, /^ {4}name:/m);
  const dockerhub = readFileSync(new URL('../.github/workflows/dockerhub.yml', import.meta.url), 'utf8');
  for (const input of ['tag', 'dry_run']) assert.match(dockerhub, new RegExp(`^ {6}${input}:`, 'm'));
  assert.equal(EVIDENCE_FILES[0], 'registry-verification.json', 'the publisher reads the verification first');
});
