import { unwrapUserMessage } from './text.utils.js';
import { detectPreferredLanguage } from './language.service.js';

const extractTopN = (text) => {
  const match = text.match(/\btop\s+(\d{1,3})\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(100, n));
};

const extractTaggedCaseRef = (text) => {
  const quoted = text.match(/@"([^"]{2,})"/);
  if (quoted?.[1]) return quoted[1].trim();

  const simple = text.match(/(?:^|\s)@([a-z0-9][a-z0-9_\-\/]{1,63})\b/i);
  return simple?.[1] || null;
};

export const extractTaggedCaseRefs = (text) => {
  const raw = String(text || '');
  const refs = [];
  const seen = new Set();

  const quotedPattern = /@"([^"]{2,})"/gi;
  let quotedMatch;
  while ((quotedMatch = quotedPattern.exec(raw)) !== null) {
    const value = String(quotedMatch[1] || '').trim();
    const key = value.toLowerCase();
    if (value && !seen.has(key)) {
      refs.push(value);
      seen.add(key);
    }
  }

  const simplePattern = /(?:^|\s)@([a-z0-9][a-z0-9_\-\/]{1,63})\b/gi;
  let simpleMatch;
  while ((simpleMatch = simplePattern.exec(raw)) !== null) {
    const value = String(simpleMatch[1] || '').trim();
    const key = value.toLowerCase();
    if (value && !seen.has(key)) {
      refs.push(value);
      seen.add(key);
    }
  }

  return refs;
};

export const extractMessageEntities = (message, context = {}) => {
  const raw = String(message || '');
  const text = unwrapUserMessage(raw);
  const taggedCaseRefs = extractTaggedCaseRefs(text);

  const fir = text.match(/\bfir\s*[-:#]?\s*([a-z0-9\-\/]+)\b/i)?.[1] || null;
  const caseIdExplicit =
    text.match(/\bcase\s*id\s*[-:#]?\s*(\d+)\b/i)?.[1] ||
    text.match(/\bcase\s*[-:#]?\s*(\d+)\b/i)?.[1] ||
    context.caseId ||
    null;
  const taggedCaseRef = taggedCaseRefs[0] || extractTaggedCaseRef(text) || context.caseName || null;
  const topN = extractTopN(text);
  const days = Number(text.match(/\b(last|past)\s+(\d{1,3})\s+days?\b/i)?.[2] || 0) || null;

  let module = null;
  const lower = text.toLowerCase();
  if (lower.includes('cdr')) module = 'cdr';
  else if (lower.includes('ipdr')) module = 'ipdr';
  else if (lower.includes('ild')) module = 'ild';
  else if (lower.includes('sdr')) module = 'sdr';
  else if (lower.includes('tower')) module = 'tower';

  return {
    fir,
    caseId: caseIdExplicit,
    caseName: context.caseName || null,
    taggedCaseRef,
    taggedCaseRefs,
    tagCount: taggedCaseRefs.length,
    topN,
    days,
    module,
    language: detectPreferredLanguage(text)
  };
};

export const mergeSessionEntities = (sessionState = {}, newEntities = {}) => {
  return {
    fir: newEntities.fir || sessionState.fir || null,
    caseId: newEntities.caseId || sessionState.caseId || null,
    caseName: newEntities.caseName || sessionState.caseName || null,
    taggedCaseRef: newEntities.taggedCaseRef || sessionState.taggedCaseRef || null,
    taggedCaseRefs: Array.isArray(newEntities.taggedCaseRefs) && newEntities.taggedCaseRefs.length > 0
      ? newEntities.taggedCaseRefs
      : (Array.isArray(sessionState.taggedCaseRefs) ? sessionState.taggedCaseRefs : []),
    tagCount: Number(newEntities.tagCount) || Number(sessionState.tagCount) || 0,
    module: newEntities.module || sessionState.module || null,
    topN: newEntities.topN || sessionState.topN || null,
    days: newEntities.days || sessionState.days || null,
    language: newEntities.language || sessionState.language || 'en'
  };
};
