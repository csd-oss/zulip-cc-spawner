import assert from 'node:assert/strict';
import type { Tmux } from '../src/tmux.js';
import { claude323Capture, CLAUDE_323_CONFIRM, CLAUDE_323_CHANGED } from './model-fixtures.js';

/** Stateful replay: captures don't advance time; only the recorded keys change
 * the pane. Wrong arrows (including wrap at either endpoint) fail immediately. */
export function claude323Replay(keys: string[][] = [], text: string[] = []) {
  const names = ['01-initial-cursor4', '02-cursor3', '03-cursor2', '04-cursor1',
    '12-down-cursor2', '13-down-cursor3', '14-down-cursor4', '15-down-cursor5', '30-after-escape'];
  const transitions = ['Up', 'Up', 'Up', 'Down', 'Down', 'Down', 'Down', 'Escape'];
  let index = -1;
  let command = '';
  let confirming = false;
  let changed = false;
  const tmux = {
    async capturePane() {
      if (changed) return CLAUDE_323_CHANGED;
      if (confirming) return CLAUDE_323_CONFIRM;
      return index < 0 ? '? for shortcuts' : claude323Capture(names[index]);
    },
    async sendText(_s: string, value: string) {
      text.push(value);
      assert.ok(value === '/model' || value === '/model claude-fable-5-2');
      command = value;
    },
    async sendKeys(_s: string, ...values: string[]) {
      keys.push(values);
      assert.equal(values.length, 1);
      const key = values[0];
      if (key === 'Enter') {
        if (command === '/model') { assert.equal(index, -1); index = 0; }
        else { assert.equal(index, 8); confirming = true; }
      } else if (confirming) {
        assert.equal(key, '1'); confirming = false; changed = true;
      } else {
        assert.equal(key, transitions[index], 'must not wrap or skip a captured transition');
        index++;
      }
    },
  } as unknown as Tmux;
  return { tmux, keys, text, get index() { return index; } };
}
