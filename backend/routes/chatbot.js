import express from 'express';
import pool from '../config/database.js';
import { optionalAuth } from '../middleware/auth.js';
import { CHATBOT_MAX_MESSAGE_LENGTH, OLLAMA_MODEL } from '../services/chatbot/config.js';
import {
  executeReadOnlyQuery,
  extractSqlFromMessage,
  extractFirstSqlCodeBlock,
  formatDbResultAsMarkdown,
  isSqlCommand,
  validateReadOnlySql,
  getDbQueryCacheStats
} from '../services/chatbot/dbQuery.service.js';
import {
  buildGreetingResponse,
  buildOpenCdrFirGuidanceResponse,
  buildSqlGuidanceResponse,
  detectFirRequest,
  isSimpleGreeting,
  looksLikeDirectDbDataRequest,
  looksLikeOpenCdrFirRequest
} from '../services/chatbot/intents.js';
import {
  buildFirSummaryMarkdown,
  buildMissingCaseResponse,
  fetchCaseSummary,
  findCaseCandidates
} from '../services/chatbot/firSummary.service.js';
import {
  buildCaseKnowledgeContract,
  buildCaseCitationBlock,
  buildCaseContextPrompt,
  fetchCaseKnowledge,
  getCaseModuleSummary,
  resolveCaseReference,
  searchCasesForChat
} from '../services/chatbot/caseContext.service.js';
import { extractMessageEntities, extractTaggedCaseRefs, mergeSessionEntities } from '../services/chatbot/entity.service.js';
import {
  buildWorkspaceContextPrompt,
  lookupWorkspaceAnswer,
  mergeWorkspaceContext,
  normalizeWorkspaceContext
} from '../services/chatbot/workspaceMemory.service.js';
import { buildClarificationAnswerPayload } from '../services/chatbot/groundedAnswer.service.js';
import { resolveMetricDefinition } from '../services/chatbot/metricRegistry.service.js';
import { classifyGroundability, isGroundableCaseQuestionText } from '../../shared/chatbot/caseQaCatalog.js';
import { applyFollowUpResolution, generatePlan, buildSessionStatePatch } from '../services/chatbot/planner.service.js';
import { tryHandleNaturalLanguageDbRequest } from '../services/chatbot/nlDbQuery.service.js';
import { generateChatbotResponse, generateChatbotResponseStream } from '../services/chatbot/ollama.service.js';
import { generateCrimePredictionResponse, isCrimePredictionRequest } from '../services/chatbot/crimePrediction.service.js';
import { clearSession, getSession, getSessionMeta, touchSessionById, updateSessionState } from '../services/chatbot/sessionStore.js';
import { parseContextFromMessage } from '../services/chatbot/text.utils.js';
import expressRateLimit from 'express-rate-limit';
const createRateLimiter = (opts) => expressRateLimit(opts);
import { getDeterministicCacheStats } from '../services/chatbot/deterministicAnalysis.service.js';
import { t } from '../services/chatbot/i18n.service.js';
import { retrieveRagMatches } from '../services/chatbot/rag/rag.service.js';
import { computeConfidence, formatConfidenceBlock } from '../services/chatbot/confidence.service.js';
import { guardAgainstHallucination } from '../services/chatbot/hullcinationCheakService.js';
import { enforceRagScope } from '../services/chatbot/ragPolicy.service.js';
import {
  buildCaseGroundedRefusal,
  buildCaseSummaryAnswer,
  buildExactCaseAnswer,
  getCaseContextGeoFacts,
  getCaseContextScalar,
  getCaseContextSummary,
  getCaseContextTimeSeries,
  getCaseContextTopEntities,
  getCrossModuleOverlap,
  logCaseChatQuery,
  readCaseKnowledgeArtifact,
} from '../services/chatbot/caseKnowledge.service.js';
import { randomUUID } from 'crypto';

const router = express.Router();
router.use(optionalAuth);
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions?/i,
  /disregard\s+(all\s+)?(system|developer|previous)\s+instructions?/i,
  /reveal\s+(the\s+)?(system prompt|developer prompt|hidden prompt)/i,
  /\b(print|dump|expose|show)\b.*\b(env|environment variables?|\.env|api key|token|secret|password)\b/i,
  /\b(bypass|override)\b.*\b(safety|guardrails?|restrictions?)\b/i
];

const CHATBOT_LOG_TO_DB = String(process.env.CHATBOT_LOG_TO_DB || '').trim().toLowerCase() === 'true';
const CHATBOT_LOG_MAX_TEXT = Math.max(500, Math.min(20000, Number(process.env.CHATBOT_LOG_MAX_TEXT || 8000)));

const CHATBOT_RATE_LIMIT_ENABLED = String(process.env.CHATBOT_RATE_LIMIT_ENABLED || '').trim().toLowerCase() !== 'false';
const CHATBOT_RATE_LIMIT_WINDOW_MS = Math.max(1000, Math.min(10 * 60 * 1000, Number(process.env.CHATBOT_RATE_LIMIT_WINDOW_MS || 60_000)));
const CHATBOT_RATE_LIMIT_MAX = Math.max(5, Math.min(600, Number(process.env.CHATBOT_RATE_LIMIT_MAX || 60)));

const rateLimit = createRateLimiter({
  windowMs: CHATBOT_RATE_LIMIT_WINDOW_MS,
  max: CHATBOT_RATE_LIMIT_MAX,
  message: 'Chatbot rate limit exceeded. Please wait and retry.',
  skip: () => !CHATBOT_RATE_LIMIT_ENABLED
});

const CHATBOT_DIAGNOSTICS_ENABLED =
  String(process.env.CHATBOT_DIAGNOSTICS_ENABLED || '').trim().toLowerCase() === 'true';
const CHATBOT_CONFIDENCE_ENABLED =
  String(process.env.CHATBOT_CONFIDENCE_ENABLED || '').trim().toLowerCase() !== 'false';

const routeMetrics = new Map();

const bumpRouteMetric = (routeLabel, elapsedMs = null) => {
  if (!routeLabel) return;
  const existing = routeMetrics.get(routeLabel) || { hits: 0, avgMs: 0, lastMs: null, lastAt: null };
  const hits = existing.hits + 1;
  const last = Number.isFinite(elapsedMs) ? Math.round(elapsedMs) : null;
  routeMetrics.set(routeLabel, {
    hits,
    avgMs: last === null ? existing.avgMs : Math.round(((existing.avgMs || 0) * existing.hits + last) / hits),
    lastMs: last,
    lastAt: new Date().toISOString()
  });
};

const summarizeRouteMetrics = () =>
  Object.fromEntries(
    [...routeMetrics.entries()]
      .sort((a, b) => b[1].hits - a[1].hits)
      .map(([routeLabel, stats]) => [routeLabel, stats])
  );

const truncateText = (value, maxLen) => {
  const text = String(value ?? '');
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 12))}...<truncated>`;
};

const logChatbotInteraction = async (req, payload) => {
  if (!CHATBOT_LOG_TO_DB) return;

  const details = {
    route: payload?.route || null,
    mode: payload?.mode || null,
    elapsedMs: Number.isFinite(payload?.elapsedMs) ? Math.round(payload.elapsedMs) : null,
    sql: payload?.sql ? truncateText(payload.sql, 6000) : null,
    sqlBlocked: Boolean(payload?.sqlBlocked),
    sqlRowCount: Number.isFinite(payload?.sqlRowCount) ? payload.sqlRowCount : null,
    sqlPreviewRows: Number.isFinite(payload?.sqlPreviewRows) ? payload.sqlPreviewRows : null,
    userMessage: truncateText(payload?.userMessage || '', CHATBOT_LOG_MAX_TEXT),
    assistantResponse: truncateText(payload?.assistantResponse || '', CHATBOT_LOG_MAX_TEXT),
    error: payload?.error ? truncateText(payload.error, 2000) : null
  };

  try {
    await pool.query(
      `
        INSERT INTO audit_logs (session_id, action, resource_type, resource_id, details, ip_address)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        payload?.sessionId ? String(payload.sessionId) : null,
        payload?.action ? String(payload.action) : 'chatbot_message',
        'chatbot',
        payload?.caseId ? String(payload.caseId) : null,
        JSON.stringify(details),
        req.ip || null
      ]
    );
  } catch (error) {
    console.error('Chatbot audit log failed:', error?.message || error);
  }
};

const validateMessage = (raw) => {
  if (typeof raw !== 'string') return { ok: false, error: 'Message is required' };
  const text = raw.trim();
  if (!text) return { ok: false, error: 'Message is required' };
  if (text.length > CHATBOT_MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `Message exceeds ${CHATBOT_MAX_MESSAGE_LENGTH} characters.` };
  }
  return { ok: true, text };
};

const looksLikePromptInjection = (message) => PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(message));
const normalizePreferredLanguage = (value) => {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'en' || v === 'hi' || v === 'gu') return v;
  return null;
};

const finalizeResponse = (rawResponse, mode = 'chat') => {
  let text = String(rawResponse || '').trim();
  if (!text) text = '### SHAKTI SAHAYATA AI\n\nNo response generated.';

  if (!text.startsWith('### SHAKTI SAHAYATA AI')) {
    text = `### SHAKTI SAHAYATA AI\n\n${text}`;
  }

  // Remove accidental repeated heading blocks.
  text = text.replace(
    /^### SHAKTI SAHAYATA AI(?:\s*[\r\n]+)+\*\*SHAKTI SAHAYATA AI\*\*\s*/i,
    '### SHAKTI SAHAYATA AI\n\n'
  );

  text = text.replaceAll(/\n{3,}/g, '\n\n');
  return text;
};

const appendConfidenceBlock = (responseText, confidence, lang = 'en') => {
  return responseText;
};

const getStreamState = (res) => res?.locals?.chatbotStreamState || null;

const writeStreamEvent = (res, payload = {}) => {
  if (!res || res.writableEnded) return;
  res.write(`${JSON.stringify(payload)}\n`);
};

