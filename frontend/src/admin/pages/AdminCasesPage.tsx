import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Lock, Search, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { AdminCaseAssignment } from '../types'
import { adminConsoleAPI } from '../lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

const PAGE_SIZE = 20

const emptyFilters = {
  q: '',
  status: '',
  priority: '',
  evidenceLocked: '',
  owner: '',
  assignedOfficer: '',
  updatedFrom: '',
  updatedTo: '',
  minRecentActivity: '',
}

const formatTimestamp = (value?: string | null) => {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

const toStartOfDayIso = (value: string) => {
  if (!value) return undefined
  return new Date(`${value}T00:00:00`).toISOString()
}

const toEndOfDayIso = (value: string) => {
  if (!value) return undefined
  return new Date(`${value}T23:59:59.999`).toISOString()
}

const statusClasses: Record<string, string> = {
  open: 'status-open',
  active: 'status-active',
  archived: 'status-archived',
  locked: 'status-locked',
  closed: 'status-closed',
}

const priorityClasses: Record<string, string> = {
  critical: 'priority-critical',
  high: 'priority-high',
  medium: 'priority-medium',
  low: 'priority-low',
}

const formatAssignmentLabel = (assignment: AdminCaseAssignment) =>
  assignment.fullName || assignment.full_name || 'Unknown officer'

export default function AdminCasesPage() {
  const [filters, setFilters] = useState(emptyFilters)
  const [page, setPage] = useState(1)
  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const casesQuery = useQuery({
    queryKey: ['admin-cases', filters, page],
    queryFn: () =>
      adminConsoleAPI.getCases({
        ...filters,
        page,
        limit: PAGE_SIZE,
        evidenceLocked:
          filters.evidenceLocked === ''
            ? undefined
            : filters.evidenceLocked === 'true',
        updatedFrom: toStartOfDayIso(filters.updatedFrom),
        updatedTo: toEndOfDayIso(filters.updatedTo),
        minRecentActivity: filters.minRecentActivity ? Number(filters.minRecentActivity) : undefined,
      }),
    refetchInterval: 30000,
  })

  const caseDetailQuery = useQuery({
    queryKey: ['admin-case-detail', selectedCaseId],
    queryFn: () => adminConsoleAPI.getCaseDetail(selectedCaseId as number),
    enabled: selectedCaseId !== null,
  })

  const updateFilter = (key: keyof typeof emptyFilters, value: string) => {
    setPage(1)
    setFilters((current) => ({ ...current, [key]: value }))
  }

  const clearFilters = () => {
    setFilters(emptyFilters)
    setPage(1)
  }

  const handleExport = async () => {
    try {
      setIsExporting(true)
      setExportError(null)
      await adminConsoleAPI.exportCases({
        ...filters,
        evidenceLocked:
          filters.evidenceLocked === ''
            ? undefined
            : filters.evidenceLocked === 'true',
        updatedFrom: toStartOfDayIso(filters.updatedFrom),
        updatedTo: toEndOfDayIso(filters.updatedTo),
        minRecentActivity: filters.minRecentActivity ? Number(filters.minRecentActivity) : undefined,
      })
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Failed to export case governance view.')
    } finally {
      setIsExporting(false)
    }
  }

  if (casesQuery.isLoading) {
    return <div className="page-loading">Loading case governance view...</div>
  }

  if (casesQuery.isError || !casesQuery.data) {
    return (
      <div className="page-error">
        <AlertTriangle className="h-8 w-8" />
        <div>Failed to load the admin cases view.</div>
      </div>
    )
  }

  const { items, pagination, summary } = casesQuery.data
  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize))
  const selectedCase = caseDetailQuery.data

  return (
    <div className="space-y-6">
      <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-2">
              <div className="inline-flex rounded-full border border-blue-300/40 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
                Cases Governance
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">Operational case ownership, evidence lock, and traceability.</h2>
              <p className="text-sm leading-6 text-muted-foreground">
                Review case state, ownership, linked officers, file health, and recent governance activity without leaving the admin console.
              </p>
            </div>
            <div className="flex flex-col items-start gap-3 lg:items-end">
              <div className="text-sm text-muted-foreground">
                {pagination.total} cases
                {casesQuery.isFetching ? ' • Refreshing…' : ' • 30s polling'}
              </div>
              <Button type="button" variant="outline" onClick={() => void handleExport()} disabled={isExporting}>
                {isExporting ? 'Exporting…' : 'Export CSV'}
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <article className="rounded-[1.5rem] border border-border/70 bg-card/60 p-4">
              <div className="text-sm font-medium text-muted-foreground">Cases in view</div>
              <div className="mt-2 text-3xl font-semibold">{summary.totalCases}</div>
              <div className="mt-2 text-sm text-muted-foreground">Filtered governance case set</div>
            </article>
            <article className="rounded-[1.5rem] border border-border/70 bg-card/60 p-4">
              <div className="text-sm font-medium text-muted-foreground">Evidence locked</div>
              <div className="mt-2 text-3xl font-semibold">{summary.lockedCases}</div>
              <div className="mt-2 text-sm text-muted-foreground">Cases currently under lock controls</div>
            </article>
            <article className="rounded-[1.5rem] border border-border/70 bg-card/60 p-4">
              <div className="text-sm font-medium text-muted-foreground">High priority</div>
              <div className="mt-2 text-3xl font-semibold">{summary.highPriorityCases}</div>
              <div className="mt-2 text-sm text-muted-foreground">High and critical case workloads</div>
            </article>
            <article className="rounded-[1.5rem] border border-border/70 bg-card/60 p-4">
              <div className="text-sm font-medium text-muted-foreground">Linked files</div>
              <div className="mt-2 text-3xl font-semibold">{summary.totalFiles}</div>
              <div className="mt-2 text-sm text-muted-foreground">Uploaded evidence tracked across cases</div>
            </article>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-2 xl:col-span-2">
              <label htmlFor="case-search" className="text-sm font-medium text-muted-foreground">
                Search cases
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="case-search"
                  value={filters.q}
                  onChange={(event) => updateFilter('q', event.target.value)}
                  placeholder="Case name, number, FIR, operator, owner"
                  className="pl-10"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="case-owner" className="text-sm font-medium text-muted-foreground">
                Owner
              </label>
              <Input
                id="case-owner"
                value={filters.owner}
                onChange={(event) => updateFilter('owner', event.target.value)}
                placeholder="Owner name or buckle ID"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="case-status" className="text-sm font-medium text-muted-foreground">
                Status
              </label>
              <select
                id="case-status"
                value={filters.status}
                onChange={(event) => updateFilter('status', event.target.value)}
                className="input-field h-11"
              >
                <option value="">All statuses</option>
                <option value="open">Open</option>
                <option value="active">Active</option>
                <option value="closed">Closed</option>
                <option value="archived">Archived</option>
                <option value="locked">Locked</option>
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="case-priority" className="text-sm font-medium text-muted-foreground">
                Priority
              </label>
              <select
                id="case-priority"
                value={filters.priority}
                onChange={(event) => updateFilter('priority', event.target.value)}
                className="input-field h-11"
              >
                <option value="">All priorities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="case-lock" className="text-sm font-medium text-muted-foreground">
                Evidence lock
              </label>
              <select
                id="case-lock"
                value={filters.evidenceLocked}
                onChange={(event) => updateFilter('evidenceLocked', event.target.value)}
                className="input-field h-11"
              >
                <option value="">All cases</option>
                <option value="true">Locked</option>
                <option value="false">Unlocked</option>
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="case-assigned-officer" className="text-sm font-medium text-muted-foreground">
                Assigned officer
              </label>
              <Input
                id="case-assigned-officer"
                value={filters.assignedOfficer}
                onChange={(event) => updateFilter('assignedOfficer', event.target.value)}
                placeholder="Officer name or buckle ID"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="case-updated-from" className="text-sm font-medium text-muted-foreground">
                Updated from
              </label>
              <Input
                id="case-updated-from"
                type="date"
                value={filters.updatedFrom}
                onChange={(event) => updateFilter('updatedFrom', event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="case-updated-to" className="text-sm font-medium text-muted-foreground">
                Updated to
              </label>
              <Input
                id="case-updated-to"
                type="date"
                value={filters.updatedTo}
                onChange={(event) => updateFilter('updatedTo', event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="case-min-activity" className="text-sm font-medium text-muted-foreground">
                Minimum recent activity
              </label>
              <Input
                id="case-min-activity"
                type="number"
                min="0"
                value={filters.minRecentActivity}
                onChange={(event) => updateFilter('minRecentActivity', event.target.value)}
                placeholder="0"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-red-600 dark:text-red-300">{exportError || ''}</div>
            <Button type="button" variant="outline" onClick={clearFilters}>
              Reset Filters
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border/70 text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Case</th>
                <th className="px-4 py-3 font-semibold">Owner</th>
                <th className="px-4 py-3 font-semibold">State</th>
                <th className="px-4 py-3 font-semibold">Assignments</th>
                <th className="px-4 py-3 font-semibold">Files</th>
                <th className="px-4 py-3 font-semibold">Activity</th>
                <th className="px-4 py-3 font-semibold text-right">Inspect</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8">
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-5 text-center text-sm text-muted-foreground">
                      No cases matched the current governance filters.
                    </div>
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="border-b border-border/50 align-top last:border-b-0">
                    <td className="px-4 py-4">
                      <div className="font-medium">{item.case_name}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {item.case_number}
                        {item.fir_number ? ` • FIR ${item.fir_number}` : ''}
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        {item.case_type || 'Case'} {item.operator ? `• ${item.operator}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-medium">{item.owner_name || 'Unassigned'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{item.owner_buckle_id || 'No buckle ID'}</div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap gap-2">
                        <span className={`badge ${statusClasses[item.status] || 'badge'}`}>{item.status}</span>
                        <span className={`badge ${priorityClasses[item.priority] || 'badge'}`}>{item.priority}</span>
                        {item.is_evidence_locked ? (
                          <span className="badge status-locked">Evidence locked</span>
                        ) : null}
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">{formatTimestamp(item.updated_at)}</div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-medium">{item.assignment_count}</div>
                      <div className="mt-1 max-w-[14rem] truncate text-xs text-muted-foreground" title={item.assigned_officers.map(formatAssignmentLabel).join(', ')}>
                        {item.assigned_officers.length
                          ? item.assigned_officers.map(formatAssignmentLabel).join(', ')
                          : 'No active assignments'}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-medium">{item.file_count}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {item.failed_parse_files} failed • {item.pending_files} pending
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-medium">{item.recent_activity_count}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {item.last_activity_at ? `Last ${formatTimestamp(item.last_activity_at)}` : 'No recent activity'}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <Button type="button" variant="outline" size="sm" onClick={() => setSelectedCaseId(item.id)}>
                        Details
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-5 flex flex-col gap-3 border-t border-border/70 pt-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <div>
            Page {page} of {totalPages}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
              Previous
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>
              Next
            </Button>
          </div>
        </div>
      </section>

      <Dialog open={selectedCaseId !== null} onOpenChange={(open: boolean) => !open && setSelectedCaseId(null)}>
        <DialogContent className="max-w-5xl rounded-[1.75rem] p-0">
          <DialogHeader className="border-b border-border/70 px-6 py-5">
            <DialogTitle>{selectedCase?.case.case_name || 'Case details'}</DialogTitle>
            <DialogDescription>
              {selectedCase?.case.case_number || 'Loading case context'}
              {selectedCase?.case.fir_number ? ` • FIR ${selectedCase.case.fir_number}` : ''}
            </DialogDescription>
          </DialogHeader>

          {caseDetailQuery.isLoading ? (
            <div className="page-loading h-[30vh]">Loading case detail...</div>
          ) : caseDetailQuery.isError || !selectedCase ? (
            <div className="page-error h-[30vh]">
              <AlertTriangle className="h-8 w-8" />
              <div>Failed to load the selected case.</div>
            </div>
          ) : (
            <>
              <div className="grid gap-6 px-6 py-5 lg:grid-cols-[0.9fr_1.1fr]">
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Owner</div>
                      <div className="mt-2 text-sm font-medium">{selectedCase.case.owner_name || 'Unassigned'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{selectedCase.case.owner_buckle_id || 'No buckle ID'}</div>
                    </div>
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Evidence lock</div>
                      <div className="mt-2 flex items-center gap-2 text-sm font-medium">
                        {selectedCase.case.is_evidence_locked ? (
                          <>
                            <Lock className="h-4 w-4 text-red-500" />
                            Locked
                          </>
                        ) : (
                          <>
                            <ShieldCheck className="h-4 w-4 text-emerald-500" />
                            Unlocked
                          </>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {selectedCase.case.lock_reason || 'No lock reason recorded'}
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Files</div>
                      <div className="mt-2 text-2xl font-semibold">{selectedCase.stats.fileCount}</div>
                    </div>
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Failed parses</div>
                      <div className="mt-2 text-2xl font-semibold">{selectedCase.stats.failedParseFiles}</div>
                    </div>
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Recent activity</div>
                      <div className="mt-2 text-2xl font-semibold">{selectedCase.stats.recentActivityCount}</div>
                    </div>
                  </div>

                  <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                    <div className="text-sm font-semibold">Timeline Summary</div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">First event</div>
                        <div className="mt-1 text-sm font-medium">{formatTimestamp(selectedCase.timelineSummary.firstEventAt)}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Last event</div>
                        <div className="mt-1 text-sm font-medium">{formatTimestamp(selectedCase.timelineSummary.lastEventAt)}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Admin events</div>
                        <div className="mt-1 text-sm font-medium">{selectedCase.timelineSummary.adminEvents}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">High-risk events</div>
                        <div className="mt-1 text-sm font-medium">{selectedCase.timelineSummary.highRiskEvents}</div>
                      </div>
                    </div>
                    <div className="mt-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Top actions</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {selectedCase.timelineSummary.topActions.length ? (
                          selectedCase.timelineSummary.topActions.map((action) => (
                            <span key={action.action} className="badge">
                              {action.action} ({action.count})
                            </span>
                          ))
                        ) : (
                          <span className="text-sm text-muted-foreground">No activity summary available.</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold">Assignments</div>
                      <Link to={`/admin/users`} className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-300">
                        Open users view
                      </Link>
                    </div>
                    <div className="mt-3 space-y-3">
                      {selectedCase.assignments.length === 0 ? (
                        <div className="text-sm text-muted-foreground">No active assignments recorded.</div>
                      ) : (
                        selectedCase.assignments.map((assignment) => (
                          <div key={assignment.id ?? assignment.user_id} className="rounded-[1rem] border border-border/70 bg-background/60 px-3 py-3">
                            <div className="font-medium">{formatAssignmentLabel(assignment)}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {assignment.role} • {assignment.buckle_id || assignment.buckleId || 'No buckle ID'}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold">Recent Files</div>
                      <Link
                        to={`/admin/files?caseId=${selectedCase.case.id}`}
                        className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
                      >
                        Open files for this case
                      </Link>
                    </div>
                    <div className="mt-3 space-y-3">
                      {selectedCase.recentFiles.length === 0 ? (
                        <div className="text-sm text-muted-foreground">No uploaded files linked to this case.</div>
                      ) : (
                        selectedCase.recentFiles.map((file) => (
                          <div key={file.id} className="rounded-[1rem] border border-border/70 bg-background/60 px-3 py-3">
                            <div className="font-medium">{file.original_name || file.file_name}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {file.telecom_module} • {file.parse_status} • {formatTimestamp(file.uploaded_at)}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold">Recent Activity</div>
                      <Link
                        to={`/admin/activity?caseId=${selectedCase.case.id}`}
                        className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
                      >
                        Open activity for this case
                      </Link>
                    </div>
                    <div className="mt-3 space-y-3">
                      {selectedCase.recentActivity.length === 0 ? (
                        <div className="text-sm text-muted-foreground">No recent activity found for this case.</div>
                      ) : (
                        selectedCase.recentActivity.map((event) => (
                          <div key={`${event.source}-${event.id}`} className="rounded-[1rem] border border-border/70 bg-background/60 px-3 py-3">
                            <div className="font-medium">{event.action}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {event.actor_name || 'Unknown actor'} • {formatTimestamp(event.created_at)}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setSelectedCaseId(null)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
