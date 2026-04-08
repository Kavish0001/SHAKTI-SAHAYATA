export interface AdminIdentity {
  id: number
  email: string
  fullName: string
  role: string
  permissions: string[]
  isActive?: boolean
  lastLogin?: string | null
  createdAt?: string | null
}

export interface AdminSessionInfo {
  id: string | null
  startedAt: string | null
}

export type AdminAuthStatus = 'unknown' | 'authenticated' | 'unauthenticated'

export interface AdminHealthCheck {
  status: string
  reason?: string | null
  required?: boolean
  detail?: string
  checkedAt?: string
  [key: string]: unknown
}

export interface AdminHealthSection {
  status: string
  service?: string
  timestamp?: string
  checks?: Record<string, AdminHealthCheck>
  summary?: {
    failed?: string[]
    degraded?: string[]
  }
}

export interface ActivityEvent {
  source: 'audit' | 'admin'
  id: string
  created_at: string
  actor_type: 'officer' | 'admin'
  actor_id: string | null
  actor_name: string | null
  actor_email: string | null
  actor_role: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  session_id: string | null
  ip_address: string | null
  details: Record<string, unknown> | null
}

export interface AdminOverviewResponse {
  metrics: {
    activeOfficerSessions: number
    activeAdminSessions: number
    openCases: number
    evidenceLockedCases: number
    uploadsToday: number
    fileDeletionsToday: number
    failedOfficerLogins: number
    failedAdminLogins: number
    recentAdminActions: number
  }
  health: {
    databaseConnected: boolean
    serverTime: string | null
    live: AdminHealthSection
    ready: AdminHealthSection
    startup: AdminHealthSection
  }
  attention: Array<{
    id: string
    severity: 'warning' | 'critical' | 'info'
    title: string
    description: string
    href: string
    count: number
  }>
  recentActivity: ActivityEvent[]
}

export interface ActivityFeedResponse {
  items: ActivityEvent[]
  pagination: {
    page: number
    pageSize: number
    total: number
  }
}

export interface AdminPagination {
  page: number
  pageSize: number
  total: number
}

export interface OfficerAdminUserRow {
  id: number
  buckle_id?: string | null
  email: string
  full_name: string
  role: string
  is_active: boolean
  last_login: string | null
  login_count?: number
  position?: string | null
  department?: string | null
  station?: string | null
  active_sessions: number
  total_cases?: number
  open_cases?: number
  recent_actions_7d: number
  permissions?: string[]
}

export interface AdminSessionRow {
  id: string
  session_type: 'officer' | 'admin'
  actor_id: number
  actor_name: string
  actor_email: string
  actor_role: string
  actor_badge: string | null
  started_at: string
  ended_at: string | null
  logout_reason: string | null
  ip_address: string | null
  user_agent: string | null
  session_age_seconds: number
}

export interface AdminUsersResponse {
  officers: OfficerAdminUserRow[]
  admins: OfficerAdminUserRow[]
  summary: {
    totalOfficers: number
    totalAdmins: number
    activeOfficerSessions: number
    activeAdminSessions: number
  }
}

export interface AdminSessionsResponse {
  officerSessions: AdminSessionRow[]
  adminSessions: AdminSessionRow[]
  summary: {
    activeOnly: boolean
    officerCount: number
    adminCount: number
  }
}

export interface AdminCaseAssignment {
  id?: number
  userId?: number
  user_id?: number
  role: string
  fullName?: string
  full_name?: string
  email?: string | null
  buckleId?: string | null
  buckle_id?: string | null
  assigned_at?: string | null
}

export interface AdminCaseRow {
  id: number
  case_name: string
  case_number: string
  case_type: string | null
  fir_number: string | null
  operator: string | null
  status: string
  priority: string
  description?: string | null
  investigation_details?: string | null
  start_date?: string | null
  end_date?: string | null
  created_at: string
  updated_at: string
  is_evidence_locked: boolean
  locked_at?: string | null
  lock_reason?: string | null
  created_by_user_id?: number | null
  created_by_name?: string | null
  created_by_buckle_id?: string | null
  owner_id?: number | null
  owner_name?: string | null
  owner_buckle_id?: string | null
  assignment_count: number
  assigned_officers: AdminCaseAssignment[]
  file_count: number
  failed_parse_files: number
  completed_files: number
  pending_files: number
  recent_activity_count: number
  last_activity_at?: string | null
}

export interface AdminCasesResponse {
  items: AdminCaseRow[]
  pagination: AdminPagination
  summary: {
    totalCases: number
    lockedCases: number
    highPriorityCases: number
    totalFiles: number
  }
}

export interface AdminCaseDetailResponse {
  case: AdminCaseRow
  assignments: AdminCaseAssignment[]
  stats: {
    fileCount: number
    failedParseFiles: number
    completedFiles: number
    pendingFiles: number
    recentActivityCount: number
    assignmentCount: number
  }
  timelineSummary: {
    totalEvents: number
    firstEventAt: string | null
    lastEventAt: string | null
    adminEvents: number
    highRiskEvents: number
    topActions: Array<{
      action: string
      count: number
    }>
  }
  fileBreakdown: Array<{
    module: string
    totalFiles: number
    failedFiles: number
    records: number
  }>
  recentFiles: AdminFileRow[]
  recentActivity: ActivityEvent[]
}

export interface AdminFileRow {
  id: number
  case_id: number | null
  case_name: string | null
  case_number: string | null
  case_status: string | null
  case_priority?: string | null
  is_evidence_locked: boolean
  file_name: string
  original_name: string | null
  file_type: string | null
  file_size: number | null
  mime_type: string | null
  parse_status: string
  record_count: number
  uploaded_by: number | null
  uploaded_by_name: string | null
  uploaded_by_buckle_id: string | null
  uploaded_at: string
  expected_type: string | null
  detected_type: string | null
  confidence: number | null
  classification_result: string | null
  error_message: string | null
  telecom_module: string
}

export interface AdminFilesResponse {
  items: AdminFileRow[]
  pagination: AdminPagination
  summary: {
    totalFiles: number
    failedParseFiles: number
    completedFiles: number
    pendingFiles: number
    uploadsToday: number
    lockedCaseFiles: number
  }
}

export interface AdminFileDeletionRow {
  audit_id: string
  created_at: string
  actor_id: number | null
  actor_name: string | null
  actor_email: string | null
  actor_buckle_id: string | null
  case_id: number | null
  case_name: string | null
  case_number: string | null
  file_name: string | null
  stored_file_name: string | null
  deleted_type: string
  deleted_records: number
  file_id: string | null
  ip_address: string | null
  details: Record<string, unknown> | null
}

export interface AdminFileDeletionResponse {
  items: AdminFileDeletionRow[]
  pagination: AdminPagination
  summary: {
    totalDeletions: number
    totalDeletedRecords: number
    impactedCases: number
  }
}

export interface AdminAnalysisResponse {
  metrics: {
    total_jobs?: number
    queued_jobs?: number
    processing_jobs?: number
    completed_jobs?: number
    failed_jobs?: number
    total_files?: number
    failed_parse_files?: number
    uploads_today?: number
    chatbot_messages_24h?: number
  }
  modules: Array<{
    module: string
    total_jobs: number
    problematic_jobs: number
    total_rows: number
  }>
}