const initializeStream = (res) => {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
};

const sendErrorPayload = (res, statusCode, payload = {}) => {
  const streamState = getStreamState(res);
  if (streamState?.active) {
    writeStreamEvent(res, { type: 'error', status: statusCode, ...payload });
    return res.end();
  }
  return res.status(statusCode).json(payload);
};

const sendResponse = ({
  res,
  session,
  responseText,
  mode,
  logState,
  effectiveLanguage,
  confidenceInput = {},
  extra = {}
}) => {
  const guarded = guardAgainstHallucination(responseText, effectiveLanguage, { mode });
  const confidence = computeConfidence({ mode, responseText: guarded, ...confidenceInput });
  const withConfidence = appendConfidenceBlock(guarded, confidence, effectiveLanguage);
  session.history.push({ role: 'assistant', content: withConfidence });
  touchSessionById(session.id);
  logState.mode = mode;
  logState.assistantResponse = withConfidence;
  const streamState = getStreamState(res);
  if (streamState?.active) {
    streamState.completed = true;
    const streamPayload = { type: 'complete', response: withConfidence, sessionId: session.id, mode, confidence, ...extra };
    if (extra?.answerPayload) streamPayload.answerPayload = extra.answerPayload;
    writeStreamEvent(res, streamPayload);
    return res.end();
  }
  const jsonPayload = { response: withConfidence, sessionId: session.id, mode, confidence, ...extra };
  if (extra?.answerPayload) jsonPayload.answerPayload = extra.answerPayload;
  res.json(jsonPayload);
};

const buildHandlerResult = ({
  handled = true,
  responseText = null,
  mode = 'chat',
  confidenceInput = {},
  answerPayload = null,
  extra = {},
  sessionPatch = {},
  logPatch = {}
} = {}) => ({
  handled,
  responseText,
  mode,
  confidenceInput,
  answerPayload,
  extra: {
    ...extra,
    ...(answerPayload ? { answerPayload } : {})
  },
  sessionPatch,
  logPatch
});

const coerceHandlerResult = (result) => {
  if (!result) return { handled: false };
  if (typeof result === 'boolean') return { handled: result, legacy: true };
  return result;
};

const dispatchHandlerResult = ({
  result,
  res,
  session,
  logState,
  effectiveLanguage,
  plan
}) => {
  const handled = coerceHandlerResult(result);
  if (!handled?.handled) return false;

  if (handled.logPatch && typeof handled.logPatch === 'object') {
    Object.assign(logState, handled.logPatch);
  }

  if (handled.responseText) {
    sendResponse({
      res,
      session,
      responseText: handled.responseText,
      mode: handled.mode || 'chat',
      logState,
      effectiveLanguage,
      confidenceInput: handled.confidenceInput || {},
      extra: handled.extra || {}
    });
  }

  if (!handled.legacy) {
    const plannerPatch = buildSessionStatePatch(plan, handled);
    const mergedSessionPatch = {
      ...plannerPatch,
      ...(handled.sessionPatch || {})
    };
    if (Object.keys(mergedSessionPatch).length > 0) {
      updateSessionState(session.id, mergedSessionPatch);
    }
  } else {
    updateSessionState(session.id, buildSessionStatePatch(plan));
  }

  return true;
};

const inferCitationTables = (message, resolvedContext = {}) => {
  const text = String(message || '').toLowerCase();
  const tables = ['cases'];
  if (resolvedContext.module === 'cdr' || /\bcdr|call\b/.test(text)) tables.push('cdr_records');
  if (resolvedContext.module === 'ipdr' || /\bipdr|internet|ip\b/.test(text)) tables.push('ipdr_records');
  if (resolvedContext.module === 'ild' || /\bild\b/.test(text)) tables.push('ild_records');
  if (resolvedContext.module === 'sdr' || /\bsdr|subscriber\b/.test(text)) tables.push('sdr_records');
  if (resolvedContext.module === 'tower' || /\btower|cell\b/.test(text)) tables.push('tower_dump_records');
  if (/\bfile|upload\b/.test(text)) tables.push('uploaded_files', 'file_classifications');
  return [...new Set(tables)];
};

const appendSources = (responseText, knowledge, tables) => {
  if (!knowledge?.caseRow) return responseText;
  if (String(responseText || '').includes('**Sources**')) return responseText;
  const block = buildCaseCitationBlock({ knowledge, tables });
  return block ? `${responseText}\n\n${block}` : responseText;
};

const buildCaseGuardrailResponse = (lang = 'en') =>
  finalizeResponse(
    t(lang, {
      en: 'This request needs a tagged case in the current message before I can answer. Tag one with `@123`, `@CASE-2025-01`, or `@"Case Name"`.',
      hi: 'Is request ke liye current message me tagged case zaroori hai. `@123`, `@CASE-2025-01`, ya `@"Case Name"` se case tag kijiye.',
      gu: 'Aa request mate current message ma tagged case jaruri chhe. `@123`, `@CASE-2025-01`, athva `@"Case Name"` thi case tag karo.'
    }),
    'chat_guidance'
  );

const buildIrrelevantCaseQuestionResponse = (lang = 'en') =>
  finalizeResponse(
    t(lang, {
      en: 'This question is not relevant to the tagged case. I can only answer investigation-related questions about case data, files, records, entities, summaries, and timelines.',
      hi: 'Yeh sawal tagged case se related nahi hai. Main sirf case data, files, records, entities, summaries, aur timelines se jude investigation questions ka jawab de sakta hoon.',
      gu: 'Aa prashn tagged case sathe sambandhit nathi. Hu keval case data, files, records, entities, summaries ane timelines sambandhit investigation prashno na jawab api shaku chhu.'
    }),
    'chat_guidance'
  );

const extractUserFacingQuestion = (message = '') => {
  const text = String(message || '').trim();
  const explicitUserBlock = text.match(/(?:^|\n)User:\s*([\s\S]+)$/i);
  if (explicitUserBlock?.[1]) return explicitUserBlock[1].trim();
  return text;
};

const toCompactCaseSuggestion = (row = {}) => ({
  id: String(row.id || ''),
  caseName: row.caseName || row.case_name || null,
  caseNumber: row.caseNumber || row.case_number || null,
  firNumber: row.firNumber || row.fir_number || null
});

