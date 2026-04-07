/**
 * SHAKTI v2.0 — Unified API adapters
 * All components import named API objects from this file.
 * Requests flow through the canonical client in `src/lib/apiClient.ts`.
 */

import { apiClient, resolveBackendBaseUrl } from '../../lib/apiClient'

type ApiRecord = unknown
type SdrRecord = Record<string, unknown>

type CaseListResponse = {
  items: any[]
  pagination: {
    page: number
    pageSize: number
    total: number
  }
}

type DashboardStats = {
  totalCases: number
  activeCases: number
  totalFiles: number
  recentCases: any[]
}

type SystemDiagnostics = {
  timestamp: string
  backend: {
    status: string
    version: string
    mode: string
  }
  database: {
    connected: boolean
    error?: string | null
  }
  ollama: {
    available: boolean
    baseUrl: string
    model: string
    source?: string
    error?: string | null
  }
  chatbot: {
    diagnosticsEnabled?: boolean
    deterministicAvailable: boolean
    llmAvailable: boolean
  }
  requester: {
    userId: number | null
    buckleId: string | null
    role: string | null
  }
  health?: {
    live?: {
      status: string
      service: string
      timestamp: string
      uptimeSeconds?: number
    }
    ready?: {
      status: string
      service: string
      timestamp: string
      checks?: Record<string, { status: string; reason?: string | null; required?: boolean }>
    }
    startup?: {
      status: string
      timestamp: string
      checks?: Record<string, { status: string; reason?: string | null; required?: boolean }>
    }
  }
  backups?: {
    latestBackup?: {
      status: string
      completedAt?: string | null
      bundlePath?: string | null
      offsiteDir?: string | null
      caseCount?: number
      uploadedFileCount?: number
    } | null
    latestRestore?: {
      status: string
      verifiedAt?: string | null
      targetDatabase?: string | null
      restoredCaseCount?: number
      restoredFileCount?: number
    } | null
  }
}

const normalizeCaseListResponse = (payload: any): CaseListResponse => {
  const items = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.cases)
      ? payload.cases
      : Array.isArray(payload)
        ? payload
        : []

  const rawPagination = payload?.pagination ?? {}

  return {
    items,
    pagination: {
      page: Number(rawPagination.page ?? payload?.page ?? 1) || 1,
      pageSize: Number(rawPagination.pageSize ?? payload?.pageSize ?? items.length ?? 0) || items.length || 0,
      total: Number(rawPagination.total ?? payload?.total ?? items.length ?? 0) || 0,
    },
  }
}

const normalizeSingleCaseResponse = (payload: any) => payload?.case ?? payload

const normalizeFileListResponse = (payload: any) => {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.files)) return payload.files
  return []
}

const normalizeDashboardStats = (payload: any): DashboardStats => ({
  totalCases: Number(payload?.totalCases ?? payload?.total_cases ?? 0) || 0,
  activeCases: Number(payload?.activeCases ?? payload?.active_cases ?? 0) || 0,
  totalFiles: Number(payload?.totalFiles ?? payload?.fileUploads ?? payload?.file_uploads ?? 0) || 0,
  recentCases: Array.isArray(payload?.recentCases) ? payload.recentCases : [],
})

const buildSearchParams = (params: Record<string, string | number | undefined | null>) => {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      search.set(key, String(value))
    }
  })
  return search.toString()
}

const buildAbsoluteDownloadUrl = (pathOrUrl: string) => {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl
  return `${resolveBackendBaseUrl()}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`
}

/* ------------------------------------------------------------------ */
/*  Auth API                                                          */
/* ------------------------------------------------------------------ */
export const authAPI = {
  async getSession(): Promise<{ started_at: string | null; duration_seconds: number }> {
    return apiClient.request('/auth/session')
  },
}

/* ------------------------------------------------------------------ */
/*  Dashboard API                                                     */
/* ------------------------------------------------------------------ */
export const dashboardAPI = {
  async getStats(): Promise<DashboardStats> {
    const payload = await apiClient.request<any>('/dashboard/stats')
    return normalizeDashboardStats(payload)
  },
}

