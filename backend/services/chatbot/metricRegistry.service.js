/**
 * Metric Registry Service
 *
 * Thin wrapper over the shared case QA catalog.
 * All metric definitions, aliases, and labels are sourced from the catalog.
 */

import {
  getCaseQaCatalog,
  getCaseQaCatalogEntry,
  normalizeCaseQaModule,
  normalizeCaseQaText,
  resolveCaseQaCatalogEntry,
  getMetricLabel,
  buildMetricLabelMap,
  getCaseQaCatalogKeysByModule,
  getCaseQaCatalogEntriesByModule
} from '../../../shared/chatbot/caseQaCatalog.js';

const readPath = (source, path) => String(path || '')
  .split('.')
  .filter(Boolean)
  .reduce((acc, segment) => (acc == null ? null : acc[segment]), source);

const hasMeaningfulValue = (value) => {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
};

// Re-export catalog accessors as the metric registry API
export const getMetricRegistry = () => getCaseQaCatalog();

const relaxRankedMetricText = (message = '') =>
  String(message || '')
    .replace(/\btop\s+\d{1,3}\s+/gi, 'top ')
    .replace(/\bmax\s+\d{1,3}\s+/gi, 'max ');

export const resolveMetricDefinition = ({ message = '', module = null, view = null } = {}) => {
  const direct = resolveCaseQaCatalogEntry({ message, module, view });
  if (direct) return direct;

  const relaxedMessage = relaxRankedMetricText(message);
  if (relaxedMessage !== String(message || '')) {
    return resolveCaseQaCatalogEntry({ message: relaxedMessage, module, view });
  }

  return null;
};

export const detectRequestedModule = (message = '') => {
  const text = normalizeCaseQaText(message);
  if (!text) return null;
  return normalizeCaseQaModule(message);
};

export const isExplicitSummaryRequest = (message = '') => {
  const text = normalizeCaseQaText(message);
  return /\b(summary|summarize|overview|analysis|advanced analysis|what does this show|key findings|highlights)\b/.test(text);
};

export const getMetricDefinition = (metricKey) => getCaseQaCatalogEntry(metricKey);

export { getMetricLabel, buildMetricLabelMap, getCaseQaCatalogKeysByModule, getCaseQaCatalogEntriesByModule };

export const buildMetricIndex = (caseMemory = {}) => {
  const modules = caseMemory?.modules || {};
  const index = {};

  for (const definition of getCaseQaCatalog()) {
    const matches = [];
    for (const moduleKey of Object.keys(modules)) {
      const moduleMemory = modules[moduleKey];
      if (!moduleMemory) continue;

      const candidatePaths = (definition.factKeys || [definition.key]).flatMap((factKey) => ([
        `overview.facts.${factKey}`,
        `advanced.facts.${factKey}`,
        `records.facts.${factKey}`,
        `charts.facts.${factKey}`,
        `map.facts.${factKey}`,
        `location_roaming.facts.${factKey}`,
        `network_graph.facts.${factKey}`,
        `party_graph.facts.${factKey}`,
        `search.facts.${factKey}`
      ]));

      const matchedPath = candidatePaths.find((path) => hasMeaningfulValue(readPath(moduleMemory, path)));
      if (matchedPath) {
        matches.push({
          module: moduleKey,
          section: matchedPath.replace(/\.facts\./, '.')
        });
      }
    }

    if (matches.length > 0) {
      index[definition.key] = matches;
    }
  }

  return index;
};

export const normalizeMetricModule = normalizeCaseQaModule;
