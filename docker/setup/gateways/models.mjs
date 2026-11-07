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

const rowsOf = body => Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : null;
const rowId = row => typeof row === 'string' ? row : row?.id ?? row?.name ?? row?.slug;

/** The ids in a list response: OpenAI's and Anthropic's `data`, or a bare `models` array. */
export function parseModelList(body) {
  const rows = rowsOf(body);
  if (!rows) return null;
  return cleanModelIds(rows.map(rowId));
}

// What a gateway says a model can do with reasoning. There is no standard yet:
// OpenRouter puts `supported_efforts` under `reasoning`, an OpenCode-shaped list
// puts `effort` under `capabilities.reasoning`, and some gateways only name the
// request parameters they accept. All of it is untrusted, like the ids: an effort
// name goes into a config file OpenCode expands, so only known levels survive.
const EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const MAX_BUDGET = 10_000_000;
const effortOf = value => typeof value === 'string' ? EFFORTS.find(level => level === value.trim().toLowerCase()) ?? null : null;
const cleanBudget = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const bound = number => Number.isInteger(number) && number >= 0 && number <= MAX_BUDGET ? number : null;
  const min = bound(value.min), max = bound(value.max);
  if (max === null) return null;
  if (min === null || min >= max) return max > 0 ? { max } : null;
  return { min, max };
};

/** One listed model's reasoning, in OpenCode's shape, or null when it says nothing usable. */
const reasoningOf = row => {
  const detail = row?.capabilities?.reasoning && typeof row.capabilities.reasoning === 'object' && !Array.isArray(row.capabilities.reasoning) ? row.capabilities.reasoning
    : row?.reasoning && typeof row.reasoning === 'object' && !Array.isArray(row.reasoning) ? row.reasoning : null;
  const parameters = Array.isArray(row?.supported_parameters) ? row.supported_parameters : [];
  const takesEffort = parameters.includes('reasoning_effort') || parameters.includes('reasoning');
  const listed = [...(Array.isArray(detail?.supported_efforts) ? detail.supported_efforts : []), ...(Array.isArray(detail?.effort) ? detail.effort : []),
    ...(Array.isArray(detail?.levels) ? detail.levels : []), ...(Array.isArray(row?.supported_reasoning_efforts) ? row.supported_reasoning_efforts : []),
    ...(Array.isArray(row?.supported_reasoning_levels) ? row.supported_reasoning_levels.map(level => level?.effort) : [])];
  const efforts = EFFORTS.filter(level => listed.some(value => effortOf(value) === level));
  const budget = cleanBudget(detail?.budget);
  const supported = typeof detail?.supported === 'boolean' ? detail.supported
    : typeof row?.reasoning === 'boolean' ? row.reasoning
    : efforts.length || budget || detail?.toggle === true || detail?.mandatory === true || takesEffort ? true : null;
  if (supported === null) return null;
  if (!supported) return { supported: false };
  const reasoning = { supported: true };
  if (typeof detail?.toggle === 'boolean') reasoning.toggle = detail.toggle;
  if (efforts.length) reasoning.effort = efforts;
  if (budget) reasoning.budget = budget;
  return reasoning;
};

/** A stored or listed reasoning value, cleaned as if just read: saved data is no more trusted. */
export const cleanReasoning = value => reasoningOf({ reasoning: value });

/** The major in a harness row's version, or null when it isn't there. The config spelling follows this, not the version string's shape. */
export const harnessMajor = value => {
  const match = /^v?(\d+)\./.exec(String(value?.version ?? value?.installedVersion ?? value?.recordedVersion ?? '').trim());
  return match ? Number(match[1]) : null;
};

/** The reasoning facts a list response carries, by model id. Absence means unknown, never a guess. */
export function parseModelCapabilities(body) {
  const rows = rowsOf(body);
  if (!rows) return null;
  const found = {};
  for (const row of rows) {
    const id = rowId(row);
    if (!validModelId(id) || id in found) continue;
    const reasoning = reasoningOf(row);
    if (reasoning) found[id] = reasoning;
  }
  return found;
}

/** Capabilities kept for a set of ids, in list order, cleaned as if just read. */
export const cleanCapabilities = (ids, capabilities) => {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return {};
  return Object.fromEntries(cleanModelIds(ids).flatMap(id => {
    const reasoning = cleanReasoning(capabilities[id]);
    return reasoning ? [[id, reasoning]] : [];
  }));
};

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
