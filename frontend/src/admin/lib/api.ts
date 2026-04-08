import { ApiError, resolveBackendBaseUrl } from '../../lib/apiClient'
import { adminApiClient, getAdminAccessToken } from './adminApiClient'
import type {
  ActivityFeedResponse,
  AdminAlertAcknowledgementResponse,
  AdminAlertsResponse,
  AdminAnalysisResponse,
  AdminDatabaseSchemaResponse,
  AdminDatabaseTableResponse,
  AdminCaseDetailResponse,
  AdminCasesResponse,
  AdminExportHistoryResponse,
  AdminFileDeletionResponse,
  AdminFilesResponse,
  AdminIdentity,
  AdminOverviewResponse,
  AdminSelfCheckResponse,
  AdminSessionInfo,
  AdminSessionsResponse,
  AdminSystemHealthResponse,
  AdminUsersResponse,
  SafeBrowsePage,
} from '../types'

export const adminAuthAPI = {
  async login(email: string, password: string) {
    return adminApiClient.request<{
      accessToken: string
      expiresAt: string | null
      session: AdminSessionInfo | null
      admin: AdminIdentity
    }>('/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
      redirectOn401: false,
    })
  },

  async loginWithTotp(email: string, password: string, totpCode: string) {
    return adminApiClient.request<{
      accessToken: string
      expiresAt: string | null
      session: AdminSessionInfo | null
      admin: AdminIdentity
    }>('/auth/login', {
      method: 'POST',
      body: { email, password, totpCode },
      auth: false,
      redirectOn401: false,
    })
  },

  async logout() {
    return adminApiClient.request('/auth/logout', { method: 'POST' })
  },

  async bootstrap() {
    return adminApiClient.request<{
      authenticated: boolean
      accessToken?: string
      expiresAt?: string | null
      session?: AdminSessionInfo | null
      admin?: AdminIdentity
    }>('/auth/bootstrap', {
      auth: false,
      redirectOn401: false,
      retryOn401: false,
    })
  },

  async getMe() {
    return adminApiClient.request<AdminIdentity>('/auth/me')
  },

  async reauthenticate(password: string, totpCode?: string) {
    return adminApiClient.request<{
      message: string
      accessToken: string
      expiresAt: string | null
      session: AdminSessionInfo | null
    }>('/auth/re-auth', {
      method: 'POST',
      body: { password, totpCode },
    })
  },
}

const buildSearchParams = (params: Record<string, string | number | boolean | undefined | null>) => {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      search.set(key, String(value))
    }
  })
  return search.toString()
}

const readErrorMessage = async (response: Response) => {
  const raw = await response.text()
  if (!raw) return `Request failed with status ${response.status}`

  try {
    const parsed = JSON.parse(raw) as { error?: string }
    return parsed.error || raw
  } catch {
    return raw
  }
}

const extractFilename = (response: Response, fallback: string) => {
  const disposition = response.headers.get('content-disposition') || ''
  const match = disposition.match(/filename="([^"]+)"/i)
  return match?.[1] || fallback
}

const downloadAdminCsv = async (
  endpoint: string,
  params: Record<string, string | number | boolean | undefined | null>,
  fallbackFilename: string
) => {
  const query = buildSearchParams(params)
  const requestUrl = `${resolveBackendBaseUrl()}/api/admin${endpoint}${query ? `?${query}` : ''}`

  const runDownload = async (allowRefresh: boolean): Promise<void> => {
    const token = getAdminAccessToken()
    const response = await fetch(requestUrl, {
      method: 'GET',
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })

    if (response.status === 401 && allowRefresh) {
      const refreshed = await adminApiClient.refreshAccessToken(true)
      if (refreshed) {
        return runDownload(false)
      }
      throw new ApiError('Admin session expired. Please sign in again.', 401)
    }

    if (!response.ok) {
      throw new ApiError(await readErrorMessage(response), response.status)
    }

    const blob = await response.blob()
    const downloadUrl = window.URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = downloadUrl
    anchor.download = extractFilename(response, fallbackFilename)
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.URL.revokeObjectURL(downloadUrl)
  }

  return runDownload(true)
}

