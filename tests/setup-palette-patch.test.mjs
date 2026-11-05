import assert from 'node:assert/strict';
import test from 'node:test';
import { clientFile, clientSource, files, patchSetupPalette } from '../docker/runtime/patches/setup-palette.mjs';
import { patches, createdFiles } from '../docker/runtime/patches/index.mjs';

// The bounded anchors shared by the verified Stable 0.1.7 and Nightly
// 0.1.7-nightly.20261103.4119 sources. Behavior is tested in the real client.
const original = [
  'import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";',
  'function OpenCommandPaletteDialog() {',
  '  const navigate = useNavigate();',
  '  const isActionsOnly = deferredQuery.startsWith(">");',
  '  const actionItems = [];',
  '  const rootGroups = buildRootGroups({ actionItems, recentThreadItems });',
  '  return rootGroups;',
  '}',
].join('\n');

test('Setup joins native actions before ranking without replacing native result rendering', () => {
  const input = { [files[0]]: original }, before = structuredClone(input);
  const result = patchSetupPalette(input);
  assert.deepEqual(input, before);
  assert.equal(result[clientFile], clientSource);
  assert.match(result[files[0]], /useSetupPaletteActions\(deferredQuery/);
  assert.match(result[files[0]], /await navigate\(\{ to: "\/settings" \}\)/);
  assert(result[files[0]].indexOf('actionItems.push(...setupActions)') < result[files[0]].indexOf('buildRootGroups('));
  assert.equal(result[files[0]].split('const rootGroups = buildRootGroups').length, 2);
  const registered = patches.find(patch => patch.name === 'setup-palette');
  assert(registered.assets.length === 1, 'Provider source must enter the immutable patch fingerprint');
  assert(registered.creates.includes(clientFile) && createdFiles.includes(clientFile));
});

test('each changed or ambiguous native source anchor fails without partial input edits', () => {
  const anchors = original.split('\n').filter(line => /useAvailableSettingsSearchItems|isActionsOnly|rootGroups =/.test(line));
  for (const anchor of anchors) for (const replacement of ['', anchor + '\n' + anchor]) {
    const input = { [files[0]]: original.replace(anchor, replacement) }, before = structuredClone(input);
    assert.throws(() => patchSetupPalette(input), /no longer matches/);
    assert.deepEqual(input, before);
  }
  assert.throws(() => patchSetupPalette({}), /no longer matches/);
  assert.throws(() => patchSetupPalette(patchSetupPalette({ [files[0]]: original })), /already exists/);
  assert.throws(() => patchSetupPalette({ [files[0]]: original, [clientFile]: 'upstream owns this' }), /already exists/);
});