/* ------------------------------------------------------------------ */
/*  Case API                                                          */
/* ------------------------------------------------------------------ */
export const caseAPI = {
  async create(data: {
    case_name?: string
    caseName?: string
    caseNumber?: string
    case_number?: string
    fir_number?: string
    firNumber?: string
    description?: string
    investigationDetails?: string
    operator?: string
    case_type?: 'CDR' | 'IPDR' | 'SDR' | 'TOWER' | 'ILD'
    investigating_officer?: string
    startDate?: string
    endDate?: string
    caseType?: string
    priority?: string
  }): Promise<any> {
    const payload = await apiClient.request<any>('/cases', {
      method: 'POST',
      body: data,
    })
    return normalizeSingleCaseResponse(payload)
  },

  async list(options: { status?: string; page?: number; limit?: number } = {}): Promise<CaseListResponse> {
    const query = buildSearchParams(options)
    const payload = await apiClient.request<any>(`/cases${query ? `?${query}` : ''}`)
    return normalizeCaseListResponse(payload)
  },

  async search(query: string, limit = 8): Promise<{ data: any[]; query?: string; limit?: number }> {
    const params = buildSearchParams({ q: query.trim(), limit })
    return apiClient.request(`/cases/search?${params}`)
  },

  async get(id: string) {
    const payload = await apiClient.request<any>(`/cases/${encodeURIComponent(id)}`)
    return normalizeSingleCaseResponse(payload)
  },

  async getKnowledge(id: string) {
    return apiClient.request(`/cases/${encodeURIComponent(id)}/knowledge`)
  },

  async getSummary(id: string, module: 'overview' | 'files' | 'cdr' | 'ipdr' | 'sdr' | 'tower' | 'ild' | 'timeline') {
    return apiClient.request(`/cases/${encodeURIComponent(id)}/summary/${encodeURIComponent(module)}`)
  },

  async getTimeline(id: string, limit = 250): Promise<{ events: any[]; limit: number }> {
    return apiClient.request(`/cases/${encodeURIComponent(id)}/timeline?limit=${encodeURIComponent(String(limit))}`)
  },

  async getStats() {
    return apiClient.request('/cases/stats')
  },

  async update(
    id: string,
    data: {
      case_name?: string
      case_number?: string
      fir_number?: string
      description?: string
      operator?: string
      case_type?: 'CDR' | 'IPDR' | 'SDR' | 'TOWER' | 'ILD'
      investigating_officer?: string
      status?: 'active' | 'closed' | 'archived'
    }
  ) {
    return apiClient.request(`/cases/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: data,
    })
  },

  async remove(id: string) {
    return apiClient.request(`/cases/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },
}

/* ------------------------------------------------------------------ */
/*  File API                                                          */
/* ------------------------------------------------------------------ */
export const fileAPI = {
  async upload(caseId: string, file: File, operator: string, fileType?: string): Promise<any> {
    const form = new FormData()
    form.append('file', file)
    form.append('caseId', caseId)
    form.append('operator', operator)
    form.append('fileType', fileType || 'cdr')
    form.append('expectedType', fileType || 'cdr')

    return apiClient.request('/files/upload', {
      method: 'POST',
      body: form,
    })
  },

  async listByCase(caseId: string): Promise<any[]> {
    const payload = await apiClient.request<any>(`/files?caseId=${encodeURIComponent(caseId)}`)
    return normalizeFileListResponse(payload)
  },

  async getDownloadUrl(filePath: string): Promise<string> {
    const data = await apiClient.request<{ url: string }>(`/files/download-url?path=${encodeURIComponent(filePath)}`)
    return buildAbsoluteDownloadUrl(data.url)
  },
}

/* ------------------------------------------------------------------ */
/*  Record Count API                                                  */
/* ------------------------------------------------------------------ */
export const recordCountAPI = {
  async getCountByCase(kind: 'cdr' | 'ipdr' | 'sdr' | 'tower' | 'ild', caseId: string): Promise<number> {
    const endpoint = kind === 'tower' ? 'tower' : kind
    const data = await apiClient.request<{ count?: number }>(`/${endpoint}/records/count?caseId=${encodeURIComponent(caseId)}`)
    return Number(data?.count || 0) || 0
  },
}

/* ------------------------------------------------------------------ */
/*  CDR API                                                           */
/* ------------------------------------------------------------------ */
export const cdrAPI = {
  async insertRecords(caseId: string, records: ApiRecord[], fileId?: string) {
    const data = await apiClient.request<{ inserted?: number }>('/cdr/records', {
      method: 'POST',
      body: { caseId, records, fileId },
    })
    return data.inserted || 0
  },

  async getCountByCase(caseId: string): Promise<number> {
    return recordCountAPI.getCountByCase('cdr', caseId)
  },

  async getUniqueAParties(caseId: string): Promise<string[]> {
    return apiClient.request(`/cdr/records/unique-a?caseId=${encodeURIComponent(caseId)}`)
  },

  async getRecordsByCase(caseId: string): Promise<ApiRecord[]> {
    return apiClient.request(`/cdr/records?caseId=${encodeURIComponent(caseId)}`)
  },
}

/* ------------------------------------------------------------------ */
/*  Settings API                                                      */
/* ------------------------------------------------------------------ */
export const settingsAPI = {
  async get(): Promise<Record<string, unknown>> {
    const raw = await apiClient.request<any>('/settings')
    if (raw && typeof raw === 'object' && typeof raw.app_config === 'string') {
      try {
        const parsed = JSON.parse(raw.app_config)
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, unknown>
        }
      } catch {
        // fall through to raw payload
      }
    }
    return raw
  },

  async save(config: Record<string, unknown>): Promise<{ saved: boolean; id: number }> {
    return apiClient.request('/settings', {
      method: 'POST',
      body: { key: 'app_config', value: JSON.stringify(config) },
    })
  },

  async resetDatabase(): Promise<{ success: boolean; message: string }> {
    return apiClient.request('/reset-settings', {
      method: 'POST',
    })
  },
}

