import type { BotEntry, Registry } from './registry.js';

/**
 * One physical line, with registry text unable to introduce Markdown or bridge
 * tokens. Zulip's server renderer has no backslash-escape pattern, so `\*`
 * would show its backslash. Numeric character references do render (Zulip's
 * entity pattern, and its serializer keeps them even in link labels) and
 * contain no delimiter, so they neutralize table pipes, code spans, emphasis,
 * `~~`, `$$` KaTeX, mentions, stream links, `<time:>`, emoji and URLs.
 */
const LIST_SIGNIFICANT = /[\\`*_{}\[\]()<>#!|~$&:@]/g;
export function listText(value: string): string {
  return value.replace(/[\s\p{Cc}]+/gu, ' ').replace(LIST_SIGNIFICANT, c => `&#${c.charCodeAt(0)};`);
}

/** Generated command targets are `[A-Za-z0-9%:-]`; anything else is shown as text. */
export function listCode(value: string): string {
  return /^[A-Za-z0-9%:-]+$/.test(value) ? `\`${value}\`` : listText(value);
}

// Zulip's hash components use dot-hex escaping, including for literal dots.
const hashComponent = (value: string) => encodeURIComponent(value)
  .replace(/\./g, '%2E').replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  .replace(/%/g, '.');

export function listHome(e: Pick<BotEntry, 'streamId' | 'streamName' | 'topic'>): string {
  const stream = e.streamName;
  const topic = e.topic;
  // Native Zulip links are the most compact form, but their delimiters cannot
  // safely represent every topic. Use an explicit narrow for those names.
  // Zulip matches TeX (`$$`) and `@**` mentions before stream links, and a
  // trailing `@123` would make it a message link; `&` would decode entities.
  const nativeSafe = (s: string) => !/[|`*_>\[\]\\$&@\p{Cc}\u2028\u2029]/u.test(s);
  if (stream && nativeSafe(stream) && (!topic || nativeSafe(topic))) {
    return topic ? `#**${stream}>${topic}**` : `#**${stream}**`;
  }
  const label = listText(`#${stream || 'unknown stream'}${topic ? ` > ${topic}` : ''}`);
  if (Number.isSafeInteger(e.streamId) && e.streamId > 0) {
    return `[${label}](#narrow/stream/${e.streamId}${topic ? `/topic/${hashComponent(topic)}` : ''})`;
  }
  return stream || topic ? label : 'home unknown';
}

export function relativeActivity(timestamp: string | undefined, now = Date.now()): string {
  const time = timestamp ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(time)) return 'activity unknown';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

/** Relative first; past the first hour the absolute UTC minute follows. */
export function listActivity(timestamp: string | undefined, now = Date.now()): string {
  const relative = relativeActivity(timestamp, now);
  const time = timestamp ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(time) || now - time < 3600_000) return relative;
  return `${relative} (${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC)`;
}

export function listIdentity(e: BotEntry, registry: Registry): string {
  const name = e.friendlyName || e.suffix || e.personaName || e.tmuxSession;
  // Check all hands: filters and aliases can hide collisions from the list.
  const uniqueTarget = registry.commandTarget(e);
  const target = uniqueTarget === name ? '' : ` (${listCode(uniqueTarget)})`;
  return `**${listText(name)}**${target}`;
}

/** Blank lines on both sides are required by Zulip's table renderer. */
export function listTable(stopped: boolean, rows: string[][]): string {
  const columns = ['Hand', 'Model', 'Home', ...(stopped ? ['Size'] : []), 'Activity', 'Creator'];
  return `\n| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n` +
    rows.map(row => `| ${row.join(' | ')} |`).join('\n') + '\n\n';
}
