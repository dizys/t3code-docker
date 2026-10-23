import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { DESCRIPTION, overviewFromReadme, syncOverview } from '../scripts/lib/dockerhub-overview.mjs';

const sha = 'a'.repeat(40);
const blob = `https://github.com/dizys/t3code-docker/blob/${sha}/`;
const raw = `https://raw.githubusercontent.com/dizys/t3code-docker/${sha}/`;
const body = overviewFromReadme('# T3 Code\n\nRun it with Docker.\n', sha);
const publicRepo = { namespace: 'dizys', name: 't3code-docker', is_private: false, description: 'Old description', full_description: null };
const TOKEN = 'fake-pat-for-tests-only', JWT = 'fake.metadata.jwt';

function hub(options = {}) {
  let stored = { ...publicRepo, ...options.initial };
  const calls = [], waits = [];
  let patched = false, afterReads = 0;
  const fetcher = async (url, request) => {
    assert.equal(new URL(url).hostname, 'hub.docker.com');
    assert.equal(request.redirect, 'error', 'credentials cannot follow redirects');
    assert.ok(request.signal instanceof AbortSignal);
    const method = request.method || 'GET';
    calls.push({ url, method, ...request });
    if (options.intercept) {
      const response = await options.intercept(url, request, calls);
      if (response) return response;
    }
    if (method === 'GET') {
      assert.equal(request.headers.Authorization, undefined, 'verification is anonymous');
      assert.equal(request.headers['Cache-Control'], 'no-cache');
      if (patched && afterReads++ < (options.staleReads ?? 0)) return Response.json({ ...publicRepo });
      return Response.json(stored);
    }
    if (method === 'POST') {
      assert.equal(url, 'https://hub.docker.com/v2/auth/token');
      assert.deepEqual(JSON.parse(request.body), { identifier: 'dizys', secret: TOKEN });
      return Response.json(options.session === undefined ? { access_token: JWT } : options.session);
    }
    assert.equal(method, 'PATCH');
    assert.equal(url, 'https://hub.docker.com/v2/repositories/dizys/t3code-docker/');
    assert.equal(request.headers.Authorization, `Bearer ${JWT}`);
    assert.deepEqual(JSON.parse(request.body), body, 'only the two metadata fields are written');
    patched = true;
    stored = { ...stored, ...JSON.parse(request.body) };
    return new Response(null, { status: 204 });
  };
  return { calls, waits, stored: () => stored, driver: { token: TOKEN, fetcher, wait: async (ms) => { waits.push(ms); } } };
}

test('the real README produces a complete, portable Overview with working source image and guide destinations', async () => {
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
  const content = overviewFromReadme(readme, sha);
  assert.equal(content.description, DESCRIPTION);
  assert.ok(Buffer.byteLength(content.description) <= 100);
  assert.ok(Buffer.byteLength(content.full_description) < 25_000);
  assert.ok(content.full_description.includes('## Quick start'));
  assert.ok(content.full_description.includes('dizys/t3code-docker'));
  assert.ok(content.full_description.includes('-v t3-home:/home/t3'));
  assert.ok(content.full_description.includes(`src="${raw}docs/media/banner.png"`));
  assert.ok(content.full_description.includes(`srcset="${raw}docs/media/setup-dark.png"`));
  assert.ok(content.full_description.includes(`<${blob}docs/configuration.md#moving-off-full-and-slim>`));
  assert.ok(content.full_description.includes(`<${blob}compose.yaml>`));
  assert.ok(content.full_description.includes(`href="${blob}LICENSE"`));
  assert.ok(content.full_description.includes('> **Note:**'));
  assert.deepEqual([...content.full_description.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]), [...readme.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]), 'run and Compose examples are unchanged');
  assert.equal(/(?:src|href|srcset)="(?:docs\/|LICENSE)/.test(content.full_description), false);
});