/* ------------------------------------------------------------------ */
/*  IPDR File API                                                     */
/* ------------------------------------------------------------------ */
export const ipdrFileAPI = {
  async upload(caseId: string, file: File, operator: string) {
    const form = new FormData()
    form.append('file', file)
    form.append('caseId', caseId)
    form.append('operator', operator)
    form.append('expectedType', 'ipdr')

    return apiClient.request('/files/upload/ipdr', {
      method: 'POST',
      body: form,
    })
  },

  async getDownloadUrl(filePath: string): Promise<string> {
    const data = await apiClient.request<{ url: string }>(`/files/download-url?path=${encodeURIComponent(filePath)}`)
    return buildAbsoluteDownloadUrl(data.url)
  },
}

/* ------------------------------------------------------------------ */
/*  ILD File API                                                      */
/* ------------------------------------------------------------------ */
export const ildFileAPI = {
  async upload(caseId: string, file: File, operator: string) {
    const form = new FormData()
    form.append('file', file)
    form.append('caseId', caseId)
    form.append('operator', operator)
    form.append('expectedType', 'ild')

    return apiClient.request('/files/upload/ild', {
      method: 'POST',
      body: form,
    })
  },

  async getDownloadUrl(filePath: string): Promise<string> {
    const data = await apiClient.request<{ url: string }>(`/files/download-url?path=${encodeURIComponent(filePath)}`)
    return buildAbsoluteDownloadUrl(data.url)
  },
}

/* ------------------------------------------------------------------ */
/*  Tower Dump File API                                               */
/* ------------------------------------------------------------------ */
export const towerDumpFileAPI = {
  async upload(caseId: string, file: File, operator: string) {
    const form = new FormData()
    form.append('file', file)
    form.append('caseId', caseId)
    form.append('operator', operator)
    form.append('expectedType', 'tower_dump')

    return apiClient.request('/files/upload/tower', {
      method: 'POST',
      body: form,
    })
  },

  async getDownloadUrl(filePath: string): Promise<string> {
    const data = await apiClient.request<{ url: string }>(`/files/download-url?path=${encodeURIComponent(filePath)}`)
    return buildAbsoluteDownloadUrl(data.url)
  },
}