const NON_CASE_PATTERNS = [
  /\bhow are you\b/i,
  /\bwhat(?:'s| is)\s+your\s+name\b/i,
  /\bwho are you\b/i,
  /\bwho made you\b/i,
  /\bwho created you\b/i,
  /\btell me a joke\b/i,
  /\bjoke\b/i,
  /\bhello\b/i,
  /\bhi\b/i,
  /\bhey\b/i,
  /\bgood (?:morning|afternoon|evening|night)\b/i,
  /\bthank you\b/i,
  /\bthanks\b/i,
  /\bwhat can you do\b/i,
  /\bare you there\b/i,
  /\bweather\b/i,
  /\btime\b/i,
  /\bdate\b/i
];

const CASE_RELEVANT_PATTERNS = [
  /\bcase\b/i,
  /\bfir\b/i,
  /\bsummary\b/i,
  /\boverview\b/i,
  /\btimeline\b/i,
  /\bactivity\b/i,
  /\bactivities\b/i,
  /\bname\b/i,
  /\bnames\b/i,
  /\bnumber\b/i,
  /\bnumbers\b/i,
  /\bcontact\b/i,
  /\bcontacts\b/i,
  /\bassociated\b/i,
  /\blinked\b/i,
  /\bentity\b/i,
  /\bentities\b/i,
  /\bfile\b/i,
  /\bfiles\b/i,
  /\bupload\b/i,
  /\brecord\b/i,
  /\brecords\b/i,
  /\bcdr\b/i,
  /\bipdr\b/i,
  /\bsdr\b/i,
  /\btower\b/i,
  /\bild\b/i,
  /\bimei\b/i,
  /\bimsi\b/i,
  /\boperator\b/i,
  /\brisk\b/i,
  /\bpattern\b/i,
  /\bsuspect\b/i,
  /\bsuspects\b/i,
  /\blocation\b/i,
  /\blocat(?:e|ion)\b/i,
  /\bevidence\b/i,
  /\banalysis\b/i,
  /\bsummarize\b/i,
  /\bshow\b/i,
  /\blist\b/i,
  /\bextract\b/i,
  /\bfind\b/i
];

const isCaseRelevantQuestion = (message = '') => {
  const text = extractUserFacingQuestion(message).trim();
  if (!text) return false;
  if (NON_CASE_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return CASE_RELEVANT_PATTERNS.some((pattern) => pattern.test(text));
};

const isKnownMetricQuestion = (message = '', resolvedContext = {}) => {
  const text = extractUserFacingQuestion(message).trim();
  if (!text) return false;

  const module = resolvedContext?.workspaceContext?.module || resolvedContext?.module || null;
  return Boolean(resolveMetricDefinition({ message: text, module }));
};

const isGroundedCaseQuestion = (message = '', resolvedContext = {}) => {
  const text = extractUserFacingQuestion(message).trim();
  if (!text) return false;
  if (isKnownMetricQuestion(text, resolvedContext)) return true;
  return isGroundableCaseQuestionText(text);
};

const detectDeterministicCaseFact = (message = '') => {
  const text = extractUserFacingQuestion(message).trim().toLowerCase();
  if (!text) return null;

  if (/\b(telecom|operator|service provider|network)\b/.test(text)) return 'operator';
  if (/\bfir\b/.test(text) && /\b(number|id|no|details?)\b/.test(text)) return 'firNumber';
  if (/\bcase\b/.test(text) && /\b(number|no)\b/.test(text)) return 'caseNumber';
  if (/\bcase\b/.test(text) && /\b(id)\b/.test(text)) return 'caseId';
  if (/\bstatus\b/.test(text)) return 'status';
  if (/\bcase\s*type\b|\btype of case\b/.test(text)) return 'caseType';
  if (/\b(created|creation date|created at|opened)\b/.test(text)) return 'createdAt';
  if (/\bavailable modules?\b|\bwhich modules?\b|\bwhat modules?\b/.test(text)) return 'availableModules';
  if (/\b(uploaded files?|files? uploaded|file count)\b/.test(text)) return 'uploadedFiles';
  if (/\b(cdr|ipdr|sdr|tower|ild|timeline)\b.*\b(count|records?|available)\b/.test(text)) return 'datasetCounts';
  return null;
};

const detectDeterministicCaseInsight = (message = '') => {
  const text = extractUserFacingQuestion(message).trim().toLowerCase();
  if (!text) return null;

  if (/\b(names?|people|persons?)\b.*\b(associated|linked|present|found|in this case)\b/.test(text)
    || /\b(associated|linked)\b.*\bnames?\b/.test(text)
    || /\bsubscriber names?\b/.test(text)) {
    return 'associatedNames';
  }

  if (/\b(top|key|main|associated|linked)\b.*\b(contacts?|numbers?|parties)\b/.test(text)
    || /\b(contacts?|numbers?|parties)\b.*\b(top|key|main|associated|linked)\b/.test(text)) {
    return 'topContacts';
  }

  if (/\btimeline\b.*\b(available|availability|present|exists?)\b/.test(text)
    || /\bis there (a|any) timeline\b/.test(text)) {
    return 'timelineAvailability';
  }

  if (/\b(files?|uploads?)\b.*\b(list|latest|show|available|which)\b/.test(text)) {
    return 'recentFiles';
  }

  return null;
};

const formatCaseFactValue = (factKey, knowledge) => {
  const caseInfo = knowledge?.case || {};
  const availability = knowledge?.availability || {};
  const counts = knowledge?.datasetCounts || {};

  if (factKey === 'operator') return caseInfo.operator || null;
  if (factKey === 'firNumber') return caseInfo.firNumber || null;
  if (factKey === 'caseNumber') return caseInfo.caseNumber || null;
  if (factKey === 'caseId') return caseInfo.id || null;
  if (factKey === 'status') return caseInfo.status || null;
  if (factKey === 'caseType') return caseInfo.caseType || null;
  if (factKey === 'createdAt') return caseInfo.createdAt || null;
  if (factKey === 'uploadedFiles') return knowledge?.files?.totalUploadedFiles ?? 0;
  if (factKey === 'availableModules') {
    const modules = ['cdr', 'ipdr', 'sdr', 'tower', 'ild', 'timeline']
      .filter((key) => availability[key])
      .map((key) => key === 'tower' ? 'Tower Dump' : key.toUpperCase());
    return modules;
  }
  if (factKey === 'datasetCounts') {
    return {
      cdr: Number(counts.cdr || 0),
      ipdr: Number(counts.ipdr || 0),
      sdr: Number(counts.sdr || 0),
      tower: Number(counts.tower || 0),
      ild: Number(counts.ild || 0),
      timeline: Number(counts.timeline || 0)
    };
  }

  return null;
};

const buildDeterministicCaseFactResponse = (factKey, knowledge, lang = 'en') => {
  const caseInfo = knowledge?.case || {};
  const caseLabel = caseInfo.caseName || caseInfo.caseNumber || `Case ${caseInfo.id || ''}`.trim();
  const value = formatCaseFactValue(factKey, knowledge);

  if (value === null || value === undefined || value === '') {
    return finalizeResponse(
      t(lang, {
        en: `I could not find that case fact in the verified case context for ${caseLabel}.`,
        hi: `${caseLabel} ke verified case context me yeh fact nahi mila.`,
        gu: `${caseLabel} na verified case context ma aa fact malyo nathi.`
      }),
      'db_summary'
    );
  }

  const bodyByFact = {
    operator: `Telecom Operator: ${value}`,
    firNumber: `FIR Number: ${value}`,
    caseNumber: `Case Number: ${value}`,
    caseId: `Case ID: ${value}`,
    status: `Status: ${value}`,
    caseType: `Case Type: ${value}`,
    createdAt: `Created At: ${value}`,
    uploadedFiles: `Uploaded Files: ${value}`,
    availableModules: `Available Modules: ${Array.isArray(value) && value.length ? value.join(', ') : 'None yet'}`,
    datasetCounts: [
      'Dataset Counts:',
      `- CDR: ${value.cdr}`,
      `- IPDR: ${value.ipdr}`,
      `- SDR: ${value.sdr}`,
      `- Tower Dump: ${value.tower}`,
      `- ILD: ${value.ild}`,
      `- Timeline: ${value.timeline}`
    ].join('\n')
  };

  return finalizeResponse(
    [
      `**Verified Case Fact**`,
      `Case: ${caseLabel}`,
      '',
      bodyByFact[factKey] || '- No fact available.'
    ].join('\n'),
    'db_summary'
  );
};

const buildDeterministicCaseInsightResponse = (insightKey, knowledge, summary, lang = 'en') => {
  const caseInfo = knowledge?.case || {};
  const caseLabel = caseInfo.caseName || caseInfo.caseNumber || `Case ${caseInfo.id || ''}`.trim();

  if (insightKey === 'associatedNames') {
    const names = summary?.facts?.topSubscriberNames || [];
    if (!Array.isArray(names) || names.length === 0) {
      return finalizeResponse(
        t(lang, {
          en: `I could not find verified associated names for ${caseLabel}.`,
          hi: `${caseLabel} ke liye verified associated names nahi mile.`,
          gu: `${caseLabel} mate verified associated names malya nathi.`
        }),
        'db_summary'
      );
    }

    return finalizeResponse(
      [
        '**Verified Case Insight**',
        `Case: ${caseLabel}`,
        '',
        'Associated Names:',
        ...names.slice(0, 5).map((row, index) => `- ${index + 1}. ${row.label} (${row.count})`)
      ].join('\n'),
      'db_summary'
    );
  }

  if (insightKey === 'topContacts') {
    const contacts = summary?.facts?.topBParties || summary?.facts?.topPhoneNumbers || summary?.facts?.topMsisdn || [];
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return finalizeResponse(`I could not find verified top contacts for ${caseLabel}.`, 'db_summary');
    }

    return finalizeResponse(
      [
        '**Verified Case Insight**',
        `Case: ${caseLabel}`,
        '',
        'Top Contacts:',
        ...contacts.slice(0, 5).map((row, index) => `- ${index + 1}. ${row.label} (${row.count})`)
      ].join('\n'),
      'db_summary'
    );
  }

  if (insightKey === 'timelineAvailability') {
    const count = Number(knowledge?.datasetCounts?.timeline || 0);
    return finalizeResponse(
      [
        '**Verified Case Insight**',
        `Case: ${caseLabel}`,
        '',
        count > 0
          ? `Timeline: Available (${count} events)`
          : 'Timeline: Not available yet'
      ].join('\n'),
      'db_summary'
    );
  }

  if (insightKey === 'recentFiles') {
    const files = knowledge?.files?.items || [];
    return finalizeResponse(
      [
        '**Verified Case Insight**',
        `Case: ${caseLabel}`,
        '',
        files.length
          ? 'Recent Files:'
          : 'Recent Files: No uploaded files found.',
        ...files.slice(0, 5).map((file) => `- ${file.originalName} (${file.detectedType || file.fileType || 'unknown'})`)
      ].join('\n'),
      'db_summary'
    );
  }

  return finalizeResponse(`I could not build a verified insight for ${caseLabel}.`, 'db_summary');
};

const hydrateResolvedContext = async (resolvedContext = {}, user = null) => {
  const resolved = await resolveCaseReference({
    user,
    caseId: resolvedContext.caseId,
    firNumber: resolvedContext.fir,
    reference: resolvedContext.taggedCaseRef || resolvedContext.caseName
  });

  if (resolved?.ambiguous) {
    return {
      ...resolvedContext,
      ambiguousCases: resolved.candidates || []
    };
  }

  const resolvedCase = resolved?.caseRow;
  if (!resolvedCase) return resolvedContext;

  return {
    ...resolvedContext,
    caseId: String(resolvedCase.id),
    caseName: resolvedCase.case_name || resolvedContext.caseName || null,
    caseNumber: resolvedCase.case_number || null,
    caseType: resolvedContext.caseType || resolvedCase.case_type || null,
    ambiguousCases: []
  };
};

const isTagOnlyMessage = (message = '') => /^@"[^"]+"\s*$|^@[a-z0-9][a-z0-9_\-\/]{1,63}\s*$/i.test(String(message || '').trim());

const detectRequestedModule = (message = '', resolvedContext = {}) => {
  const text = String(message || '').trim().toLowerCase();
  const workspaceModule = resolvedContext?.workspaceContext?.module || null;
  if (!text) return null;

  if (/\bfiles?\b|\buploads?\b/.test(text)) return 'files';
  if (/\btimeline\b|\bevents?\b/.test(text)) return 'timeline';
  if (/\bcdr\b|\bcall detail\b|\bcall analysis\b/.test(text)) return 'cdr';
  if (/\bipdr\b|\binternet\b|\bip analysis\b/.test(text)) return 'ipdr';
  if (/\bsdr\b|\bsubscriber\b/.test(text)) return 'sdr';
  if (/\btower\b|\bcell\b/.test(text)) return 'tower';
  if (/\bild\b|\binternational\b/.test(text)) return 'ild';
  if (
    isTagOnlyMessage(text)
    || /\boverview\b|\bsummary\b|\btell me about\b|\bcase details?\b|\bcase info\b|\bwhat do you know\b/.test(text)
  ) {
    return 'overview';
  }

  return workspaceModule || resolvedContext.module || null;
};

const buildAmbiguousCaseResponse = (candidates = []) =>
  finalizeResponse(
    [
      'I found multiple matching cases. Please pick one by tagging its exact case name or case number:',
      '',
      ...candidates.slice(0, 5).map((row, index) => `${index + 1}. ${row.caseNumber || row.caseName || `Case ${row.id}`} | FIR: ${row.firNumber || 'N/A'} | ID: ${row.id}`)
    ].join('\n'),
    'chat_guidance'
  );

