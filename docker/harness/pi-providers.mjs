// Pi's providers, as data: the ones that take a plain API key, the variables
// Pi reads each credential from, and the subscription-only ones. Shared by
// the catalogue (which credentials count) and pi-auth.mjs (the key sheet).
// Ids and variables follow env-api-keys in @earendil-works/pi-ai.

/**
 * Providers that sign in with a plain API key. Providers that also need a
 * base URL, account id or cloud credentials (Azure, Bedrock, Vertex,
 * Cloudflare) are left to Pi's own /login.
 */
export const PI_KEY_PROVIDERS = Object.freeze([
  ['anthropic', 'Anthropic', ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']],
  ['openai', 'OpenAI', ['OPENAI_API_KEY']],
  ['google', 'Google Gemini', ['GEMINI_API_KEY']],
  ['openrouter', 'OpenRouter', ['OPENROUTER_API_KEY']],
  ['deepseek', 'DeepSeek', ['DEEPSEEK_API_KEY']],
  ['xai', 'xAI', ['XAI_API_KEY']],
  ['mistral', 'Mistral', ['MISTRAL_API_KEY']],
  ['groq', 'Groq', ['GROQ_API_KEY']],
  ['cerebras', 'Cerebras', ['CEREBRAS_API_KEY']],
  ['fireworks', 'Fireworks', ['FIREWORKS_API_KEY']],
  ['together', 'Together AI', ['TOGETHER_API_KEY']],
  ['huggingface', 'Hugging Face', ['HF_TOKEN']],
  ['vercel-ai-gateway', 'Vercel AI Gateway', ['AI_GATEWAY_API_KEY']],
  ['opencode', 'OpenCode Zen', ['OPENCODE_API_KEY']],
  ['opencode-go', 'OpenCode Go', ['OPENCODE_API_KEY']],
  ['zai', 'Z.AI Coding Plan', ['ZAI_API_KEY']],
  ['zai-coding-cn', 'Z.AI Coding Plan (China)', ['ZAI_CODING_CN_API_KEY']],
  ['kimi-coding', 'Kimi For Coding', ['KIMI_API_KEY']],
  ['moonshotai', 'Moonshot AI', ['MOONSHOT_API_KEY']],
  ['moonshotai-cn', 'Moonshot AI (China)', ['MOONSHOT_API_KEY']],
  ['minimax', 'MiniMax', ['MINIMAX_API_KEY']],
  ['minimax-cn', 'MiniMax (China)', ['MINIMAX_CN_API_KEY']],
  ['nvidia', 'NVIDIA NIM', ['NVIDIA_API_KEY']],
  ['baseten', 'Baseten', ['BASETEN_API_KEY']],
  ['meta', 'Meta', ['META_API_KEY']],
  ['qwen-token-plan', 'Qwen Token Plan', ['QWEN_TOKEN_PLAN_API_KEY']],
  ['qwen-token-plan-individual', 'Qwen Token Plan (Individual)', ['QWEN_TOKEN_PLAN_API_KEY']],
  ['qwen-token-plan-cn', 'Qwen Token Plan (China)', ['QWEN_TOKEN_PLAN_CN_API_KEY']],
  ['xiaomi', 'Xiaomi MiMo', ['XIAOMI_API_KEY']],
  ['xiaomi-token-plan-cn', 'Xiaomi MiMo Token Plan (China)', ['XIAOMI_TOKEN_PLAN_CN_API_KEY']],
  ['xiaomi-token-plan-ams', 'Xiaomi MiMo Token Plan (Amsterdam)', ['XIAOMI_TOKEN_PLAN_AMS_API_KEY']],
  ['xiaomi-token-plan-sgp', 'Xiaomi MiMo Token Plan (Singapore)', ['XIAOMI_TOKEN_PLAN_SGP_API_KEY']],
  ['radius', 'Radius', ['RADIUS_API_KEY']],
  ['typesafe', 'TypeSafe', ['TYPESAFE_API_KEY']],
  ['ant-ling', 'Ant Ling', ['ANT_LING_API_KEY']],
].map(([id, name, env]) => Object.freeze({ id, name, env: Object.freeze(env) })));

// Providers whose sign-in is a subscription made with /login in Pi. The key
// list names most of them already; these are the ones it does not.
export const PI_SUBSCRIPTION_ONLY = Object.freeze([
  Object.freeze({ id: 'github-copilot', name: 'GitHub Copilot', env: Object.freeze(['COPILOT_GITHUB_TOKEN']) }),
  Object.freeze({ id: 'openai-codex', name: 'ChatGPT (legacy sign-in)', env: Object.freeze([]) }),
]);

/** Every variable Pi reads a provider credential from. */
export const PI_CREDENTIAL_ENV = Object.freeze([...new Set([...PI_KEY_PROVIDERS, ...PI_SUBSCRIPTION_ONLY].flatMap((provider) => provider.env))]);