/* ------------------------------------------------------------------ */
/*  IPDR API                                                          */
/* ------------------------------------------------------------------ */
export const ipdrAPI = {
  async insertRecords(
    caseId: string,
    records: ApiRecord[],
    fileId?: string,
    options?: {
      chunkSize?: number
      onProgress?: (inserted: number, total: number) => void
      enrichIpInfo?: boolean
    }
  ) {
    const total = Array.isArray(records) ? records.length : 0
    if (total === 0) return 0

    const chunkSize = Math.max(100, options?.chunkSize ?? 1000)
    let insertedTotal = 0
    const enrichIpInfo = options?.enrichIpInfo === true

    for (let i = 0; i < total; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize)
      const data = await apiClient.request<{ inserted?: number }>('/ipdr/records', {
        method: 'POST',
        body: { caseId, records: chunk, fileId, enrichIpInfo },
      })
      const inserted = Number(data.inserted || 0)
      insertedTotal += inserted
      options?.onProgress?.(Math.min(insertedTotal, total), total)
    }

    return insertedTotal
  },

  async getRecordsByCase(caseId: string): Promise<ApiRecord[]> {
    return apiClient.request(`/ipdr/records?caseId=${encodeURIComponent(caseId)}`)
  },

  async getRecords(caseId: string): Promise<ApiRecord[]> {
    return apiClient.request(`/ipdr/records?caseId=${encodeURIComponent(caseId)}`)
  },

  async enrichCase(
    caseId: string,
    limit = 5000
  ): Promise<{
    caseId: string
    processed: number
    fetched: number
    enrichedIps: number
    updatedRows: number
    skippedPrivate: number
  }> {
    return apiClient.request('/ipdr/enrich-case', {
      method: 'POST',
      body: { caseId, limit },
    })
  },
}

/* ------------------------------------------------------------------ */
/*  ILD API                                                           */
/* ------------------------------------------------------------------ */
export const ildAPI = {
  async insertRecords(caseId: string, records: ApiRecord[], fileId?: string) {
    const data = await apiClient.request<{ inserted?: number }>('/ild/records', {
      method: 'POST',
      body: { caseId, records, fileId },
    })
    return data.inserted || 0
  },

  async getRecordsByCase(caseId: string): Promise<ApiRecord[]> {
    return apiClient.request(`/ild/records?caseId=${encodeURIComponent(caseId)}`)
  },

  async getRecords(caseId: string): Promise<ApiRecord[]> {
    return apiClient.request(`/ild/records?caseId=${encodeURIComponent(caseId)}`)
  },
}

/* ------------------------------------------------------------------ */
/*  Tower Dump API                                                    */
/* ------------------------------------------------------------------ */
export const towerDumpAPI = {
  async insertRecords(
    caseId: string,
    fileId: string | null,
    records: ApiRecord[],
    options?: { chunkSize?: number; onProgress?: (inserted: number, total: number) => void }
  ) {
    const total = Array.isArray(records) ? records.length : 0
    if (total === 0) return 0

    const chunkSize = Math.max(200, options?.chunkSize ?? 2000)
    let insertedTotal = 0

    for (let i = 0; i < total; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize)
      const data = await apiClient.request<{ inserted?: number }>('/tower/records', {
        method: 'POST',
        body: { caseId, records: chunk, fileId },
      })
      const inserted = Number(data.inserted || 0)
      insertedTotal += inserted
      options?.onProgress?.(Math.min(insertedTotal, total), total)
    }

    return insertedTotal
  },

  async getRecordsByCase(caseId: string): Promise<ApiRecord[]> {
    return apiClient.request(`/tower/records?caseId=${encodeURIComponent(caseId)}`)
  },

  async getRecords(caseId: string): Promise<ApiRecord[]> {
    return apiClient.request(`/tower/records?caseId=${encodeURIComponent(caseId)}`)
  },

  async getPartyGraph(
    caseId: string,
    params?: { startDate?: string; endDate?: string }
  ): Promise<{
    nodes: Array<{ id: string; label: string; title: string; value: number; color?: string }>
    edges: Array<{ id: string; from: string; to: string; value: number; title: string }>
    meta?: Record<string, unknown>
  }> {
    const query = buildSearchParams({
      caseId,
      startDate: params?.startDate,
      endDate: params?.endDate,
    })
    return apiClient.request(`/tower/party-graph?${query}`)
  },
}