const isSimpleAffirmation = (message = '') => {
  const text = String(message || '').trim().toLowerCase();
  return /^(y|yes|yeah|yep|ok|okay|sure|run|execute|go ahead|please do|do it|haan|ha|han|chalo|karo|kar do)$/.test(text);
};

const isSimpleCancellation = (message = '') => {
  const text = String(message || '').trim().toLowerCase();
  return /^(n|no|nah|nope|cancel|stop|dont|don't|not now|na|nahi|mat|mat karo)$/.test(text);
};

const rememberPendingSqlFromResponse = (sessionId, responseText) => {
  if (!sessionId || !responseText) return;

  const sql = extractFirstSqlCodeBlock(responseText);
  if (!sql) return;

  const validation = validateReadOnlySql(sql);
  if (!validation.ok) return;

  updateSessionState(sessionId, { pendingSql: validation.sql, pendingSqlAt: Date.now() });
};

const handlePendingSql = async ({ message, session, effectiveLanguage, logState, res }) => {
  if (!session.state?.pendingSql || isSqlCommand(message)) return false;

  if (isSimpleCancellation(message)) {
    updateSessionState(session.id, { pendingSql: null, pendingSqlAt: null });
    const botResponse = finalizeResponse(t(effectiveLanguage, {
      en: 'Cancelled. Send a new request or use `/sql SELECT ...`.',
      hi: 'Cancel kar diya. Naya request bhejo ya `/sql SELECT ...` use karo.',
      gu: 'Cancel karyu. Navo request moklo athva `/sql SELECT ...` vapro.'
    }), 'chat_guidance');
    sendResponse({
      res,
      session,
      responseText: botResponse,
      mode: 'chat_guidance',
      logState,
      effectiveLanguage,
      confidenceInput: { mode: 'chat_guidance', intentScore: 0.7, intentLabel: 'cancel' }
    });
    return true;
  }

  if (!isSimpleAffirmation(message)) return false;

  const sql = session.state.pendingSql;
  try {
    logState.sql = sql;
    const result = await executeReadOnlyQuery(sql);
    updateSessionState(session.id, { pendingSql: null, pendingSqlAt: null });
    const botResponse = finalizeResponse(formatDbResultAsMarkdown(sql, result), 'db');
    logState.sqlRowCount = result?.totalRows ?? null;
    logState.sqlPreviewRows = Array.isArray(result?.rows) ? result.rows.length : null;
    sendResponse({
      res,
      session,
      responseText: botResponse,
      mode: 'db',
      logState,
      effectiveLanguage,
      confidenceInput: {
        mode: 'db',
        sqlRowCount: logState.sqlRowCount,
        sqlTruncated: Boolean(result?.truncated),
        intentScore: 0.95,
        intentLabel: 'sql_execute'
      }
    });
    return true;
  } catch (error) {
    updateSessionState(session.id, { pendingSql: null, pendingSqlAt: null });
    session.history.pop();
    touchSessionById(session.id);
    const safeMessage =
      error?.code === 'SQL_BLOCKED'
        ? error.message
        : 'Database query failed. Verify DB connection and query.';
    logState.action = 'chatbot_error';
    logState.mode = 'db';
    logState.sqlBlocked = error?.code === 'SQL_BLOCKED';
    logState.error = safeMessage;
    sendErrorPayload(res, error?.code === 'SQL_BLOCKED' ? 400 : 500, { error: safeMessage, sessionId: session.id });
    return true;
  }
};

const handleSqlCommand = async ({ message, session, effectiveLanguage, logState, res }) => {
  if (!isSqlCommand(message)) return false;

  const sql = extractSqlFromMessage(message);
  const validation = validateReadOnlySql(sql);
  if (!validation.ok) {
    session.history.pop();
    touchSessionById(session.id);
    logState.action = 'chatbot_error';
    logState.mode = 'db';
    logState.sql = sql;
    logState.sqlBlocked = true;
    logState.error = validation.error;
    sendErrorPayload(res, 400, { error: validation.error, sessionId: session.id, mode: 'db' });
    return true;
  }

  try {
    logState.sql = validation.sql;
    const result = await executeReadOnlyQuery(validation.sql);
    updateSessionState(session.id, { pendingSql: null, pendingSqlAt: null });
    const botResponse = finalizeResponse(formatDbResultAsMarkdown(validation.sql, result), 'db');
    logState.sqlRowCount = result?.totalRows ?? null;
    logState.sqlPreviewRows = Array.isArray(result?.rows) ? result.rows.length : null;
    sendResponse({
      res,
      session,
      responseText: botResponse,
      mode: 'db',
      logState,
      effectiveLanguage,
      confidenceInput: {
        mode: 'db',
        sqlRowCount: logState.sqlRowCount,
        sqlTruncated: Boolean(result?.truncated),
        intentScore: 0.95,
        intentLabel: 'sql_execute'
      }
    });
    return true;
  } catch (error) {
    session.history.pop();
    touchSessionById(session.id);
    const safeMessage =
      error?.code === 'SQL_BLOCKED'
        ? error.message
        : 'Database query failed. Query was not executed if it violated policy.';
    logState.action = 'chatbot_error';
    logState.mode = 'db';
    logState.sqlBlocked = error?.code === 'SQL_BLOCKED';
    logState.error = safeMessage;
    sendErrorPayload(res, error?.code === 'SQL_BLOCKED' ? 400 : 500, { error: safeMessage, sessionId: session.id });
    return true;
  }
};

const handleSimpleGreeting = ({ message, session, effectiveLanguage, logState, res }) => {
  if (!isSimpleGreeting(message)) return false;

  logState.route = 'greeting';
  const botResponse = finalizeResponse(buildGreetingResponse(effectiveLanguage), 'chat');
  sendResponse({
    res,
    session,
    responseText: botResponse,
    mode: 'chat',
    logState,
    effectiveLanguage,
    confidenceInput: { mode: 'chat', isGreeting: true, intentScore: 0.98, intentLabel: 'greeting' }
  });
  return true;
};

const extractCaseIdFromMessage = (message = '') => {
  const text = String(message || '');
  const m = text.match(/\bcase\s*(?:id)?\s*[-:#]?\s*(\d+)\b/i);
  return m?.[1] || null;
};

const extractCaseQueryFromMessage = (message = '') => {
  const raw = String(message || '');
  const quoted = raw.match(/"([^"]{3,})"/);
  if (quoted?.[1]) return quoted[1].trim();

  const lower = raw.toLowerCase();
  if (!/\b(summary|overview|case summary)\b/i.test(lower)) return null;
  const cleaned = raw
    .replace(/\b(summary|overview|case summary)\b/gi, '')
    .replace(/\bfir\b/gi, '')
    .replace(/\bcase\b/gi, '')
    .replace(/[#:-]/g, ' ')
    .trim();
  return cleaned.length >= 3 ? cleaned : null;
};

const handleFirSummary = async ({ message, session, resolvedContext, effectiveLanguage, logState, res, user }) => {
  const firRequest = detectFirRequest(message);
  const effectiveFir = firRequest?.firNumber || resolvedContext.fir;
  const caseId = extractCaseIdFromMessage(message) || resolvedContext.caseId || null;
  const caseQuery = extractCaseQueryFromMessage(message);

  if (!(effectiveFir || caseId || caseQuery) || !(firRequest || /\b(summary|overview|case summary)\b/i.test(message))) return false;

  try {
    logState.route = 'fir_summary';
    const summary = await fetchCaseSummary({ firNumber: effectiveFir, caseId, query: caseQuery });
    const candidates = summary ? [] : await findCaseCandidates({ firNumber: effectiveFir, caseId, query: caseQuery });
    const label = effectiveFir
      ? `FIR ${effectiveFir}`
      : (caseId ? `Case ${caseId}` : (caseQuery ? `Case "${caseQuery}"` : 'Case'));
    let botResponse = summary
      ? buildFirSummaryMarkdown({ firNumber: effectiveFir, ...summary, language: effectiveLanguage, label })
      : buildMissingCaseResponse({ label, candidates, language: effectiveLanguage });
    if (summary?.caseRow?.id) {
      const knowledge = await fetchCaseKnowledge(summary.caseRow.id, { user });
      botResponse = appendSources(botResponse, knowledge, inferCitationTables(message, { ...resolvedContext, module: 'cdr' }));
    }
    const finalResponse = finalizeResponse(botResponse, 'db_summary');
    sendResponse({
      res,
      session,
      responseText: finalResponse,
      mode: 'db_summary',
      logState,
      effectiveLanguage,
      confidenceInput: { mode: 'db_summary', intentScore: 0.9, intentLabel: 'case_summary' }
    });
    return true;
  } catch {
    session.history.pop();
    touchSessionById(session.id);
    logState.action = 'chatbot_error';
    logState.mode = 'db_summary';
    logState.error = 'Database summary failed';
    sendErrorPayload(res, 500, {
      error: `Database summary failed. Please verify DB connection and tables.`
    });
    return true;
  }
};

const handleCrimePrediction = async ({ message, session, resolvedContext, effectiveLanguage, logState, res }) => {
  if (!isCrimePredictionRequest(message)) return false;

  try {
    logState.route = 'prediction';
    const prediction = await generateCrimePredictionResponse(message, resolvedContext);
    const botResponse = finalizeResponse(prediction.response, prediction.mode || 'prediction');
    sendResponse({
      res,
      session,
      responseText: botResponse,
      mode: prediction.mode || 'prediction',
      logState,
      effectiveLanguage,
      confidenceInput: {
        mode: prediction.mode || 'prediction',
        intentScore: 0.9,
        intentLabel: 'prediction',
        predictionScore: prediction.riskScore,
        predictionSignals: prediction.signalCount
      }
    });
    return true;
  } catch {
    session.history.pop();
    touchSessionById(session.id);
    logState.action = 'chatbot_error';
    logState.mode = 'prediction';
    logState.error = 'Prediction failed';
    sendErrorPayload(res, 500, { error: 'Prediction failed. Please verify case and database data.' });
    return true;
  }
};

const handleOpenCdr = ({ message, session, context, resolvedContext, effectiveLanguage, logState, res }) => {
  if (!looksLikeOpenCdrFirRequest(message)) return false;

  logState.route = 'open_cdr_guidance';
  const botResponse = buildOpenCdrFirGuidanceResponse(message, {
    ...context,
    caseId: resolvedContext.caseId || context.caseId,
    caseType: context.caseType
  }, effectiveLanguage);
  const finalResponse = finalizeResponse(botResponse, 'chat_guidance');
  rememberPendingSqlFromResponse(session.id, finalResponse);
  sendResponse({
    res,
    session,
    responseText: finalResponse,
    mode: 'chat_guidance',
    logState,
    effectiveLanguage,
    confidenceInput: { mode: 'chat_guidance', intentScore: 0.85, intentLabel: 'open_cdr_guidance' }
  });
  return true;
};

const handleCaseAwareSummary = async ({ message, session, resolvedContext, effectiveLanguage, logState, res, user }) => {
  if (Array.isArray(resolvedContext.ambiguousCases) && resolvedContext.ambiguousCases.length > 0) {
    const botResponse = buildAmbiguousCaseResponse(resolvedContext.ambiguousCases);
    sendResponse({
      res,
      session,
      responseText: botResponse,
      mode: 'chat_guidance',
      logState,
      effectiveLanguage,
      confidenceInput: { mode: 'chat_guidance', intentScore: 0.8, intentLabel: 'ambiguous_case_match' }
    });
    return true;
  }

  if (!resolvedContext.caseId) return false;

  const requestedModule = detectRequestedModule(message, resolvedContext);
  if (!requestedModule) return false;

  logState.route = `summary_${requestedModule}`;
  const knowledge = await fetchCaseKnowledge(resolvedContext.caseId, { user });
  if (!knowledge) return false;

  const summary = requestedModule === 'overview'
    ? await buildCaseKnowledgeContract(resolvedContext.caseId, { user })
    : await getCaseModuleSummary(resolvedContext.caseId, requestedModule, { user });

  const responsePayload = requestedModule === 'overview' ? summary?.summaries?.overview : summary;
  if (!responsePayload?.markdown) return false;

  const botResponse = appendSources(
    finalizeResponse(responsePayload.markdown, 'db_summary'),
    knowledge,
    inferCitationTables(message, { ...resolvedContext, module: requestedModule })
  );

  sendResponse({
    res,
    session,
    responseText: botResponse,
    mode: 'db_summary',
    logState,
    effectiveLanguage,
    confidenceInput: {
      mode: 'db_summary',
      intentScore: 0.92,
      intentLabel: `case_${requestedModule}_summary`,
      hasChart: Boolean(responsePayload.chartSpecs?.length)
    },
    extra: {
      chartSpecs: responsePayload.chartSpecs || null
    }
  });
  return true;
};

const handleWorkspaceAwareResponse = async ({ message, resolvedContext, user, queryOptions = {} }) => {
  const workspaceAnswer = await lookupWorkspaceAnswer({
    message,
    resolvedContext,
    workspaceContext: resolvedContext?.workspaceContext || null,
    user,
    queryOptions
  });
  if (!workspaceAnswer?.markdown) return { handled: false };

  const knowledge = await fetchCaseKnowledge(resolvedContext.caseId, { user });
  const responseText = appendSources(
    finalizeResponse(workspaceAnswer.markdown, workspaceAnswer.mode || 'db_summary'),
    knowledge,
    workspaceAnswer.tables || inferCitationTables(message, resolvedContext)
  );

  return buildHandlerResult({
    responseText,
    mode: workspaceAnswer.mode || 'db_summary',
    answerPayload: workspaceAnswer.answerPayload || null,
    confidenceInput: workspaceAnswer.confidenceInput || {
      mode: 'db_summary',
      intentScore: 0.9,
      intentLabel: 'workspace_memory'
    },
    logPatch: {
      route: workspaceAnswer.route || 'workspace_memory'
    }
  });
};

const handleDeterministicCaseFact = async ({ message, session, resolvedContext, effectiveLanguage, logState, res, user }) => {
  if (!resolvedContext.caseId) return false;

  const factKey = detectDeterministicCaseFact(message);
  if (!factKey) return false;

  const knowledge = await fetchCaseKnowledge(resolvedContext.caseId, { user });
  if (!knowledge) return false;

  logState.route = `fact_${factKey}`;
  let responseText = buildDeterministicCaseFactResponse(factKey, knowledge, effectiveLanguage);
  responseText = appendSources(responseText, knowledge, ['cases']);

  sendResponse({
    res,
    session,
    responseText,
    mode: 'db_summary',
    logState,
    effectiveLanguage,
    confidenceInput: { mode: 'db_summary', intentScore: 0.97, intentLabel: `case_fact_${factKey}` }
  });
  return true;
};

const handleDeterministicCaseInsight = async ({ message, session, resolvedContext, effectiveLanguage, logState, res, user }) => {
  if (!resolvedContext.caseId) return false;

  const insightKey = detectDeterministicCaseInsight(message);
  if (!insightKey) return false;

  const knowledge = await fetchCaseKnowledge(resolvedContext.caseId, { user });
  if (!knowledge) return false;

  const targetModule = insightKey === 'associatedNames'
    ? 'sdr'
    : insightKey === 'topContacts'
      ? (knowledge.availability?.cdr ? 'cdr' : (knowledge.availability?.sdr ? 'sdr' : 'ipdr'))
      : null;
  const summary = targetModule ? await getCaseModuleSummary(resolvedContext.caseId, targetModule, { user }) : null;
  let responseText = buildDeterministicCaseInsightResponse(insightKey, knowledge, summary, effectiveLanguage);
  responseText = appendSources(responseText, knowledge, inferCitationTables(message, { ...resolvedContext, module: targetModule || resolvedContext.module }));

  logState.route = `insight_${insightKey}`;
  sendResponse({
    res,
    session,
    responseText,
    mode: 'db_summary',
    logState,
    effectiveLanguage,
    confidenceInput: { mode: 'db_summary', intentScore: 0.95, intentLabel: `case_insight_${insightKey}` }
  });
  return true;
};

const handleDirectDbRequest = async ({ message, session, resolvedContext, effectiveLanguage, logState, res, user }) => {
  if (!looksLikeDirectDbDataRequest(message)) return false;

  logState.route = 'direct_db';
  try {
    const directDb = await tryHandleNaturalLanguageDbRequest(message, resolvedContext);
    if (directDb.handled) {
      let finalResponse = finalizeResponse(directDb.response, directDb.mode || 'db');
      if (resolvedContext.caseId) {
        const knowledge = await fetchCaseKnowledge(resolvedContext.caseId, { user });
        finalResponse = appendSources(finalResponse, knowledge, inferCitationTables(message, resolvedContext));
      }
      if (directDb.sql) logState.sql = String(directDb.sql);
      sendResponse({
        res,
        session,
        responseText: finalResponse,
        mode: directDb.mode || 'db',
        logState,
        effectiveLanguage,
        confidenceInput: {
          mode: directDb.mode || 'db',
          rowCount: directDb.rowCount,
          sqlRowCount: directDb.sqlRowCount,
          sqlTruncated: Boolean(directDb.sqlTruncated),
          hasChart: Boolean(directDb.chartSpec || (Array.isArray(directDb.chartSpecs) && directDb.chartSpecs.length > 0)),
          intentScore: 0.85,
          intentLabel: 'nl_db'
        },
        extra: {
          chartSpec: directDb.chartSpec || null,
          chartSpecs: directDb.chartSpecs || null
        }
      });
      return true;
    }
  } catch {
    // fallback below
  }

  const fallback = finalizeResponse(buildSqlGuidanceResponse(effectiveLanguage), 'chat_guidance');
  rememberPendingSqlFromResponse(session.id, fallback);
  sendResponse({
    res,
    session,
    responseText: fallback,
    mode: 'chat_guidance',
    logState,
    effectiveLanguage,
    confidenceInput: { mode: 'chat_guidance', intentScore: 0.6, intentLabel: 'sql_guidance' }
  });
  return true;
};

const handleDefaultChat = async ({ session, effectiveLanguage, logState, res, message, resolvedContext, user }) => {
  try {
    const ragPreview = await retrieveRagMatches(message || '');
    const scopeCheck = enforceRagScope({ message, ragMatches: ragPreview?.matches || [], lang: effectiveLanguage });
    if (!scopeCheck.allowed) {
      logState.route = `rag_block_${scopeCheck.reason || 'policy'}`;
      const blocked = finalizeResponse(scopeCheck.response, 'chat_guidance');
      return buildHandlerResult({
        responseText: blocked,
        mode: 'chat_guidance',
        confidenceInput: { mode: 'chat_guidance', intentScore: 0.4, intentLabel: scopeCheck.reason },
        logPatch: {
          route: `rag_block_${scopeCheck.reason || 'policy'}`
        }
      });
    }

    logState.route = 'llm_chat';
    const focusModule = detectRequestedModule(message, resolvedContext) || resolvedContext?.module || resolvedContext?.workspaceContext?.module || 'overview';
    const knowledge = resolvedContext?.caseId
      ? await buildCaseKnowledgeContract(resolvedContext.caseId, { user, focusModule })
      : null;
    const caseContextPrompt = knowledge
      ? buildCaseContextPrompt(knowledge, { compact: true, focusModule })
      : '';
    const workspaceContextPrompt = buildWorkspaceContextPrompt(resolvedContext?.workspaceContext || null);
    const combinedContextPrompt = [caseContextPrompt, workspaceContextPrompt].filter(Boolean).join('\n\n');
    const streamState = getStreamState(res);

    let modelResponse;
    if (streamState?.active) {
      writeStreamEvent(res, { type: 'start', id: randomUUID(), sessionId: session.id, mode: 'chat' });
      modelResponse = await generateChatbotResponseStream(
        session.history,
        {
          language: effectiveLanguage,
          caseContextPrompt: combinedContextPrompt,
          mode: 'chat'
        },
        {
          onToken: (delta) => {
            if (!delta) return;
            writeStreamEvent(res, { type: 'delta', delta });
          }
        }
      );
    } else {
      modelResponse = await generateChatbotResponse(session.history, {
        language: effectiveLanguage,
        caseContextPrompt: combinedContextPrompt,
        mode: 'chat'
      });
    }

    let botResponse = finalizeResponse(modelResponse, 'chat');
    botResponse = appendSources(botResponse, knowledge, inferCitationTables(message, resolvedContext));
    rememberPendingSqlFromResponse(session.id, botResponse);
    return buildHandlerResult({
      responseText: botResponse,
      mode: 'chat',
      confidenceInput: {
        mode: 'chat',
        ragMatches: ragPreview?.matches || [],
        intentScore: ragPreview?.matches?.length ? 0.7 : null,
        intentLabel: ragPreview?.matches?.length ? 'rag_supported' : ''
      },
      logPatch: {
        route: 'llm_chat'
      }
    });
  } catch (error) {
    session.history.pop();
    touchSessionById(session.id);
    const detail = error?.message ? String(error.message) : String(error || '');
    const detailStack = error?.stack ? String(error.stack) : null;
    logState.action = 'chatbot_error';
    logState.mode = 'chat';
    logState.error = detail || 'Failed to communicate with AI model';
    sendErrorPayload(res, 503, {
      error: 'Failed to communicate with AI model. Ensure Ollama is running.',
      detail: detail || null,
      detailStack
    });
  }
};

const chatHandler = async (req, res) => {
  const startedAt = Date.now();
  const logState = {
    action: 'chatbot_response',
    sessionId: req.body?.sessionId || null,
    userMessage: req.body?.message || '',
    assistantResponse: '',
    mode: null,
    sql: null,
    sqlBlocked: false,
    sqlRowCount: null,
    sqlPreviewRows: null,
    error: null,
    route: null
  };

  res.on('finish', () => {
    const elapsedMs = Date.now() - startedAt;
    bumpRouteMetric(logState.route || logState.mode || 'unknown', elapsedMs);
    if (!CHATBOT_LOG_TO_DB) return;
    void logChatbotInteraction(req, { ...logState, elapsedMs });
  });

  try {
    const { message, sessionId, preferredLanguage, stream, workspaceContext: rawWorkspaceContext } = req.body || {};
    if (stream) {
      res.locals.chatbotStreamState = { active: true, completed: false };
      initializeStream(res);
    }
    const messageValidation = validateMessage(message);
    if (!messageValidation.ok) {
      logState.action = 'chatbot_error';
      logState.mode = 'validation';
      logState.error = messageValidation.error;
      return sendErrorPayload(res, 400, { error: messageValidation.error });
    }
    logState.userMessage = messageValidation.text;
    const requestedLanguage = normalizePreferredLanguage(preferredLanguage);

    if (!isSqlCommand(messageValidation.text) && looksLikePromptInjection(messageValidation.text)) {
      logState.action = 'chatbot_blocked';
      logState.mode = 'blocked';
      logState.error = 'blocked_by_policy';
      logState.route = 'blocked_policy';
      return sendErrorPayload(res, 403, {
        error: 'Request blocked by security policy. Hidden prompts, secrets, and environment data are not accessible.'
      });
    }

    const session = getSession(sessionId);
    logState.sessionId = session.id;
    if (stream) {
      writeStreamEvent(res, { type: 'session', sessionId: session.id });
    }
    session.history.push({ role: 'user', content: messageValidation.text });
    touchSessionById(session.id);
    const explicitTaggedCaseRefs = extractTaggedCaseRefs(messageValidation.text);
    const context = parseContextFromMessage(messageValidation.text);
    const entities = extractMessageEntities(messageValidation.text, context);
    const strictEffectiveLanguage = requestedLanguage || entities.language || 'en';

    if (explicitTaggedCaseRefs.length === 0) {
      const refusal = buildCaseGroundedRefusal('CASE_TAG_REQUIRED');
      logState.route = 'strict_case_tag_required';
      logState.mode = refusal.mode;
      logState.assistantResponse = refusal.responseText;
      await logStrictCaseGroundedQuery({
        req,
        session,
        caseId: null,
        message: messageValidation.text,
        routeUsed: logState.route,
        responseMode: refusal.mode,
        refusalCode: refusal.refusalCode,
        answerPayload: refusal.answerPayload,
        startedAt,
      });
      sendResponse({
        res,
        session,
        responseText: refusal.responseText,
        mode: refusal.mode,
        logState,
        effectiveLanguage: strictEffectiveLanguage,
        confidenceInput: { mode: refusal.mode, intentScore: 1, intentLabel: refusal.refusalCode || 'CASE_TAG_REQUIRED' },
        extra: { answerPayload: refusal.answerPayload, reasonCode: refusal.refusalCode }
      });
      return;
    }

    if (explicitTaggedCaseRefs.length > 1) {
      const refusal = buildCaseGroundedRefusal('MULTI_CASE_NOT_SUPPORTED');
      logState.route = 'strict_multi_case_refusal';
      logState.mode = refusal.mode;
      logState.assistantResponse = refusal.responseText;
      await logStrictCaseGroundedQuery({
        req,
        session,
        caseId: null,
        message: messageValidation.text,
        routeUsed: logState.route,
        responseMode: refusal.mode,
        refusalCode: refusal.refusalCode,
        answerPayload: refusal.answerPayload,
        startedAt,
        metadata: { taggedCaseRefs: explicitTaggedCaseRefs }
      });
      sendResponse({
        res,
        session,
        responseText: refusal.responseText,
        mode: refusal.mode,
        logState,
        effectiveLanguage: strictEffectiveLanguage,
        confidenceInput: { mode: refusal.mode, intentScore: 1, intentLabel: refusal.refusalCode || 'MULTI_CASE_NOT_SUPPORTED' },
        extra: { answerPayload: refusal.answerPayload, reasonCode: refusal.refusalCode }
      });
      return;
    }

    const strictCaseLookup = await resolveCaseReference({
      user: req.user || null,
      caseId: context?.caseId || null,
      firNumber: context?.fir || null,
      reference: explicitTaggedCaseRefs[0]
    });

    if (!strictCaseLookup?.caseRow || strictCaseLookup?.ambiguous) {
      const refusal = buildCaseGroundedRefusal('CASE_NOT_ACCESSIBLE');
      logState.route = 'strict_case_resolution_refusal';
      logState.mode = refusal.mode;
      logState.assistantResponse = refusal.responseText;
      await logStrictCaseGroundedQuery({
        req,
        session,
        caseId: null,
        message: messageValidation.text,
        routeUsed: logState.route,
        responseMode: refusal.mode,
        refusalCode: refusal.refusalCode,
        answerPayload: refusal.answerPayload,
        startedAt,
        metadata: { taggedCaseRef: explicitTaggedCaseRefs[0], ambiguous: Boolean(strictCaseLookup?.ambiguous) }
      });
      sendResponse({
        res,
        session,
        responseText: refusal.responseText,
        mode: refusal.mode,
        logState,
        effectiveLanguage: strictEffectiveLanguage,
        confidenceInput: { mode: refusal.mode, intentScore: 1, intentLabel: refusal.refusalCode || 'CASE_NOT_ACCESSIBLE' },
        extra: { answerPayload: refusal.answerPayload, reasonCode: refusal.refusalCode }
      });
      return;
    }

    const strictCase = strictCaseLookup.caseRow;
    const strictCaseId = Number(strictCase.id);
    const strictCaseLabel = strictCase.case_name || strictCase.case_number || `Case ${strictCase.id}`;
    const strictModuleHint = entities.module || String(context?.module || '').trim().toLowerCase() || null;
    updateSessionState(session.id, {
      language: strictEffectiveLanguage,
      lastTaggedCaseId: strictCaseId,
      lastTaggedCaseLabel: strictCaseLabel,
      workspaceContext: rawWorkspaceContext || null
    });

    const strictResult = isStrictCaseSummaryIntent(messageValidation.text)
      ? await buildCaseSummaryAnswer({ caseId: strictCaseId, message: messageValidation.text })
      : await buildExactCaseAnswer({
        caseId: strictCaseId,
        caseLabel: strictCaseLabel,
        message: messageValidation.text,
        moduleHint: strictModuleHint
      });

    logState.route = strictResult.mode === 'summary' ? 'strict_case_summary' : `strict_case_${strictResult.mode}`;
    logState.mode = strictResult.mode;
    logState.assistantResponse = strictResult.responseText;
    await logStrictCaseGroundedQuery({
      req,
      session,
      caseId: strictCaseId,
      message: messageValidation.text,
      routeUsed: logState.route,
      responseMode: strictResult.mode,
      refusalCode: strictResult.refusalCode || null,
      answerPayload: strictResult.answerPayload,
      startedAt,
      metadata: {
        taggedCaseRef: explicitTaggedCaseRefs[0],
        moduleHint: strictModuleHint,
        caseLabel: strictCaseLabel
      }
    });
    sendResponse({
      res,
      session,
      responseText: strictResult.responseText,
      mode: strictResult.mode,
      logState,
      effectiveLanguage: strictEffectiveLanguage,
      confidenceInput: {
        mode: strictResult.mode,
        intentScore: 0.98,
        intentLabel: strictResult.refusalCode || (strictResult.mode === 'summary' ? 'strict_case_summary' : 'strict_case_exact')
      },
      extra: {
        answerPayload: strictResult.answerPayload,
        reasonCode: strictResult.refusalCode || null,
        caseId: strictCaseId,
        caseLabel: strictCaseLabel
      }
    });
    return;
    let workspaceContext = mergeWorkspaceContext(session.state || {}, rawWorkspaceContext);
    const hasExplicitCaseContext = Boolean(
      context?.caseId
      || context?.caseName
      || context?.fir
      || entities?.caseId
      || entities?.caseName
      || entities?.fir
      || entities?.taggedCaseRef
    );
    const hasLockedSessionCase = Boolean(
      session.state?.caseId
      || session.state?.caseName
      || session.state?.caseNumber
      || session.state?.fir
      || session.state?.taggedCaseRef
      || workspaceContext?.caseId
    );
    let resolvedContext = mergeSessionEntities(session.state || {}, entities);
    if (entities?.taggedCaseRef) {
      resolvedContext = {
        ...resolvedContext,
        caseId: null,
        caseName: null
      };
    }
    if (!hasExplicitCaseContext && !hasLockedSessionCase) {
      resolvedContext = {
        ...resolvedContext,
        caseId: null,
        caseName: null,
        caseNumber: null,
        fir: null,
        taggedCaseRef: null
      };
    }
    if (workspaceContext?.caseId && !resolvedContext.caseId) {
      resolvedContext = {
        ...resolvedContext,
        caseId: workspaceContext.caseId
      };
    }
    resolvedContext = await hydrateResolvedContext(resolvedContext, req.user || null);
    workspaceContext = normalizeWorkspaceContext({
      ...(workspaceContext || {}),
      caseId: resolvedContext.caseId || workspaceContext?.caseId || null,
      caseTag: resolvedContext.caseNumber || resolvedContext.caseName || workspaceContext?.caseTag || null,
      module: workspaceContext?.module || resolvedContext.module || null
    });
    resolvedContext = {
      ...resolvedContext,
      module: workspaceContext?.module || resolvedContext.module || null,
      workspaceContext
    };
    const effectiveLanguage = requestedLanguage || resolvedContext.language || 'en';
    updateSessionState(session.id, { ...resolvedContext, workspaceContext, language: effectiveLanguage });

    if (Array.isArray(resolvedContext.ambiguousCases) && resolvedContext.ambiguousCases.length > 0) {
      logState.route = 'ambiguous_case_match';
      const botResponse = buildAmbiguousCaseResponse(resolvedContext.ambiguousCases);
      sendResponse({
        res,
        session,
        responseText: botResponse,
        mode: 'chat_guidance',
        logState,
        effectiveLanguage,
        confidenceInput: { mode: 'chat_guidance', intentScore: 0.8, intentLabel: 'ambiguous_case_match' }
      });
      return;
    }

    if (!resolvedContext.caseId) {
      logState.route = 'missing_case_context';
      const availableCases = await searchCasesForChat({
        user: req.user || null,
        query: '',
        limit: 6
      });
      const botResponse = buildCaseGuardrailResponse(effectiveLanguage);
      sendResponse({
        res,
        session,
        responseText: botResponse,
        mode: 'chat_guidance',
        logState,
        effectiveLanguage,
        confidenceInput: { mode: 'chat_guidance', intentScore: 0.9, intentLabel: 'missing_case_context' },
        extra: {
          suggestionMode: 'missing_case_context',
          caseSuggestions: availableCases.map(toCompactCaseSuggestion)
        }
      });
      return;
    }

    // ─── Planner: classify intent + build scope + route deterministically ───
    const initialPlan = generatePlan(messageValidation.text, {
      resolvedContext,
      workspaceContext,
      sessionState: session.state || {},
      hasPendingSql: Boolean(session.state?.pendingSql)
    });
    const plan = applyFollowUpResolution(initialPlan, session.state || {});

    // Annotate logState with planner fields
    Object.assign(logState, plan.logFields);
    logState.groundability = plan.intent.groundability?.bucket || null;

    if (plan.unresolvedFollowUp) {
      const clarificationPayload = buildClarificationAnswerPayload({
        title: plan.unresolvedFollowUp.title || 'Clarify Follow-up',
        shortAnswer: plan.unresolvedFollowUp.shortAnswer
          || 'I need a little more grounded context before I can continue this follow-up.',
        caseId: resolvedContext?.caseId || session.state?.lastCaseId || null,
        caseLabel: resolvedContext?.caseName || resolvedContext?.caseLabel || null,
        workspaceContext
      });
      dispatchHandlerResult({
        result: buildHandlerResult({
          responseText: clarificationPayload.markdown,
          mode: 'db_summary',
          answerPayload: clarificationPayload,
          confidenceInput: {
            mode: 'db_summary',
            intentScore: 0.78,
            intentLabel: plan.unresolvedFollowUp.reason || 'follow_up_clarification'
          },
          logPatch: {
            route: 'follow_up_clarification'
          }
        }),
        res,
        session,
        logState,
        effectiveLanguage,
        plan
      });
      return;
    }

    // Fast-path: chit-chat rejection
    if (plan.intent.type === 'chit_chat') {
      logState.route = 'irrelevant_case_question';
      const botResponse = buildIrrelevantCaseQuestionResponse(effectiveLanguage);
      sendResponse({
        res,
        session,
        responseText: botResponse,
        mode: 'chat_guidance',
        logState,
        effectiveLanguage,
        confidenceInput: { mode: 'chat_guidance', intentScore: plan.intent.confidence, intentLabel: 'irrelevant_case_question' },
        extra: {
          suggestionMode: 'irrelevant_case_question',
          caseSuggestions: null
        }
      });
      return;
    }

    const effectiveMessage = plan.messageOverride || messageValidation.text;
    const effectiveWorkspaceContext = plan.workspaceContextOverride
      ? normalizeWorkspaceContext(plan.workspaceContextOverride)
      : workspaceContext;
    const effectiveResolvedContext = {
      ...resolvedContext,
      module: plan.scope?.module || resolvedContext.module || effectiveWorkspaceContext?.module || null,
      workspaceContext: effectiveWorkspaceContext || resolvedContext.workspaceContext || null
    };

    // Build unified handler context object
    const handlerCtx = {
      message: effectiveMessage,
      session,
      resolvedContext: effectiveResolvedContext,
      effectiveLanguage,
      logState,
      res,
      user: req.user || null,
      context,
      plan,
      queryOptions: plan.queryOptions || {}
    };

    // Handler dispatch table
    const handlers = {
      handlePendingSql: () => handlePendingSql(handlerCtx),
      handleSqlCommand: () => handleSqlCommand(handlerCtx),
      handleSimpleGreeting: () => handleSimpleGreeting(handlerCtx),
      handleChitChatRejection: () => false, // already handled above
      handleWorkspaceAwareResponse: () => handleWorkspaceAwareResponse(handlerCtx),
      handleDeterministicCaseFact: () => handleDeterministicCaseFact(handlerCtx),
      handleDeterministicCaseInsight: () => handleDeterministicCaseInsight(handlerCtx),
      handleCaseAwareSummary: () => handleCaseAwareSummary(handlerCtx),
      handleFirSummary: () => handleFirSummary(handlerCtx),
      handleCrimePrediction: () => handleCrimePrediction(handlerCtx),
      handleOpenCdr: () => handleOpenCdr(handlerCtx),
      handleDirectDbRequest: () => handleDirectDbRequest(handlerCtx),
      handleDefaultChat: () => handleDefaultChat({ ...handlerCtx, message: effectiveMessage })
    };

    // Try primary handler first
    const primaryFn = handlers[plan.primaryHandler];
    const primaryResult = primaryFn ? await primaryFn() : null;
    if (dispatchHandlerResult({
      result: primaryResult,
      res,
      session,
      logState,
      effectiveLanguage,
      plan
    })) {
      return;
    }

    // Fallback chain
    for (const fallbackName of plan.fallbacks) {
      const fallbackFn = handlers[fallbackName];
      const fallbackResult = fallbackFn ? await fallbackFn() : null;
      logState.planner_fallback = fallbackName;
      if (dispatchHandlerResult({
        result: fallbackResult,
        res,
        session,
        logState,
        effectiveLanguage,
        plan
      })) {
        return;
      }
      delete logState.planner_fallback;
    }

    // Last resort: default chat (LLM)
    const defaultResult = await handleDefaultChat({ ...handlerCtx, message: effectiveMessage });
    dispatchHandlerResult({
      result: defaultResult,
      res,
      session,
      logState,
      effectiveLanguage,
      plan
    });
  } catch (error) {
    console.error('Chatbot handler error:', error);
    logState.action = 'chatbot_error';
    logState.mode = 'chatbot';
    logState.error = 'Internal Chatbot Error';
    logState.route = logState.route || 'internal_error';
    return sendErrorPayload(res, 500, { error: 'Internal Chatbot Error' });
  }
};

const intentHandler = async (req, res) => {
  const { query, file_id, case_id, case_name, case_type, sessionId, preferredLanguage, stream, workspaceContext } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query is required' });

  const context = [];
  if (case_id) context.push(`Case ID: ${case_id}`);
  if (case_name) context.push(`Case Name: ${case_name}`);
  if (case_type) context.push(`Case Type: ${case_type}`);
  if (file_id) context.push(`File ID: ${file_id}`);

  const trimmedQuery = String(query).trim();
  let message = trimmedQuery;
  if (!isSqlCommand(trimmedQuery) && context.length > 0) {
    message = `Context:\n${context.join('\n')}\n\nUser: ${trimmedQuery}`;
  }
  return chatHandler({
    body: { message, sessionId, preferredLanguage, stream, workspaceContext },
    headers: req.headers,
    ip: req.ip,
    user: req.user || null,
    locals: req.locals || {}
  }, res);
};

const isStrictCaseSummaryIntent = (message = '') =>
  /\b(summary|summarize|overview|brief|briefing|highlights|snapshot)\b/i.test(String(message || ''));

const logStrictCaseGroundedQuery = async ({
  req,
  session,
  caseId,
  message,
  routeUsed,
  responseMode,
  refusalCode = null,
  answerPayload = null,
  startedAt,
  metadata = {},
}) => {
  await logCaseChatQuery({
    caseId,
    userId: req.user?.id || null,
    sessionId: session?.id || null,
    queryText: message,
    routeUsed,
    responseMode,
    refusalCode,
    latencyMs: Date.now() - startedAt,
    freshness: answerPayload?.debugMeta?.freshness || {},
    metadata,
  });
};

const resolveCaseForCaseContextRoute = async (req, res) => {
  const caseId = Number(req.query.caseId || req.query.case_id || 0);
  const caseRef = String(req.query.caseRef || req.query.case_name || '').trim();
  const resolved = await resolveCaseReference({
    user: req.user || null,
    caseId: Number.isFinite(caseId) && caseId > 0 ? caseId : null,
    reference: caseRef || null,
  });

  if (!resolved?.caseRow || resolved?.ambiguous) {
    res.status(404).json({
      mode: 'refusal',
      reasonCode: 'CASE_NOT_ACCESSIBLE',
      error: 'Tagged case could not be resolved.',
    });
    return null;
  }

  return resolved.caseRow;
};

router.get('/case-context/summary', async (req, res) => {
  const caseRow = await resolveCaseForCaseContextRoute(req, res);
  if (!caseRow) return;
  const module = String(req.query.module || '').trim().toLowerCase() || null;
  const data = await getCaseContextSummary({ caseId: caseRow.id, module });
  res.json({
    mode: data ? 'summary' : 'refusal',
    caseId: String(caseRow.id),
    caseLabel: caseRow.case_name || caseRow.case_number || `Case ${caseRow.id}`,
    module,
    data,
  });
});

router.get('/case-context/scalar', async (req, res) => {
  const caseRow = await resolveCaseForCaseContextRoute(req, res);
  if (!caseRow) return;
  const module = String(req.query.module || '').trim().toLowerCase();
  const metricKey = String(req.query.metricKey || '').trim();
  if (!module || !metricKey) {
    return res.status(400).json({ error: 'module and metricKey are required' });
  }
  const data = await getCaseContextScalar({ caseId: caseRow.id, module, metricKey });
  res.json({
    mode: data ? 'exact' : 'refusal',
    caseId: String(caseRow.id),
    caseLabel: caseRow.case_name || caseRow.case_number || `Case ${caseRow.id}`,
    module,
    metricKey,
    data,
  });
});

router.get('/case-context/top-entities', async (req, res) => {
  const caseRow = await resolveCaseForCaseContextRoute(req, res);
  if (!caseRow) return;
  const module = String(req.query.module || '').trim().toLowerCase();
  const metricKey = String(req.query.metricKey || '').trim();
  const entityType = String(req.query.entityType || '').trim();
  const limit = Math.max(1, Math.min(50, Number(req.query.limit || 5)));
  if (!module || !metricKey || !entityType) {
    return res.status(400).json({ error: 'module, metricKey and entityType are required' });
  }
  const rows = await getCaseContextTopEntities({ caseId: caseRow.id, module, metricKey, entityType, limit });
  res.json({
    mode: rows.length ? 'exact' : 'refusal',
    caseId: String(caseRow.id),
    caseLabel: caseRow.case_name || caseRow.case_number || `Case ${caseRow.id}`,
    module,
    metricKey,
    entityType,
    rows,
  });
});

router.get('/case-context/time-series', async (req, res) => {
  const caseRow = await resolveCaseForCaseContextRoute(req, res);
  if (!caseRow) return;
  const module = String(req.query.module || '').trim().toLowerCase();
  const metricKey = String(req.query.metricKey || '').trim();
  if (!module || !metricKey) {
    return res.status(400).json({ error: 'module and metricKey are required' });
  }
  const rows = await getCaseContextTimeSeries({ caseId: caseRow.id, module, metricKey });
  res.json({
    mode: rows.length ? 'exact' : 'refusal',
    caseId: String(caseRow.id),
    caseLabel: caseRow.case_name || caseRow.case_number || `Case ${caseRow.id}`,
    module,
    metricKey,
    rows,
  });
});

router.get('/case-context/geo-facts', async (req, res) => {
  const caseRow = await resolveCaseForCaseContextRoute(req, res);
  if (!caseRow) return;
  const module = String(req.query.module || '').trim().toLowerCase();
  const dimensionKey = String(req.query.dimensionKey || req.query.dimension || '').trim();
  const limit = Math.max(1, Math.min(50, Number(req.query.limit || 10)));
  if (!module || !dimensionKey) {
    return res.status(400).json({ error: 'module and dimensionKey are required' });
  }
  const rows = await getCaseContextGeoFacts({ caseId: caseRow.id, module, dimensionKey, limit });
  res.json({
    mode: rows.length ? 'exact' : 'refusal',
    caseId: String(caseRow.id),
    caseLabel: caseRow.case_name || caseRow.case_number || `Case ${caseRow.id}`,
    module,
    dimensionKey,
    rows,
  });
});

router.get('/case-context/artifact', async (req, res) => {
  const caseRow = await resolveCaseForCaseContextRoute(req, res);
  if (!caseRow) return;
  const module = String(req.query.module || 'global').trim().toLowerCase() || 'global';
  const artifactKey = String(req.query.artifactKey || 'case-summary.json').trim();
  const artifact = await readCaseKnowledgeArtifact({ caseId: caseRow.id, module, artifactKey });
  res.json({
    mode: artifact ? 'summary' : 'refusal',
    caseId: String(caseRow.id),
    caseLabel: caseRow.case_name || caseRow.case_number || `Case ${caseRow.id}`,
    module,
    artifactKey,
    artifact,
  });
});

router.get('/case-context/cross-module-overlap', async (req, res) => {
  const caseRow = await resolveCaseForCaseContextRoute(req, res);
  if (!caseRow) return;
  const entityValue = String(req.query.entityValue || '').trim();
  if (!entityValue) {
    return res.status(400).json({ error: 'entityValue is required' });
  }
  const rows = await getCrossModuleOverlap({ caseId: caseRow.id, entityValue });
  res.json({
    mode: rows.length ? 'exact' : 'refusal',
    caseId: String(caseRow.id),
    caseLabel: caseRow.case_name || caseRow.case_number || `Case ${caseRow.id}`,
    entityValue,
    rows,
  });
});

router.get('/health', async (_req, res) => {
  let db = 'down';
  try {
    await pool.query('SELECT 1');
    db = 'up';
  } catch {
    db = 'down';
  }

  return res.json({
    status: 'ok',
    chatbot: 'active',
    model: OLLAMA_MODEL,
    db,
    timestamp: new Date().toISOString()
  });
});

router.get('/diagnostics', async (req, res) => {
  if (!CHATBOT_DIAGNOSTICS_ENABLED) {
    return res.status(404).json({ error: 'Not found' });
  }

  let db = 'down';
  try {
    await pool.query('SELECT 1');
    db = 'up';
  } catch {
    db = 'down';
  }

  return res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    model: OLLAMA_MODEL,
    db,
    rateLimit: {
      enabled: CHATBOT_RATE_LIMIT_ENABLED,
      windowMs: CHATBOT_RATE_LIMIT_WINDOW_MS,
      max: CHATBOT_RATE_LIMIT_MAX
    },
    caches: {
      readOnlySql: getDbQueryCacheStats(),
      deterministicInsights: getDeterministicCacheStats()
    },
    routing: summarizeRouteMetrics(),
    logging: {
      enabled: CHATBOT_LOG_TO_DB,
      maxText: CHATBOT_LOG_MAX_TEXT
    },
    requester: {
      ip: String(req.ip || ''),
      userAgent: String(req.headers['user-agent'] || '')
    }
  });
});

router.get('/rag/preview', async (req, res) => {
  if (!CHATBOT_DIAGNOSTICS_ENABLED) {
    return res.status(404).json({ error: 'Not found' });
  }

  const q = String(req.query.q || req.query.query || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    const out = await retrieveRagMatches(q);
    return res.json({
      query: q,
      topK: out?.matches?.length || 0,
      matches: out?.matches || [],
      context: out?.context || ''
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'RAG preview failed' });
  }
});

router.get('/capabilities', (_req, res) => {
  res.json({
    model: OLLAMA_MODEL,
    features: [
      'chat_assistant',
      'multilingual_reply_control',
      'fir_summary_from_db',
      'natural_language_db_query',
      'context_memory_for_followups',
      'entity_extraction',
      'open_cdr_fir_guidance',
      'read_only_sql_mode_via_/sql',
      'criminal_activity_prediction',
      'risk_signal_explanations',
      'session_memory',
      'confidence_score'
    ],
    modes: ['chat', 'chat_guidance', 'db_summary', 'db', 'prediction'],
    notes: ['Use `/sql SELECT ...` for live database rows']
  });
});

router.get('/session/:id', (req, res) => {
  const meta = getSessionMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Session not found' });
  return res.json(meta);
});

router.get('/logs/recent', async (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  try {
    const result = await pool.query(
      `
        SELECT id, user_id, officer_buckle_id, officer_name, session_id, action, resource_type, resource_id, details, created_at
        FROM audit_logs
        WHERE resource_type = 'chatbot' OR action IN ('chatbot_message', 'chatbot_response', 'chatbot_error', 'chatbot_blocked')
        ORDER BY created_at DESC, id DESC
        LIMIT $1
      `,
      [limit]
    );
    return res.json({ rows: result.rows });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/session/:id', (req, res) => {
  const deleted = clearSession(req.params.id);
  return res.json({ success: deleted });
});

router.post('/', rateLimit, chatHandler);
router.post('/message', rateLimit, chatHandler);
router.all('/intent', rateLimit, intentHandler);
router.post('/intent/stream', rateLimit, (req, res) => {
  req.body = { ...(req.body || {}), stream: true };
  return intentHandler(req, res);
});
router.get('/', (_req, res) => res.json({ status: 'Chatbot active', model: OLLAMA_MODEL }));

router.all('*', (req, res) => {
  res.status(404).json({ error: `Chatbot endpoint not found: ${req.originalUrl}` });
});

export default router;