test('relative Markdown links, nested images, titles, reference links and HTML image variants are portable', () => {
  const source = '[guide](docs/a_(v1).md "Read this")\n[![icon](docs/icon.png)](docs/start.md)\n[spaces](<docs/My Guide.md#one>)\n[local](#heading)\n[external](https://example.com/a_(b))\n[ref]: docs/setup.md "Setup"\n[image]: docs/logo.svg\n<img src="docs/light.png"><source srcset="docs/one.png 1x, docs/two.png 2x">';
  const result = overviewFromReadme(source, sha).full_description;
  assert.ok(result.includes(`[guide](<${blob}docs/a_(v1).md> "Read this")`));
  assert.ok(result.includes(`[![icon](<${raw}docs/icon.png>)](<${blob}docs/start.md>)`));
  assert.ok(result.includes(`[spaces](<${blob}docs/My%20Guide.md#one>)`));
  assert.ok(result.includes(`[local](<${blob}README.md#heading>)`));
  assert.ok(result.includes('[external](https://example.com/a_(b))'));
  assert.ok(result.includes(`[ref]: <${blob}docs/setup.md> "Setup"`));
  assert.ok(result.includes(`[image]: <${raw}docs/logo.svg>`));
  assert.ok(result.includes(`srcset="${raw}docs/one.png 1x, ${raw}docs/two.png 2x"`));
  const references = overviewFromReadme('![Photo][shot]\n[shot]: docs/photo\n![Logo]\n[logo]: docs/logo\n[^1]: A footnote, not a URL.', sha).full_description;
  assert.ok(references.includes(`[shot]: <${raw}docs/photo>`));
  assert.ok(references.includes(`[logo]: <${raw}docs/logo>`));
  assert.ok(references.includes('[^1]: A footnote, not a URL.'));
});

test('fenced examples, inline code, absolute links and data images remain intact', () => {
  const samples = ['`[guide](docs/example.md)`', '``[guide](docs/example.md) `literal` ``', '```md\n[guide](docs/example.md)\n> [!NOTE]\n```', '~~~~md\n```\n<img src="docs/example.png">\n~~~~'];
  for (const sample of samples) assert.equal(overviewFromReadme(sample, sha).full_description, sample + '\n');
  const absolute = '<img src="data:image/svg+xml;base64,abc"><a href="mailto:help@example.com">Help</a>\n[remote](//example.com/guide)';
  assert.equal(overviewFromReadme(absolute, sha).full_description, absolute + '\n');
});

test('empty, comment-only, oversized and invalid sources cannot replace an Overview', async () => {
  for (const source of ['', '  \n', '<!-- empty -->', '\0bad', '🐈'.repeat(7000), '[bad](../outside.md)', '[bad](%2e%2e/outside.md)']) assert.throws(() => overviewFromReadme(source, sha));
  assert.throws(() => overviewFromReadme('hello', 'main'), /exact README source commit/);
  const fake = hub();
  for (const invalid of [{ ...body, full_description: '' }, { ...body, full_description: '🐈'.repeat(7000) }, { ...body, description: 'x'.repeat(101) }]) await assert.rejects(syncOverview(invalid, fake.driver));
  assert.equal(fake.calls.length, 0, 'validation happens before any HTTP request');
});

test('dry runs and checks never authenticate or modify missing repository metadata', async () => {
  const fake = hub();
  const plan = await syncOverview(body, { ...fake.driver, token: undefined, dryRun: true });
  assert.equal(plan.matches, false); assert.equal(plan.verified, false); assert.equal(plan.changed, false);
  await assert.rejects(syncOverview(body, { ...fake.driver, check: true }), /empty or out of date/);
  assert.ok(fake.calls.every((c) => c.method === 'GET'));
  assert.equal(fake.stored().full_description, null);
});

test('an empty Overview is populated and publicly verified; a repeated sync is a credential-free no-op', async () => {
  const fake = hub();
  const result = await syncOverview(body, fake.driver);
  assert.equal(result.verified, true); assert.equal(result.changed, true);
  assert.deepEqual(fake.calls.map((c) => c.method), ['GET', 'POST', 'PATCH', 'GET']);
  assert.equal(fake.stored().full_description, body.full_description);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.bytes, Buffer.byteLength(body.full_description));
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(JWT), false);
  const second = await syncOverview(body, { ...fake.driver, token: undefined });
  assert.equal(second.changed, false); assert.equal(second.verified, true);
  assert.equal(fake.calls.at(-1).method, 'GET');
  assert.equal(fake.calls.filter((c) => c.method === 'PATCH').length, 1);
});

test('missing credentials and unexpected/private repositories fail before an update', async () => {
  const missing = hub();
  await assert.rejects(syncOverview(body, { ...missing.driver, token: undefined }), /DOCKERHUB_TOKEN/);
  assert.deepEqual(missing.calls.map((c) => c.method), ['GET']);
  for (const initial of [{ is_private: true }, { namespace: 'other' }, { name: 'other' }]) {
    const fake = hub({ initial });
    await assert.rejects(syncOverview(body, fake.driver), /public dizys\/t3code-docker/);
    assert.deepEqual(fake.calls.map((c) => c.method), ['GET']);
  }
});

