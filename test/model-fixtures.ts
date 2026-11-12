// Real panes supplied in TASK-GJ15G, captured 2026-11-12.
export const CLAUDE_CONFIRM = `   Switch model?
   Your next response will be slower and use more tokens
   This conversation is cached for the current model. Switching to Opus 5.5 means the full history gets re-read on your next message.
   ❯ 1. Yes, switch to Opus 5.5
     2. No, go back`;
export const CLAUDE_CHANGED = '⎿  Set model to Opus 5.5 and saved as your default for new sessions';
export const CODEX_MODELS = `  Select Model and Effort
› 1. GPT-6.1-Sol (current)  Latest workhorse model for coding and everyday work.
  2. GPT-6-Astra            Frontier intelligence for the most demanding work.
  3. GPT-6-Sol              Previous generation workhorse model.
  4. GPT-6-Luna             Fast and affordable model for easier tasks.
  5. GPT-5.6-Sol            Older generation workhorse model.
  6. GPT-6.1 Terra          GPT-6.1 Terra Codex model.
  7. GPT-5.6-Terra          Older balanced model for straightforward work.
  8. GPT-5.6-Luna           Older fast and efficient model.
↓
  enter select · esc back`;
export const CODEX_REASONING = `  Select Reasoning Level for GPT-6.1 Terra
› 1. Low (default)    Fast responses with lighter reasoning
  2. Medium           Balances speed and reasoning depth for everyday tasks
  3. High             Greater reasoning depth for complex problems
  4. Extra high       Extra high reasoning depth for complex problems
  5. More reasoning…  Max and Ultra consume usage limits faster
  enter default · s session · esc back`;
export const CODEX_CHANGED = '• Model changed to gpt-6.1-terra medium for this session only';
