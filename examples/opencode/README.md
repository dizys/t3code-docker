# DeepSeek through OpenCode

T3 Code has no DeepSeek driver — its providers are Claude, Codex, Cursor, Grok,
OpenCode and Antigravity. OpenCode is the way in: it speaks any
OpenAI-compatible endpoint, and T3 Code drives OpenCode.

## Install

```bash
docker compose exec -u t3 t3code sh -c \
  'mkdir -p ~/.config/opencode &&
   cp /opt/examples/opencode/opencode.deepseek.json ~/.config/opencode/opencode.json'
```

or, if you already have an `opencode.json`, merge the `provider.deepseek` block
into it. Then set the key and restart:

```bash
# in .env
DEEPSEEK_API_KEY=sk-...
```

```bash
docker compose up -d
```

In T3 Code, enable the OpenCode provider under **Settings → Providers**, then
pick a DeepSeek model in the composer. `opencode` itself lists what it resolved:

```bash
docker compose exec -u t3 t3code opencode models | grep -i deepseek
```

## Model IDs move

The IDs above are DeepSeek's stable aliases. DeepSeek ships new generations
faster than this repo updates — check
<https://api-docs.deepseek.com/quick_start/pricing> for what your key can reach
today and add entries under `models` accordingly. An unknown ID fails at request
time, not at startup, so a wrong name looks like a broken thread rather than a
config error.

## The other route

T3 Code lets each provider *instance* carry its own environment variables. A
second Claude or Codex instance pointed at a DeepSeek-compatible base URL works
without touching OpenCode at all — set the instance's env in
**Settings → Providers → (instance) → Environment variables** rather than in
**Launch arguments**.