test('delayed public reads are retried without submitting duplicate updates', async () => {
  const fake = hub({ staleReads: 2 });
  assert.equal((await syncOverview(body, fake.driver)).verified, true);
  assert.equal(fake.calls.filter((c) => c.method === 'PATCH').length, 1);
  assert.deepEqual(fake.waits, [1000, 2000]);
});

test('a successful PATCH alone never counts as verified publication', async () => {
  const fake = hub({ staleReads: Infinity });
  await assert.rejects(syncOverview(body, fake.driver), /public page does not match/);
  assert.equal(fake.calls.filter((c) => c.method === 'PATCH').length, 1);
  assert.equal(fake.calls.filter((c) => c.method === 'GET').length, 5);
});

test('transient throttling and service errors have bounded idempotent retries', async () => {
  const failures = new Map([['GET', 429], ['POST', 503], ['PATCH', 502]]);
  const fake = hub({ intercept: async (_, request) => {
    const method = request.method || 'GET', status = failures.get(method);
    if (status) { failures.delete(method); return Response.json({ message: 'retry' }, { status }); }
  } });
  assert.equal((await syncOverview(body, fake.driver)).verified, true);
  assert.equal(fake.calls.length, 7);
  assert.deepEqual(fake.waits, [1000, 1000, 1000]);
});

test('authorization errors are actionable, never retried, and never print credential-bearing responses', async () => {
  for (const method of ['POST', 'PATCH']) for (const status of [401, 403]) {
    const fake = hub({ intercept: async (_, request) => request.method === method ? Response.json({ secret: TOKEN, token: JWT }, { status }) : undefined });
    await assert.rejects(syncOverview(body, fake.driver), (error) => {
      assert.match(error.message, /DOCKERHUB_TOKEN.*repository permissions/);
      assert.ok(!error.message.includes(TOKEN) && !error.message.includes(JWT));
      return true;
    });
    assert.equal(fake.calls.filter((c) => c.method === method).length, 1);
    assert.equal(fake.stored().full_description, null);
  }
});

test('network failures are bounded and credential-bearing errors are sanitized', async () => {
  const fake = hub({ intercept: async () => { throw new Error(TOKEN + JWT); } });
  await assert.rejects(syncOverview(body, fake.driver), (error) => {
    assert.match(error.message, /failed or timed out/);
    assert.ok(!error.message.includes(TOKEN) && !error.message.includes(JWT));
    return true;
  });
  assert.equal(fake.calls.length, 3);
  assert.ok(fake.calls.every((c) => c.method === 'GET'));
});

test('malformed authentication responses cannot produce a PATCH', async () => {
  for (const session of [null, {}, { access_token: 'bad\nheader' }]) {
    const fake = hub({ session });
    await assert.rejects(syncOverview(body, fake.driver), /valid metadata access token/);
    assert.equal(fake.calls.some((c) => c.method === 'PATCH'), false);
  }
});

test('malformed public responses fail without authenticating or publishing', async () => {
  const fake = hub({ intercept: async () => new Response('not JSON') });
  await assert.rejects(syncOverview(body, fake.driver), /invalid metadata/);
  assert.deepEqual(fake.calls.map((c) => c.method), ['GET']);
});

test('the workflow repairs metadata on main, releases and daily; metadata-only runs cannot copy images', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/dockerhub.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /- README\.md/);
  assert.match(workflow, /cron: '23 6 \* \* \*'/);
  assert.match(workflow, /types: \[published\]/);
  const imageJob = workflow.split('  publish:\n')[1].split('  overview:\n')[0];
  assert.match(imageJob, /github\.event_name == 'release'.*!inputs\.overview_only/);
  const overviewJob = workflow.split('  overview:\n')[1];
  assert.match(overviewJob, /github\.ref == 'refs\/heads\/main'/);
  assert.match(overviewJob, /ref: main/);
  assert.match(overviewJob, /persist-credentials: false/);
  assert.match(overviewJob, /--dry-run/);
  assert.match(overviewJob, /DOCKERHUB_TOKEN: \$\{\{ secrets\.DOCKERHUB_TOKEN \}\}/);
  assert.equal(overviewJob.includes('publish-dockerhub.mjs'), false);
  assert.equal(workflow.includes('pull_request_target'), false);
});
