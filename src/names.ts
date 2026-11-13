import { inferEngine } from './codex.js';
import { modelSlug } from './commands.js';

/** Effort is cosmetic: strip it when comparing hand identities, including legacy names. */
export function handIdentityName(name: string): string {
  return name.toLowerCase().replace(/^(\[[^\] /]+)\/[^\] ]+(\] )/, '$1$2');
}

export function effortAbbreviation(effort?: string): string {
  if (!effort || effort === 'default') return 'd';
  const abbreviations: Record<string, string> = {
    minimal: 'min', low: 'low', medium: 'med', high: 'h', xhigh: 'xh',
    max: 'max', ultra: 'u', ultracode: 'u',
  };
  const abbreviation = abbreviations[effort];
  if (!abbreviation) throw new Error('bad hand effort');
  return abbreviation;
}

/** Harness label is separate from the model; infer cc/cx unless explicitly selected. */
export function handName(model: string, friendly: string, harness = inferEngine(model) === 'codex' ? 'cx' : 'cc', effort?: string) {
  if (!/^[a-z0-9-]+$/.test(harness) || !/^[A-Za-z0-9-]{1,24}$/.test(friendly)) throw new Error('bad hand name');
  const label = `${harness}-${modelSlug(model)}`;
  const personaName = `[${label}/${effortAbbreviation(effort)}] ${friendly}`;
  const shortName = `${harness}-${friendly.toLowerCase()}`;
  if (personaName.length > 49 || shortName.length > 40 || `${shortName}-bot`.length > 44) throw new Error('hand name too long');
  return { personaName, shortName };
}

/** Display name only: never derive persistent paths from a changed model. */
export function modelDisplayName(entry: { personaName: string; suffix: string; friendlyName?: string; harness?: string; engine?: string; effort?: string }, model: string): string {
  if (entry.friendlyName !== undefined) return handName(model, entry.friendlyName, entry.harness ?? (entry.engine === 'codex' ? 'cx' : 'cc'), entry.effort).personaName;
  const bracket = entry.personaName.match(/^\[[^\]]+\] (.+)$/);
  if (bracket) return handName(model, bracket[1], entry.harness ?? (entry.engine === 'codex' ? 'cx' : 'cc'), entry.effort).personaName;
  return handName(model, entry.suffix, entry.harness ?? (entry.engine === 'codex' ? 'cx' : 'cc'), entry.effort).personaName;
}
