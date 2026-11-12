import { inferEngine } from './codex.js';
import { modelSlug } from './commands.js';

/** Harness label is separate from the model; infer cc/cx unless explicitly selected. */
export function handName(model: string, friendly: string, harness = inferEngine(model) === 'codex' ? 'cx' : 'cc') {
  if (!/^[a-z0-9-]+$/.test(harness) || !/^[A-Za-z0-9-]{1,24}$/.test(friendly)) throw new Error('bad hand name');
  const label = `${harness}-${modelSlug(model)}`;
  const personaName = `[${label}] ${friendly}`;
  const shortName = `${harness}-${friendly.toLowerCase()}`;
  if (personaName.length > 49 || shortName.length > 40 || `${shortName}-bot`.length > 44) throw new Error('hand name too long');
  return { personaName, shortName };
}

/** Display name only: never derive persistent paths from a changed model. */
export function modelDisplayName(entry: { personaName: string; suffix: string; harness?: string; engine?: string }, model: string): string {
  const bracket = entry.personaName.match(/^\[[^\]]+\] (.+)$/);
  if (bracket) return handName(model, bracket[1], entry.harness ?? (entry.engine === 'codex' ? 'cx' : 'cc')).personaName;
  if (entry.personaName.startsWith('Claude-Code-')) return `Claude-Code-${modelSlug(model)}-${entry.suffix}`;
  return handName(model, entry.suffix, entry.engine === 'codex' ? 'cx' : 'cc').personaName;
}
