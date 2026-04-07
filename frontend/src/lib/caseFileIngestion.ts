import * as XLSX from 'xlsx-js-style'
import { cdrAPI, fileAPI, ildAPI, ipdrAPI, sdrAPI, towerDumpAPI } from '../components/lib/apis'
import { parseILD, type ILDOperator, type NormalizedILD } from '../components/utils/ildNormalization'
import { parseIPDR, type IPDROperator, type NormalizedIPDR } from '../components/utils/ipdrNormalization'
import { parseCSV, type NormalizedCDR, type Operator as CDROperator } from '../components/utils/normalization'
import { parseSDRCsv, type NormalizedSDR } from '../components/utils/sdrNormalization'
import { parseTowerDumpCsvAsync } from '../components/utils/towerDumpParserAsync'
import type { NormalizedTowerDump } from '../components/utils/towerDumpNormalization'

export type CaseUploadSlotKey = 'cdr' | 'sdr' | 'ipdr' | 'tower' | 'ild'

export interface CaseUploadSlotInput {
  key: CaseUploadSlotKey
  label: string
  files: File[]
}

export interface CaseUploadFailure {
  fileName: string
  slotKey: CaseUploadSlotKey
  message: string
}

interface IngestCaseUploadsParams {
  caseId: number
  operator: string
  uploads: CaseUploadSlotInput[]
  onProgress?: (slotKey: CaseUploadSlotKey, message: string) => void
}

const SLOT_LABELS: Record<CaseUploadSlotKey, string> = {
  cdr: 'CDR',
  sdr: 'SDR',
  ipdr: 'IPDR',
  tower: 'Tower Dump',
  ild: 'ILD',
}

const CDR_OPERATORS: CDROperator[] = ['VODAFONE', 'AIRTEL', 'BSNL', 'JIO']
const IPDR_OPERATORS: IPDROperator[] = ['AIRTEL', 'VLI', 'TYPE3']
const ILD_OPERATOR: ILDOperator = 'JIO'

const yieldToUI = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const buildFailureMessage = (slotKey: CaseUploadSlotKey, fileName: string, reason: string) =>
  `${SLOT_LABELS[slotKey]} processing failed for ${fileName}: ${reason}`

const countPopulatedFields = (record: object) =>
  Object.values(record as Record<string, unknown>).filter(
    (value) => value !== null && value !== undefined && String(value).trim() !== ''
  ).length

const scoreParsedRecords = <T extends object>(records: T[]) =>
  records.length * 1000 + records.slice(0, 50).reduce((sum, record) => sum + countPopulatedFields(record), 0)

const chooseBestParsedRecords = <T extends object, TOption extends string>(
  options: readonly TOption[],
  parser: (option: TOption) => T[]
) => {
  let bestRecords: T[] = []
  let bestScore = -1

  for (const option of options) {
    try {
      const records = parser(option)
      const score = scoreParsedRecords(records)
      if (score > bestScore) {
        bestScore = score
        bestRecords = records
      }
    } catch {
      // Ignore this candidate and keep searching for a parser that fits the file.
    }
  }

  return bestRecords
}

const readFirstSheetAsCsv = async (file: File): Promise<string> => {
  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array' })
    const firstSheetName = workbook.SheetNames[0]
    if (!firstSheetName) return ''
    return XLSX.utils.sheet_to_csv(workbook.Sheets[firstSheetName])
  }
  return file.text()
}

const pickBestIpdrSheet = (workbook: XLSX.WorkBook) => {
  const keyword = /(ipdr|gprs|data|internet|packet|session|cdr|usage|traffic)/i
  const headerKeyword = /(msisdn|imsi|imei|source.?ip|destination.?ip|session|apn|pgw|uplink|downlink)/i
  let bestName = workbook.SheetNames[0] || ''
  let bestScore = -1

  for (const name of workbook.SheetNames) {
    const ws = workbook.Sheets[name]
    if (!ws) continue
    const sampleRows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, blankrows: false, defval: '' })
    const headerLine = (sampleRows[0] || []).join(' ')
    const rowCount = sampleRows.length
    let score = 0
    if (keyword.test(name)) score += 6
    if (headerKeyword.test(headerLine)) score += 8
    score += Math.min(6, Math.floor(rowCount / 500))
    if (score > bestScore) {
      bestScore = score
      bestName = name
    }
  }

  return bestName
}