/* ------------------------------------------------------------------ */
/*  SDR API                                                           */
/* ------------------------------------------------------------------ */
export const sdrAPI = {
  async insertRecords(caseId: string, records: SdrRecord[], fileId?: string) {
    const data = await apiClient.request<{ inserted?: number }>('/sdr/records', {
      method: 'POST',
      body: { caseId, records, fileId },
    })
    return data.inserted || 0
  },

  async listTables(caseId?: string): Promise<string[]> {
    const query = buildSearchParams({ caseId })
    return apiClient.request(`/sdr/tables${query ? `?${query}` : ''}`)
  },

  async getTable(name: string, caseId?: string, limit?: number): Promise<SdrRecord[]> {
    const query = buildSearchParams({ name, caseId, limit })
    return apiClient.request(`/sdr/table?${query}`)
  },

  async replaceTable(
    caseId: string | undefined,
    tableName: string,
    rows: SdrRecord[]
  ): Promise<{ inserted: number; skipped: number }> {
    return apiClient.request('/sdr/table/replace', {
      method: 'POST',
      body: { caseId, tableName, rows },
    })
  },

  async dropTable(caseId: string | undefined, name: string): Promise<{ dropped: number }> {
    const query = buildSearchParams({ name, caseId })
    return apiClient.request(`/sdr/table?${query}`, {
      method: 'DELETE',
    })
  },

  async search(q: string, caseId?: string): Promise<SdrRecord[]> {
    const query = buildSearchParams({ q, caseId })
    return apiClient.request(`/sdr/search?${query}`)
  },

  async uploadFile(
    caseId: string | undefined,
    file: File
  ): Promise<{ table: string; inserted: number; skipped: number }> {
    const form = new FormData()
    form.append('file', file)
    if (caseId) form.append('caseId', caseId)

    return apiClient.request('/sdr/upload', {
      method: 'POST',
      body: form,
    })
  },
}

/* ------------------------------------------------------------------ */
/*  Activity Log API                                                  */
/* ------------------------------------------------------------------ */
export const activityLogAPI = {
  async logAccess(input: {
    action: string
    screen?: string
    path?: string
    details?: Record<string, unknown>
    clientId?: string
    sessionId?: string
    userAgent?: string
  }): Promise<ApiRecord> {
    return apiClient.request('/audit/logs', {
      method: 'POST',
      body: {
        clientId: input.clientId,
        sessionId: input.sessionId,
        action: input.action,
        screen: input.screen,
        path: input.path,
        userAgent: input.userAgent,
        details: input.details || null,
      },
    })
  },
}

/* ------------------------------------------------------------------ */
/*  System API                                                        */
/* ------------------------------------------------------------------ */
export const systemAPI = {
  async verifyConnection(): Promise<{ connected: boolean; errors: string[] }> {
    try {
      await apiClient.request('/health', { auth: false, redirectOn401: false })
      return { connected: true, errors: [] }
    } catch (error) {
      return { connected: false, errors: [(error as Error).message] }
    }
  },

  async getDiagnostics(): Promise<SystemDiagnostics> {
    return apiClient.request('/system/diagnostics', { redirectOn401: false })
  },

  async runSelfCheck(): Promise<{
    startup: NonNullable<SystemDiagnostics['health']>['startup']
    ready: NonNullable<SystemDiagnostics['health']>['ready']
  }> {
    return apiClient.request('/system/self-check', {
      method: 'POST',
      redirectOn401: false,
    })
  },
}
