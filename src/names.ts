import { inferEngine } from './codex.js';
import { modelSlug } from './commands.js';

/** Harness label is separate from the model; infer cc/cx unless explicitly selected. */
export function handName(model: string, friendly: string, harness = inferEngine(model) === 'codex' ? 'cx' : 'cc') {
  if (!/^[a-z0-9-]+$/.test(harness) || !/^[A-Za-z0-9-]{1,24}$/.test(friendly)) throw new Error('bad hand name');
  const label = `${harness}-${modelSlug(model)}`;
  const personaName = `[${label}] ${friendly}`;
  const shortName = `${label}-${friendly.toLowerCase()}`;
  if (personaName.length > 49 || shortName.length > 40 || `${shortName}-bot`.length > 44) throw new Error('hand name too long');
  return { personaName, shortName };
}