const readIpdrFileAsCsv = async (file: File): Promise<string> => {
  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: 'array' })
    const sheetName = pickBestIpdrSheet(workbook)
    if (!sheetName) return ''
    return XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])
  }
  return file.text()
}

const normalizeTowerRecords = (
  parsedRecords: NormalizedTowerDump[],
  file: File,
  fileIndex: number,
  defaultOperator: string
) =>
  parsedRecords.map((record, rowIndex) => ({
    ...record,
    source_file: file.name,
    _source_file: file.name,
    row_index: rowIndex,
    _row_index: rowIndex,
    file_index: fileIndex,
    raw_data: {
      ...record,
      source_file: file.name,
      row_index: rowIndex,
      file_index: fileIndex,
    },
    operator: record.operator || defaultOperator,
  }))

const parseCdrRecords = async (file: File) => {
  const content = await readFirstSheetAsCsv(file)
  return chooseBestParsedRecords(CDR_OPERATORS, (candidate) => parseCSV(content, candidate))
}

const parseIpdrRecords = async (file: File) => {
  const content = await readIpdrFileAsCsv(file)
  return chooseBestParsedRecords(IPDR_OPERATORS, (candidate) => parseIPDR(content, candidate))
}

const parseSdrRecords = async (file: File) => {
  const content = await readFirstSheetAsCsv(file)
  return parseSDRCsv(content)
}

const parseTowerRecords = async (file: File, fileIndex: number, operator: string) => {
  const content = await readFirstSheetAsCsv(file)
  const parsed = await parseTowerDumpCsvAsync(content)
  return normalizeTowerRecords(parsed, file, fileIndex, operator)
}

const parseIldRecords = async (file: File) => {
  const content = await readFirstSheetAsCsv(file)
  return parseILD(content, ILD_OPERATOR)
}

const tagRecords = <T extends object>(records: T[], file: File, fileIndex: number) =>
  records.map((record, rowIndex) => ({
    ...(record as Record<string, unknown>),
    file_index: fileIndex,
    file_name: file.name,
    row_index: rowIndex,
    raw_data: {
      ...(record as Record<string, unknown>),
      file_index: fileIndex,
      file_name: file.name,
      row_index: rowIndex,
    },
  }))

const insertCdrRecords = async (caseId: number, fileId: number, records: NormalizedCDR[], file: File, fileIndex: number) => {
  const payload = tagRecords(records, file, fileIndex)
  return cdrAPI.insertRecords(String(caseId), payload, String(fileId))
}

const insertIpdrRecords = async (caseId: number, fileId: number, records: NormalizedIPDR[], file: File, fileIndex: number) => {
  const payload = tagRecords(records, file, fileIndex)
  return ipdrAPI.insertRecords(String(caseId), payload, String(fileId), { chunkSize: 1000 })
}

const insertSdrRecords = async (caseId: number, fileId: number, records: NormalizedSDR[], file: File, fileIndex: number) => {
  const payload = tagRecords(records, file, fileIndex)
  return sdrAPI.insertRecords(String(caseId), payload, String(fileId))
}

const insertTowerRecords = async (
  caseId: number,
  fileId: number,
  records: Array<NormalizedTowerDump & Record<string, unknown>>
) => {
  return towerDumpAPI.insertRecords(String(caseId), String(fileId), records, { chunkSize: 1000 })
}

const insertIldRecords = async (caseId: number, fileId: number, records: NormalizedILD[], file: File, fileIndex: number) => {
  const payload = tagRecords(records, file, fileIndex)
  return ildAPI.insertRecords(String(caseId), payload, String(fileId))
}

