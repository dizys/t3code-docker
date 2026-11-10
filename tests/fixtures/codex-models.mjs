// Trusted native metadata, independent of the gateway's advertised facts.
export const nativeModels = [{
  slug: 'gpt-6-astra', display_name: 'Native Codex', description: 'Native model', priority: 0,
  supported_reasoning_levels: [{ effort: 'medium', description: 'Native effort' }], default_reasoning_level: 'medium',
  shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, support_verbosity: true,
  truncation_policy: { mode: 'bytes', limit: 10000 }, experimental_supported_tools: ['native-tool'],
  base_instructions: 'Full native coding instructions from the installed CLI.',
  model_messages: { instructions_template: 'Full native coding instructions from the installed CLI.', shell: { tool: 'native' } },
  context_window: 272000, max_context_window: 1000000, auto_compact_token_limit: 240000,
}];
