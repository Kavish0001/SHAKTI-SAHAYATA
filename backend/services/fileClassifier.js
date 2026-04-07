import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPPING_DIR_CANDIDATES = [
  path.resolve(__dirname, '../mappings'),
  path.resolve(__dirname, '../../frontend/src/components/utils/mappings')
];
const MAX_HEADER_SCAN_ROWS = 40;

const TYPE_LABELS = {
  cdr: 'CDR',
  ipdr: 'IPDR',
  sdr: 'SDR',
  tower_dump: 'Tower Dump',
  ild: 'ILD'
};

const GROUP_LABELS = {
  a_party: 'calling number',
  b_party: 'called number',
  call_date: 'call date',
  call_time: 'call time',
  duration: 'duration',
  duration_sec: 'duration',
  source_ip: 'source IP address',
  start_time: 'start time',
  source_port: 'source port',
  translated_ip: 'translated IP address',
  destination_ip: 'destination IP address',
  msisdn: 'MSISDN / telephone number',
  subscriber_name: 'subscriber name',
  activation_date: 'activation date',
  address: 'address',
  country_code: 'country',
  imei: 'IMEI',
  imsi: 'IMSI',
  cell_id: 'cell ID'
};

const loadMappingFile = (fileName) => {
  for (const mappingDir of MAPPING_DIR_CANDIDATES) {
    try {
      const filePath = path.join(mappingDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      // Try the next candidate directory.
    }
  }

  return {};
};

const CDR_MAPPING = loadMappingFile('cdrMapping.json');
const IPDR_MAPPING = loadMappingFile('ipdrMapping.json');
const SDR_MAPPING = loadMappingFile('sdrMapping.json');
const ILD_MAPPING = loadMappingFile('ildMapping.json');
const TOWER_MAPPING = loadMappingFile('towerDumpMapping.json');

const SAMPLE_HEADER_ALIASES = {
  sdr: {
    msisdn: ['Mobile Number', 'Mobile No', 'Telephone Number'],
    activation_date: ['Activation Date'],
    address: ['Permanent Address of the Subscriber']
  },
  ild: {
    a_party: ['ILD', 'ILD Number']
  },
  ipdr: {
    start_time: ['Session_Start_Time', 'Event_Start_Time']
  }
};

function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[\r\n]+/g, ' ')
    .replace(/[_\-()]+/g, ' ')
    .replace(/[^a-z0-9\s/:.&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqNormalized(values = []) {
  return [...new Set(values.map((value) => normalizeHeader(value)).filter(Boolean))];
}

function getMappingAliases(mapping, ...keys) {
  const values = [];
  keys.forEach((key) => {
    const entry = mapping?.[key];
    if (Array.isArray(entry)) values.push(...entry);
    if (typeof entry === 'string') values.push(entry);
    values.push(key);
  });
  return uniqNormalized(values);
}

function buildTemplate({ required, optional = [], groups }) {
  const normalizedGroups = {};
  Object.entries(groups).forEach(([groupName, aliases]) => {
    normalizedGroups[groupName] = uniqNormalized(aliases);
  });

  return {
    required,
    optional,
    groups: normalizedGroups
  };
}

const FILE_TEMPLATES = {
  cdr: buildTemplate({
    required: ['a_party', 'b_party', 'call_date', 'duration'],
    optional: ['call_time', 'cell_id', 'call_type', 'imei', 'imsi'],
    groups: {
      a_party: getMappingAliases(CDR_MAPPING, 'Calling No'),
      b_party: getMappingAliases(CDR_MAPPING, 'Called No'),
      call_date: getMappingAliases(CDR_MAPPING, 'Date'),
      call_time: getMappingAliases(CDR_MAPPING, 'Time'),
      duration: uniqNormalized([
        ...getMappingAliases(CDR_MAPPING, 'Dur(s)'),
        'Call Duration',
        'Duration'
      ]),
      cell_id: uniqNormalized([
        ...getMappingAliases(CDR_MAPPING, 'First Cell ID'),
        ...getMappingAliases(CDR_MAPPING, 'Last Cell ID')
      ]),
      call_type: getMappingAliases(CDR_MAPPING, 'Call Type'),
      imei: getMappingAliases(CDR_MAPPING, 'IMEI'),
      imsi: getMappingAliases(CDR_MAPPING, 'IMSI')
    }
  }),
  ipdr: buildTemplate({
    required: ['source_ip', 'start_time'],
    optional: ['source_port', 'translated_ip', 'destination_ip', 'msisdn', 'imei', 'imsi', 'cell_id'],
    groups: {
      source_ip: getMappingAliases(IPDR_MAPPING, 'Source IP Address'),
      start_time: uniqNormalized([
        ...getMappingAliases(IPDR_MAPPING, 'TIME1 (dd/MM/yyyy HH:mm:ss)'),
        ...getMappingAliases(IPDR_MAPPING, 'Start Time'),
        ...getMappingAliases(IPDR_MAPPING, 'Event Start Time'),
        ...getMappingAliases(IPDR_MAPPING, 'Start Date of Public IP Address allocation (dd/mm/yyyy)'),
        ...getMappingAliases(IPDR_MAPPING, 'IST Start Time of Public IP address allocation (hh:mm:ss)'),
        ...SAMPLE_HEADER_ALIASES.ipdr.start_time
      ]),
      source_port: getMappingAliases(IPDR_MAPPING, 'Source Port'),
      translated_ip: getMappingAliases(IPDR_MAPPING, 'Translated IP Address'),
      destination_ip: getMappingAliases(IPDR_MAPPING, 'Destination IP Address'),
      msisdn: uniqNormalized([
        ...getMappingAliases(IPDR_MAPPING, 'MSISDN / User ID'),
        ...getMappingAliases(IPDR_MAPPING, 'Subscriber User ID')
      ]),
      imei: getMappingAliases(IPDR_MAPPING, 'IMEI'),
      imsi: getMappingAliases(IPDR_MAPPING, 'IMSI'),
      cell_id: getMappingAliases(IPDR_MAPPING, 'First Cell ID')
    }
  }),
  sdr: buildTemplate({
    required: ['msisdn', 'subscriber_name'],
    optional: ['activation_date', 'address', 'imei', 'imsi', 'email'],
    groups: {
      msisdn: uniqNormalized([
        ...getMappingAliases(SDR_MAPPING, 'TelephoneNumber'),
        ...SAMPLE_HEADER_ALIASES.sdr.msisdn
      ]),
      subscriber_name: getMappingAliases(SDR_MAPPING, 'Name of Subscriber'),
      activation_date: uniqNormalized([
        ...getMappingAliases(SDR_MAPPING, 'Date of Activation'),
        ...getMappingAliases(SDR_MAPPING, 'SIM Activation Date'),
        ...SAMPLE_HEADER_ALIASES.sdr.activation_date
      ]),
      address: uniqNormalized([
        ...getMappingAliases(SDR_MAPPING, 'Local Address'),
        ...getMappingAliases(SDR_MAPPING, 'Permanent Address'),
        ...SAMPLE_HEADER_ALIASES.sdr.address
      ]),
      imei: getMappingAliases(SDR_MAPPING, 'IMEI'),
      imsi: getMappingAliases(SDR_MAPPING, 'IMSI'),
      email: getMappingAliases(SDR_MAPPING, 'Email ID')
    }
  }),
  tower_dump: buildTemplate({
    required: ['cell_id', 'imsi'],
    optional: ['a_party', 'b_party', 'call_date', 'call_time', 'duration', 'imei'],
    groups: {
      cell_id: uniqNormalized([
        ...getMappingAliases(TOWER_MAPPING, 'First Cell ID'),
        ...getMappingAliases(TOWER_MAPPING, 'Last Cell ID')
      ]),
      imsi: getMappingAliases(TOWER_MAPPING, 'IMSI'),
      a_party: getMappingAliases(TOWER_MAPPING, 'Calling No'),
      b_party: getMappingAliases(TOWER_MAPPING, 'Called No'),
      call_date: getMappingAliases(TOWER_MAPPING, 'Date'),
      call_time: getMappingAliases(TOWER_MAPPING, 'Time'),
      duration: uniqNormalized([
        ...getMappingAliases(TOWER_MAPPING, 'Dur(s)'),
        'Call Duration',
        'Duration'
      ]),
      imei: getMappingAliases(TOWER_MAPPING, 'IMEI')
    }
  }),
  ild: buildTemplate({
    required: ['a_party', 'b_party', 'country_code'],
    optional: ['call_date', 'call_time', 'duration', 'call_type', 'imei', 'imsi'],
    groups: {
      a_party: uniqNormalized([
        ...getMappingAliases(ILD_MAPPING, 'Calling No'),
        ...SAMPLE_HEADER_ALIASES.ild.a_party
      ]),
      b_party: getMappingAliases(ILD_MAPPING, 'Called No'),
      country_code: uniqNormalized(['Country', 'Country Code', 'Destination Country', 'Intl Code']),
      call_date: getMappingAliases(ILD_MAPPING, 'Date'),
      call_time: getMappingAliases(ILD_MAPPING, 'Time'),
      duration: getMappingAliases(ILD_MAPPING, 'Dur(s)'),
      call_type: getMappingAliases(ILD_MAPPING, 'Call Type'),
      imei: getMappingAliases(ILD_MAPPING, 'IMEI'),
      imsi: getMappingAliases(ILD_MAPPING, 'IMSI')
    }
  })
};

function parseDelimitedLine(line, delimiter) {
  const row = [];
  let current = '';
  let inQuotes = false;

  for (const char of String(line || '')) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      row.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }

  row.push(current.trim().replace(/^"|"$/g, ''));
  return row;
}

function detectDelimiter(lines) {
  const delimiters = [',', '|', ';', '\t', '!'];
  let bestDelimiter = ',';
  let bestScore = -1;

  for (const delimiter of delimiters) {
    const columnCounts = lines.map((line) => parseDelimitedLine(line, delimiter).filter(Boolean).length);
    const averageColumns = columnCounts.reduce((sum, count) => sum + count, 0) / Math.max(columnCounts.length, 1);
    if (averageColumns > bestScore) {
      bestScore = averageColumns;
      bestDelimiter = delimiter;
    }
  }

  return bestDelimiter;
}

function readCandidateRows(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();

  if (ext === '.csv') {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    const sample = lines.slice(0, MAX_HEADER_SCAN_ROWS);
    const delimiter = detectDelimiter(sample);
    return sample.map((line) => parseDelimitedLine(line, delimiter));
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.readFile(filePath, { cellDates: false, raw: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });
    return rows
      .slice(0, MAX_HEADER_SCAN_ROWS)
      .map((row) => (Array.isArray(row) ? row.map((cell) => String(cell || '').trim()) : []));
  }

  return [];
}

function scoreAgainstTemplate(headers, template) {
  const normalizedHeaders = uniqNormalized(headers);
  const hitsByGroup = {};

  for (const [groupName, aliases] of Object.entries(template.groups)) {
    const matchedAlias = aliases.find((alias) => normalizedHeaders.includes(alias));
    if (matchedAlias) hitsByGroup[groupName] = matchedAlias;
  }

  const matchedGroups = Object.keys(hitsByGroup);
  const totalGroups = [...template.required, ...template.optional].length;
  const requiredMatched = template.required.filter((group) => hitsByGroup[group]).length;
  const requiredCoverage = template.required.length > 0 ? requiredMatched / template.required.length : 0;
  const confidence = totalGroups > 0 ? matchedGroups.length / totalGroups : 0;
  const missingRequired = template.required.filter((group) => !hitsByGroup[group]);

  return {
    matched: matchedGroups.length,
    total: totalGroups,
    matchedHeaders: matchedGroups.map((group) => hitsByGroup[group]),
    matchedGroups,
    confidence,
    requiredCoverage,
    missingRequired
  };
}

function scoreHeaderCandidate(headers, expectedType = '') {
  const trimmedHeaders = headers.map((header) => String(header || '').trim()).filter(Boolean);
  if (trimmedHeaders.length === 0) return Number.NEGATIVE_INFINITY;

  const alphaHeaders = trimmedHeaders.filter((header) => /[a-z]/i.test(header)).length;
  const scores = Object.values(FILE_TEMPLATES).map((template) => scoreAgainstTemplate(trimmedHeaders, template));
  const maxConfidence = scores.reduce((max, score) => Math.max(max, score.confidence), 0);
  const maxRequiredCoverage = scores.reduce((max, score) => Math.max(max, score.requiredCoverage), 0);

  let score = maxConfidence * 10 + maxRequiredCoverage * 5 + alphaHeaders / trimmedHeaders.length;
  if (expectedType && FILE_TEMPLATES[expectedType]) {
    const expectedScore = scoreAgainstTemplate(trimmedHeaders, FILE_TEMPLATES[expectedType]);
    score += expectedScore.confidence * 5 + expectedScore.requiredCoverage * 5;
  }

  return score;
}

function typeLabel(type) {
  return TYPE_LABELS[type] || String(type || '').toUpperCase() || 'Unknown';
}

function groupLabel(groupName) {
  return GROUP_LABELS[groupName] || groupName.replace(/_/g, ' ');
}

function buildWrongTypeMessage(expectedType, detectedType) {
  return `This looks like a ${typeLabel(detectedType)} file. Please upload it in the ${typeLabel(detectedType)} section instead of ${typeLabel(expectedType)}.`;
}

function buildRejectedMessage(expectedType, missingRequired = []) {
  const missingLabels = missingRequired.map(groupLabel);
  const suffix = missingLabels.length > 0
    ? ` Missing required ${typeLabel(expectedType)} fields: ${missingLabels.join(', ')}.`
    : '';
  return `This file does not match the ${typeLabel(expectedType)} normalization.${suffix}`;
}

export function extractHeadersFromFile(filePath, expectedType = '') {
  const rows = readCandidateRows(filePath);
  if (rows.length === 0) return [];

  const normalizedExpectedType = String(expectedType || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

  let bestHeaders = rows[0];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const row of rows) {
    const score = scoreHeaderCandidate(row, normalizedExpectedType);
    if (score > bestScore) {
      bestScore = score;
      bestHeaders = row;
    }
  }

  return bestHeaders.map((header) => String(header || '').trim()).filter(Boolean);
}

export function classifyFile(headers, expectedType) {
  const normalizedExpectedType = String(expectedType || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  const scores = {};
  let bestType = null;
  let bestScore = 0;
  let bestRequiredCoverage = -1;
  let bestRank = -1;

  for (const [type, template] of Object.entries(FILE_TEMPLATES)) {
    const score = scoreAgainstTemplate(headers, template);
    scores[type] = score;
    const rank = score.confidence + score.requiredCoverage * 1.5;
    if (
      rank > bestRank
      || (rank === bestRank && score.confidence > bestScore)
    ) {
      bestRank = rank;
      bestScore = score.confidence;
      bestType = type;
      bestRequiredCoverage = score.requiredCoverage;
    }
  }

  const expectedScore = scores[normalizedExpectedType];
  const bestMetrics = bestType ? scores[bestType] : null;
  const totalColumns = Array.isArray(headers) ? headers.length : 0;

  if (!expectedScore || expectedScore.confidence < 0.15) {
    if (bestType && bestScore >= 0.3) {
      return {
        result: 'WRONG_TYPE',
        detectedType: bestType,
        confidence: bestScore,
        scores,
        matchedColumns: bestMetrics?.matched ?? 0,
        totalColumns,
        missingRequired: expectedScore?.missingRequired || [],
        message: buildWrongTypeMessage(normalizedExpectedType, bestType)
      };
    }

    return {
      result: 'REJECTED',
      detectedType: null,
      confidence: 0,
      scores,
      matchedColumns: 0,
      totalColumns,
      missingRequired: expectedScore?.missingRequired || [],
      message: buildRejectedMessage(normalizedExpectedType, expectedScore?.missingRequired || [])
    };
  }

  if (expectedScore.requiredCoverage < 0.5) {
    if (bestType && bestType !== normalizedExpectedType && bestScore > expectedScore.confidence + 0.1) {
      return {
        result: 'WRONG_TYPE',
        detectedType: bestType,
        confidence: bestScore,
        scores,
        matchedColumns: bestMetrics?.matched ?? 0,
        totalColumns,
        missingRequired: expectedScore.missingRequired,
        message: buildWrongTypeMessage(normalizedExpectedType, bestType)
      };
    }

    return {
      result: 'REJECTED',
      detectedType: normalizedExpectedType,
      confidence: expectedScore.confidence,
      scores,
      matchedColumns: expectedScore.matched,
      totalColumns,
      missingRequired: expectedScore.missingRequired,
      message: buildRejectedMessage(normalizedExpectedType, expectedScore.missingRequired)
    };
  }

  if (bestType && bestType !== normalizedExpectedType && bestScore > expectedScore.confidence + 0.2) {
    return {
      result: 'WRONG_TYPE',
      detectedType: bestType,
      confidence: bestScore,
      scores,
      matchedColumns: bestMetrics?.matched ?? 0,
      totalColumns,
      missingRequired: expectedScore.missingRequired,
      message: buildWrongTypeMessage(normalizedExpectedType, bestType)
    };
  }

  return {
    result: 'ACCEPTED',
    detectedType: normalizedExpectedType,
    confidence: expectedScore.confidence,
    scores,
    matchedColumns: expectedScore.matched,
    totalColumns,
    missingRequired: [],
    message: `${typeLabel(normalizedExpectedType)} headers accepted.`
  };
}

export default { classifyFile, extractHeadersFromFile };