const parseRecordsForSlot = async (slotKey: CaseUploadSlotKey, file: File, fileIndex: number, operator: string) => {
  switch (slotKey) {
    case 'cdr':
      return parseCdrRecords(file)
    case 'ipdr':
      return parseIpdrRecords(file)
    case 'sdr':
      return parseSdrRecords(file)
    case 'tower':
      return parseTowerRecords(file, fileIndex, operator)
    case 'ild':
      return parseIldRecords(file)
    default:
      return []
  }
}

const insertRecordsForSlot = async (
  slotKey: CaseUploadSlotKey,
  caseId: number,
  fileId: number,
  records: object[],
  file: File,
  fileIndex: number
) => {
  switch (slotKey) {
    case 'cdr':
      return insertCdrRecords(caseId, fileId, records as unknown as NormalizedCDR[], file, fileIndex)
    case 'ipdr':
      return insertIpdrRecords(caseId, fileId, records as unknown as NormalizedIPDR[], file, fileIndex)
    case 'sdr':
      return insertSdrRecords(caseId, fileId, records as NormalizedSDR[], file, fileIndex)
    case 'tower':
      return insertTowerRecords(caseId, fileId, records as Array<NormalizedTowerDump & Record<string, unknown>>)
    case 'ild':
      return insertIldRecords(caseId, fileId, records as unknown as NormalizedILD[], file, fileIndex)
    default:
      return 0
  }
}

export async function ingestCaseUploads({
  caseId,
  operator,
  uploads,
  onProgress,
}: IngestCaseUploadsParams): Promise<CaseUploadFailure[]> {
  const failures: CaseUploadFailure[] = []
  let insertedIpdrRecords = 0

  for (const slot of uploads) {
    if (slot.files.length === 0) continue

    for (let fileIndex = 0; fileIndex < slot.files.length; fileIndex += 1) {
      const file = slot.files[fileIndex]

      try {
        onProgress?.(slot.key, `Parsing ${file.name}...`)
        const parsedRecords = await parseRecordsForSlot(slot.key, file, fileIndex, operator)

        if (!Array.isArray(parsedRecords) || parsedRecords.length === 0) {
          throw new Error(`No valid ${SLOT_LABELS[slot.key]} records were detected.`)
        }

        await yieldToUI()
        onProgress?.(slot.key, `Uploading ${file.name}...`)
        const uploadedFile = await fileAPI.upload(String(caseId), file, operator, slot.key)

        if (!uploadedFile?.id) {
          throw new Error('The file was uploaded, but the server did not return a file id.')
        }

        await yieldToUI()
        onProgress?.(slot.key, `Saving ${parsedRecords.length} ${SLOT_LABELS[slot.key]} records from ${file.name}...`)
        const insertedCount = await insertRecordsForSlot(
          slot.key,
          caseId,
          uploadedFile.id,
          parsedRecords as object[],
          file,
          fileIndex
        )

        if (slot.key === 'ipdr') {
          insertedIpdrRecords += insertedCount
        }

        onProgress?.(
          slot.key,
          `Processed ${file.name}: inserted ${insertedCount}/${parsedRecords.length} ${SLOT_LABELS[slot.key]} records`
        )
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failures.push({
          fileName: file.name,
          slotKey: slot.key,
          message: buildFailureMessage(slot.key, file.name, reason),
        })
        onProgress?.(slot.key, reason)
      }
    }
  }

  if (insertedIpdrRecords > 0) {
    try {
      onProgress?.('ipdr', 'Enriching IP intelligence...')
      await ipdrAPI.enrichCase(String(caseId), 5000)
      onProgress?.('ipdr', 'IP intelligence enrichment complete')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      failures.push({
        fileName: 'IPDR enrichment',
        slotKey: 'ipdr',
        message: `IPDR enrichment failed after upload: ${reason}`,
      })
      onProgress?.('ipdr', `IP intelligence enrichment skipped: ${reason}`)
    }
  }

  return failures
}
