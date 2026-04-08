export interface AdminIdentity {
  id: number
  email: string
  fullName: string
  role: string
  permissions: string[]
  isActive?: boolean
  lastLogin?: string | null
  createdAt?: string | null
  totpEnabled?: boolean
  totpSecretConfigured?: boolean
  recentAuthWindowMinutes?: number
}

export interface AdminSessionInfo {
  id: string | null
  startedAt: string | null
  lastReauthenticatedAt?: string | null
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

export interface DatabaseRelationship {
  constraintName: string
  sourceTable: string
  sourceColumn: string
  targetTable: string
  targetColumn: string
}

export interface DatabaseTableMeta {
  name: string
  schema: string
  type: string
  group: string
  restricted: boolean
  estimatedRowCount: number
  totalBytes: number
  totalBytesLabel: string
  lastAnalyzedAt: string | null
  columnCount: number
  indexCount: number
  relationshipCount: number
  canBrowseRows: boolean
  browseRestrictionReason: string | null
  largeTableMode: boolean
}

export interface DatabaseColumnMeta {
  name: string
  ordinalPosition: number
  dataType: string
  databaseType: string
  isNullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  maskStrategy: string
}

export interface DatabaseIndexMeta {
  name: string
  definition: string
  columns: string[]
  isUnique: boolean
}

export interface AdminDatabaseSchemaResponse {
  generatedAt: string
  summary: {
    tableCount: number
    relationshipCount: number
    restrictedTableCount: number
  }
  groups: Array<{
    name: string
    count: number
  }>
  tables: DatabaseTableMeta[]
  relationships: DatabaseRelationship[]
}

export interface AdminDatabaseTableResponse {
  table: {
    name: string
    schema: string
    type: string
    group: string
    restricted: boolean
    estimatedRowCount: number
    totalBytes: number
    totalBytesLabel: string
    lastAnalyzedAt: string | null
    canBrowseRows: boolean
    browseRestrictionReason: string | null
    largeTableMode: boolean
  }
  columns: DatabaseColumnMeta[]
  indexes: DatabaseIndexMeta[]
  outgoingRelationships: DatabaseRelationship[]
  incomingRelationships: DatabaseRelationship[]
}

export interface SafeBrowsePage {
  table: {
    name: string
    schema: string
    restricted: boolean
    estimatedRowCount: number
    totalBytesLabel: string
    canBrowseRows: boolean
    browseRestrictionReason: string | null
    largeTableMode: boolean
  }
  columns: DatabaseColumnMeta[]
  items: Array<Record<string, unknown>>
  pagination: {
    page: number
    pageSize: number
    hasMore: boolean
    estimatedTotal: number
  }
  filter: {
    column: string | null
    operator: string | null
    value: string | null
  }
  sort: {
    by: string
    dir: string
  }
}

export interface AdminSystemStatusBlock {
  status: string
  detail: string
  checkedAt?: string
  [key: string]: unknown
}

export interface AdminSystemHealthResponse {
  generatedAt: string
  overallStatus: string
  backend: {
    live: AdminHealthSection
    ready: AdminHealthSection
    startup: AdminHealthSection
  }
  database: AdminSystemStatusBlock & {
    connected?: boolean
    latencyMs?: number
    serverTime?: string | null
    metrics?: Record<string, number>
    pool?: {
      totalCount: number
      idleCount: number
      waitingCount: number
    }
  }
  uploads: AdminSystemStatusBlock & {
    path?: string
    writable?: boolean
    topLevelFileCount?: number
  }
  backups: AdminSystemStatusBlock & {
    latestBackup?: Record<string, unknown> | null
    latestRestore?: Record<string, unknown> | null
  }
  runtime: AdminSystemStatusBlock & {
    nodeVersion?: string
    platform?: string
    hostname?: string
    uptimeSeconds?: number
    memory?: {
      rss: number
      heapTotal: number
      heapUsed: number
      external: number
    }
  }
  security: {
    totp: AdminSystemStatusBlock & {
      enforced?: boolean
      currentRoleRequiresTotp?: boolean
      currentAdminEnrolled?: boolean
      requiredRoles?: string[]
    }
    sessionRotation: AdminSystemStatusBlock
    networkRestriction: AdminSystemStatusBlock & {
      mode?: string
      clientIp?: string | null
      matched?: boolean
    }
    recentAuth: AdminSystemStatusBlock & {
      recentAuthWindowMinutes?: number
    }
  }
  retention: {
    running: boolean
    startedAt: string | null
    completedAt: string | null
    lastResult: null | {
      status: string
      startedAt: string
      completedAt: string
      deletedSessions: number
      deletedRefreshTokens: number
      deletedActionLogs: number
      policies: {
        sessionDays: number
        refreshTokenDays: number
        actionLogDays: number
      }
    }
    lastError: string | null
    policies: {
      sessionDays: number
      refreshTokenDays: number
      actionLogDays: number
      intervalMinutes: number
    }
  }
  selfChecks: Array<{
    id: number
    createdAt: string
    actorName: string
    actorEmail: string | null
    status: string
    failedChecks: string[]
    degradedChecks: string[]
    durationMs: number | null
  }>
}

export interface AdminSelfCheckResponse {
  status: string
  startedAt: string
  completedAt: string
  durationMs: number
  failedChecks: string[]
  degradedChecks: string[]
  snapshot: AdminSystemHealthResponse
}

export interface AdminAlertItem {
  id: string
  rule: string
  severity: 'critical' | 'warning' | 'info'
  status: string
  title: string
  summary: string
  href: string
  remediation: string
  metric: string | number
  threshold: string | number
  evidence: Record<string, unknown>
  acknowledged: boolean
  acknowledgedAt: string | null
  note: string | null
  acknowledgedBy: string | null
  acknowledgedByEmail: string | null
}

export interface AdminAlertsResponse {
  generatedAt: string
  summary: {
    total: number
    critical: number
    warning: number
    acknowledged: number
  }
  items: AdminAlertItem[]
}

export interface AdminAlertAcknowledgementResponse {
  acknowledged: boolean
  alertId: string
  acknowledgement: {
    alert_key: string
    acknowledged_at: string
    note: string | null
  } | null
}

export interface AdminExportHistoryItem {
  id: number
  action: string
  createdAt: string
  actorName: string
  actorEmail: string | null
  actorRole: string | null
  exportScope: string | null
  filters: Record<string, unknown>
  reason: string | null
  exportedCount: number
  result: string
  watermark: Record<string, unknown> | null
}

export interface AdminExportHistoryResponse {
  items: AdminExportHistoryItem[]
}