export const adminConsoleAPI = {
  async getSystemHealth() {
    return adminApiClient.request<AdminSystemHealthResponse>('/system/health')
  },

  async runSystemSelfCheck() {
    return adminApiClient.request<AdminSelfCheckResponse>('/system/self-check', {
      method: 'POST',
    })
  },

  async getAlerts() {
    return adminApiClient.request<AdminAlertsResponse>('/alerts')
  },

  async acknowledgeAlert(alertId: string, note: string) {
    return adminApiClient.request<AdminAlertAcknowledgementResponse>(`/alerts/${encodeURIComponent(alertId)}/acknowledge`, {
      method: 'POST',
      body: { note },
    })
  },

  async getExportHistory(limit = 25) {
    const query = buildSearchParams({ limit })
    return adminApiClient.request<AdminExportHistoryResponse>(`/exports/history?${query}`)
  },

  async exportOverview(reason: string) {
    return downloadAdminCsv('/exports/overview', { reason }, 'admin-overview.csv')
  },

  async exportActivity(
    filters: {
      page?: number
      limit?: number
      source?: string
      actorType?: string
      actor?: string
      action?: string
      resourceType?: string
      resourceId?: string
      caseId?: string
      sessionId?: string
      ipAddress?: string
      dateFrom?: string
      dateTo?: string
      q?: string
      reason?: string
    } = {}
  ) {
    return downloadAdminCsv('/exports/activity', filters, 'admin-activity.csv')
  },

  async exportCasesFromCenter(
    filters: {
      q?: string
      status?: string
      priority?: string
      evidenceLocked?: boolean | string
      owner?: string
      assignedOfficer?: string
      updatedFrom?: string
      updatedTo?: string
      minRecentActivity?: number | string
      reason?: string
    } = {}
  ) {
    return downloadAdminCsv('/exports/cases', filters, 'admin-cases.csv')
  },

  async exportFilesFromCenter(
    filters: {
      q?: string
      caseId?: string | number
      fileType?: string
      parseStatus?: string
      classificationResult?: string
      uploader?: string
      dateFrom?: string
      dateTo?: string
      reason?: string
    } = {}
  ) {
    return downloadAdminCsv('/exports/files', filters, 'admin-files.csv')
  },

  async getOverview() {
    return adminApiClient.request<AdminOverviewResponse>('/overview')
  },

  async getActivity(filters: {
    page?: number
    limit?: number
    source?: string
    actorType?: string
    actor?: string
    action?: string
    resourceType?: string
    resourceId?: string
    caseId?: string
    sessionId?: string
    ipAddress?: string
    dateFrom?: string
    dateTo?: string
    q?: string
  } = {}) {
    const query = buildSearchParams(filters)
    return adminApiClient.request<ActivityFeedResponse>(`/activity${query ? `?${query}` : ''}`)
  },

  async getUsers() {
    return adminApiClient.request<AdminUsersResponse>('/users')
  },

  async getSessions(activeOnly = true) {
    const query = buildSearchParams({ activeOnly })
    return adminApiClient.request<AdminSessionsResponse>(`/sessions?${query}`)
  },

  async forceLogout(sessionId: string, sessionType: 'officer' | 'admin', reason = 'admin_forced') {
    return adminApiClient.request<{ forced: boolean; sessionType: 'officer' | 'admin'; sessionId: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/force-logout`,
      {
        method: 'POST',
        body: { sessionType, reason },
      }
    )
  },

  async getCases(filters: {
    page?: number
    limit?: number
    q?: string
    status?: string
    priority?: string
    evidenceLocked?: boolean | string
    owner?: string
    assignedOfficer?: string
    updatedFrom?: string
    updatedTo?: string
    minRecentActivity?: number | string
  } = {}) {
    const query = buildSearchParams(filters)
    return adminApiClient.request<AdminCasesResponse>(`/cases${query ? `?${query}` : ''}`)
  },

  async exportCases(filters: {
    q?: string
    status?: string
    priority?: string
    evidenceLocked?: boolean | string
    owner?: string
    assignedOfficer?: string
    updatedFrom?: string
    updatedTo?: string
    minRecentActivity?: number | string
  } = {}) {
    return downloadAdminCsv('/cases/export', filters, 'admin-case-governance.csv')
  },

  async getCaseDetail(caseId: number | string) {
    return adminApiClient.request<AdminCaseDetailResponse>(`/cases/${encodeURIComponent(String(caseId))}`)
  },

  async getFiles(filters: {
    page?: number
    limit?: number
    q?: string
    caseId?: string | number
    fileType?: string
    parseStatus?: string
    classificationResult?: string
    uploader?: string
    dateFrom?: string
    dateTo?: string
  } = {}) {
    const query = buildSearchParams(filters)
    return adminApiClient.request<AdminFilesResponse>(`/files${query ? `?${query}` : ''}`)
  },

  async exportFiles(filters: {
    q?: string
    caseId?: string | number
    fileType?: string
    parseStatus?: string
    classificationResult?: string
    uploader?: string
    dateFrom?: string
    dateTo?: string
  } = {}) {
    return downloadAdminCsv('/files/export', filters, 'admin-file-governance.csv')
  },

  async getFileDeletions(filters: {
    page?: number
    limit?: number
    q?: string
    caseId?: string | number
    deletedType?: string
    actor?: string
    dateFrom?: string
    dateTo?: string
  } = {}) {
    const query = buildSearchParams(filters)
    return adminApiClient.request<AdminFileDeletionResponse>(`/files/deletions${query ? `?${query}` : ''}`)
  },

  async exportFileDeletions(filters: {
    q?: string
    caseId?: string | number
    deletedType?: string
    actor?: string
    dateFrom?: string
    dateTo?: string
  } = {}) {
    return downloadAdminCsv('/files/deletions/export', filters, 'admin-file-deletions.csv')
  },

  async getAnalysis() {
    return adminApiClient.request<AdminAnalysisResponse>('/analysis')
  },

  async getDatabaseSchema() {
    return adminApiClient.request<AdminDatabaseSchemaResponse>('/database/schema')
  },

  async getDatabaseTable(table: string) {
    return adminApiClient.request<AdminDatabaseTableResponse>(`/database/tables/${encodeURIComponent(table)}`)
  },

  async getDatabaseRows(
    table: string,
    filters: {
      page?: number
      limit?: number
      sortBy?: string
      sortDir?: string
      filterColumn?: string
      filterOp?: string
      filterValue?: string
    } = {}
  ) {
    const query = buildSearchParams(filters)
    return adminApiClient.request<SafeBrowsePage>(
      `/database/tables/${encodeURIComponent(table)}/rows${query ? `?${query}` : ''}`
    )
  },
}
