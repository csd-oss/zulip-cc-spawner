import { readFileSync } from 'node:fs';
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

// Verbatim 80x24 Claude Code 2.1.323 pane from TASK-M0KJ9.
export const CLAUDE_323_MIDDLE = `   Select model
   ↑ 2. Opus                   Opus 5.5 · Best for everyday, complex tasks ·
                               $4/$20 per Mtok
     3. Fable                  Fable 5.2 · Most capable … · $8/$40 per Mtok
   ❯ 4. Sonnet ✔               Sonnet 5.5 · Efficient for routine tasks ·
      … +1 model
   ○ Low effort ←/→ to adjust
   Enter to set as default · s to use this session only · Esc to cancel`;
// Verbatim live 80x24 captures, Claude Code 2.1.323, 2026-11-14.
// SHA256SUMS and provenance accompany the files; no cursor rewriting.
export const claude323Capture = (name: string) =>
  readFileSync(new URL(`./fixtures/claude-2.1.323/${name}.txt`, import.meta.url), 'utf8');
export const CLAUDE_323_TOP = claude323Capture('04-cursor1');
export const CLAUDE_323_BOTTOM = claude323Capture('15-down-cursor5');
// Verbatim reported confirmation choices and success text (not a full capture).
export const CLAUDE_323_CONFIRM = `Switch model?
❯ 1. Yes, switch to Fable 5.2
  2. No, go back`;
export const CLAUDE_323_CHANGED = 'Set model to Fable 5.2 and saved as your default for new sessions';

export const CLAUDE_323_SCAN = [
  '01-initial-cursor4', '02-cursor3', '03-cursor2', '04-cursor1',
  '12-down-cursor2', '13-down-cursor3', '14-down-cursor4', '15-down-cursor5',
].map(claude323Capture);
