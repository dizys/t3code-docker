// Model ids, as a gateway lists them. Pure.
const MAX_MODELS = 2000;
// A gateway chooses these, and it isn't trusted: OpenCode expands `{env:…}` and
// `{file:…}` anywhere in its config, so a model called `{file:~/.ssh/id_rsa}` would
// read that file and send it back as the model's name. No real id has braces.
const MODEL_ID = /^[\x21-\x7a|~]{1,200}$/;

const compare = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

/** Valid ids once each, in a stable order: a reordered list must never look like a change. */
export const cleanModelIds = values => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && MODEL_ID.test(value)))].sort(compare).slice(0, MAX_MODELS);

export const validModelId = value => typeof value === 'string' && MODEL_ID.test(value);

// Listed beside chat models, but a coding turn on one only fails. The name is
// all there is to go on: lists don't say what a model does.
const NOT_CHAT = /(?:^|[^a-z])(?:dall-e|embed(?:ding)?s?|image|imagen|moderation|rerank|sora|speech|transcribe|tts|veo|whisper)(?:[^a-z]|$)/i;
export const canChat = id => !NOT_CHAT.test(id);

/** The ids in a list response: OpenAI's and Anthropic's `data`, or a bare `models` array. */
export function parseModelList(body) {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : null;
  if (!rows) return null;
  return cleanModelIds(rows.map(row => typeof row === 'string' ? row : row?.id ?? row?.name ?? row?.slug));
}

const versionOf = id => {
  // Dates such as 20250929 say which build, not which version.
  const parts = String(id).split(/[^0-9]+/).filter(part => part && part.length < 8).map(Number);
  return parts.length ? parts : [0];
};
const newerFirst = (a, b) => {
  const left = versionOf(a), right = versionOf(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference) return difference;
  }
  return a.length - b.length || compare(a, b);
};

/** The newest listed id in a family such as `sonnet`, or null. */
export const newestIn = (ids, family) => [...ids].filter(id => new RegExp(`(?:^|[^a-z])${family}(?:[^a-z]|$)`, 'i').test(id)).sort(newerFirst)[0] ?? null;
