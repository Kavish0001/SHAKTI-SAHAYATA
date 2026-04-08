import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Download, FileSpreadsheet, Search } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '../../lib/apiClient'
import AdminRecentAuthDialog from '../components/AdminRecentAuthDialog'
import { adminConsoleAPI } from '../lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

const formatTimestamp = (value?: string | null) => {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

const toStartOfDayIso = (value: string) => (value ? new Date(`${value}T00:00:00`).toISOString() : undefined)
const toEndOfDayIso = (value: string) => (value ? new Date(`${value}T23:59:59.999`).toISOString() : undefined)

type ExportTask = 'overview' | 'activity' | 'cases' | 'files' | null

export default function AdminExportsPage() {
  const [activeTask, setActiveTask] = useState<ExportTask>(null)
  const [recentAuthOpen, setRecentAuthOpen] = useState(false)
  const [pendingRetry, setPendingRetry] = useState<null | (() => Promise<void>)>(null)

  const [overviewReason, setOverviewReason] = useState('')
  const [activityFilters, setActivityFilters] = useState({
    q: '',
    source: '',
    actorType: '',
    action: '',
    caseId: '',
    dateFrom: '',
    dateTo: '',
    reason: '',
  })
  const [caseFilters, setCaseFilters] = useState({
    q: '',
    status: '',
    priority: '',
    owner: '',
    evidenceLocked: '',
    updatedFrom: '',
    updatedTo: '',
    reason: '',
  })
  const [fileFilters, setFileFilters] = useState({
    q: '',
    caseId: '',
    fileType: '',
    parseStatus: '',
    uploader: '',
    dateFrom: '',
    dateTo: '',
    reason: '',
  })

  const historyQuery = useQuery({
    queryKey: ['admin-export-history'],
    queryFn: () => adminConsoleAPI.getExportHistory(30),
    refetchInterval: 30000,
  })

  const runExport = async (task: ExportTask, exporter: () => Promise<void>) => {
    try {
      setActiveTask(task)
      await exporter()
      toast.success('Export started. Check your downloads for the generated file.')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'RECENT_ADMIN_AUTH_REQUIRED') {
        setPendingRetry(() => exporter)
        setRecentAuthOpen(true)
        return
      }
      toast.error(error instanceof Error ? error.message : 'Failed to export the requested data.')
    } finally {
      setActiveTask(null)
    }
  }

  if (historyQuery.isLoading) {
    return <div className="page-loading">Loading export center...</div>
  }

  if (historyQuery.isError || !historyQuery.data) {
    return (
      <div className="page-error">
        <AlertTriangle className="h-8 w-8" />
        <div>Failed to load the export center.</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[1.75rem] border border-border/70 bg-card p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl space-y-2">
            <div className="inline-flex rounded-full border border-blue-300/40 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
              Export Center
            </div>
            <h2 className="text-3xl font-semibold tracking-tight">Permission-checked operational exports with traceability.</h2>
            <p className="text-sm leading-7 text-muted-foreground">
              Exports are treated as sensitive operational actions. Each export records scope, filters, reason, actor, time, and result in the admin action log.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Recent exports</div>
              <div className="mt-2 text-2xl font-semibold">{historyQuery.data.items.length}</div>
            </div>
            <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Watermarking</div>
              <div className="mt-2 text-2xl font-semibold">On</div>
            </div>
          </div>
        </div>
      </section>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="h-auto flex-wrap rounded-[1.25rem] p-1">
          <TabsTrigger value="overview" className="rounded-xl px-4 py-2">Overview</TabsTrigger>
          <TabsTrigger value="activity" className="rounded-xl px-4 py-2">Activity</TabsTrigger>
          <TabsTrigger value="cases" className="rounded-xl px-4 py-2">Cases</TabsTrigger>
          <TabsTrigger value="files" className="rounded-xl px-4 py-2">Files</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
            <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="space-y-3">
                <div className="text-lg font-semibold">Current overview snapshot</div>
                <div className="text-sm text-muted-foreground">
                  Exports the current operational summary that powers the overview dashboard, including attention metrics and current counts.
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="overview-reason" className="text-sm font-medium text-muted-foreground">Reason for export</label>
                <Textarea
                  id="overview-reason"
                  value={overviewReason}
                  onChange={(event) => setOverviewReason(event.target.value)}
                  placeholder="Why is this overview export needed?"
                  rows={4}
                />
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <Button type="button" disabled={activeTask !== null || !overviewReason.trim()} onClick={() => void runExport('overview', () => adminConsoleAPI.exportOverview(overviewReason.trim()))}>
                <Download className="h-4 w-4" />
                {activeTask === 'overview' ? 'Exporting…' : 'Export Overview CSV'}
              </Button>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="activity">
          <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2 xl:col-span-2">
                <label htmlFor="activity-q" className="text-sm font-medium text-muted-foreground">Search</label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="activity-q" value={activityFilters.q} onChange={(event) => setActivityFilters((current) => ({ ...current, q: event.target.value }))} className="pl-10" placeholder="Actor, action, resource, raw detail text" />
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="activity-source" className="text-sm font-medium text-muted-foreground">Source</label>
                <Input id="activity-source" value={activityFilters.source} onChange={(event) => setActivityFilters((current) => ({ ...current, source: event.target.value }))} placeholder="audit or admin" />
              </div>
              <div className="space-y-2">
                <label htmlFor="activity-actor-type" className="text-sm font-medium text-muted-foreground">Actor type</label>
                <Input id="activity-actor-type" value={activityFilters.actorType} onChange={(event) => setActivityFilters((current) => ({ ...current, actorType: event.target.value }))} placeholder="officer or admin" />
              </div>
              <div className="space-y-2">
                <label htmlFor="activity-action" className="text-sm font-medium text-muted-foreground">Action</label>
                <Input id="activity-action" value={activityFilters.action} onChange={(event) => setActivityFilters((current) => ({ ...current, action: event.target.value }))} placeholder="FILE_DELETE, ADMIN_LOGIN" />
              </div>
              <div className="space-y-2">
                <label htmlFor="activity-case-id" className="text-sm font-medium text-muted-foreground">Case ID</label>
                <Input id="activity-case-id" value={activityFilters.caseId} onChange={(event) => setActivityFilters((current) => ({ ...current, caseId: event.target.value }))} placeholder="Linked case id" />
              </div>
              <div className="space-y-2">
                <label htmlFor="activity-date-from" className="text-sm font-medium text-muted-foreground">Date from</label>
                <Input id="activity-date-from" type="date" value={activityFilters.dateFrom} onChange={(event) => setActivityFilters((current) => ({ ...current, dateFrom: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <label htmlFor="activity-date-to" className="text-sm font-medium text-muted-foreground">Date to</label>
                <Input id="activity-date-to" type="date" value={activityFilters.dateTo} onChange={(event) => setActivityFilters((current) => ({ ...current, dateTo: event.target.value }))} />
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <label htmlFor="activity-reason" className="text-sm font-medium text-muted-foreground">Reason for export</label>
              <Textarea id="activity-reason" value={activityFilters.reason} onChange={(event) => setActivityFilters((current) => ({ ...current, reason: event.target.value }))} rows={3} placeholder="Why is this activity export needed?" />
            </div>

            <div className="mt-4 flex justify-end">
              <Button
                type="button"
                disabled={activeTask !== null || !activityFilters.reason.trim()}
                onClick={() => void runExport('activity', () => adminConsoleAPI.exportActivity({
                  ...activityFilters,
                  dateFrom: toStartOfDayIso(activityFilters.dateFrom),
                  dateTo: toEndOfDayIso(activityFilters.dateTo),
                  reason: activityFilters.reason.trim(),
                }))}
              >
                <FileSpreadsheet className="h-4 w-4" />
                {activeTask === 'activity' ? 'Exporting…' : 'Export Activity CSV'}
              </Button>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="cases">
          <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2 xl:col-span-2">
                <label htmlFor="case-q" className="text-sm font-medium text-muted-foreground">Search</label>
                <Input id="case-q" value={caseFilters.q} onChange={(event) => setCaseFilters((current) => ({ ...current, q: event.target.value }))} placeholder="Case number, owner, officer, operator" />
              </div>
              <div className="space-y-2">
                <label htmlFor="case-status" className="text-sm font-medium text-muted-foreground">Status</label>
                <Input id="case-status" value={caseFilters.status} onChange={(event) => setCaseFilters((current) => ({ ...current, status: event.target.value }))} placeholder="open, active, archived" />
              </div>
              <div className="space-y-2">
                <label htmlFor="case-priority" className="text-sm font-medium text-muted-foreground">Priority</label>
                <Input id="case-priority" value={caseFilters.priority} onChange={(event) => setCaseFilters((current) => ({ ...current, priority: event.target.value }))} placeholder="high, medium, low" />
              </div>
              <div className="space-y-2">
                <label htmlFor="case-owner" className="text-sm font-medium text-muted-foreground">Owner</label>
                <Input id="case-owner" value={caseFilters.owner} onChange={(event) => setCaseFilters((current) => ({ ...current, owner: event.target.value }))} placeholder="Owner name or buckle ID" />
              </div>
              <div className="space-y-2">
                <label htmlFor="case-evidence-locked" className="text-sm font-medium text-muted-foreground">Evidence locked</label>
                <Input id="case-evidence-locked" value={caseFilters.evidenceLocked} onChange={(event) => setCaseFilters((current) => ({ ...current, evidenceLocked: event.target.value }))} placeholder="true or false" />
              </div>
              <div className="space-y-2">
                <label htmlFor="case-date-from" className="text-sm font-medium text-muted-foreground">Updated from</label>
                <Input id="case-date-from" type="date" value={caseFilters.updatedFrom} onChange={(event) => setCaseFilters((current) => ({ ...current, updatedFrom: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <label htmlFor="case-date-to" className="text-sm font-medium text-muted-foreground">Updated to</label>
                <Input id="case-date-to" type="date" value={caseFilters.updatedTo} onChange={(event) => setCaseFilters((current) => ({ ...current, updatedTo: event.target.value }))} />
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <label htmlFor="case-reason" className="text-sm font-medium text-muted-foreground">Reason for export</label>
              <Textarea id="case-reason" value={caseFilters.reason} onChange={(event) => setCaseFilters((current) => ({ ...current, reason: event.target.value }))} rows={3} placeholder="Why is this case export needed?" />
            </div>

            <div className="mt-4 flex justify-end">
              <Button
                type="button"
                disabled={activeTask !== null || !caseFilters.reason.trim()}
                onClick={() => void runExport('cases', () => adminConsoleAPI.exportCasesFromCenter({
                  ...caseFilters,
                  updatedFrom: toStartOfDayIso(caseFilters.updatedFrom),
                  updatedTo: toEndOfDayIso(caseFilters.updatedTo),
                  reason: caseFilters.reason.trim(),
                }))}
              >
                <FileSpreadsheet className="h-4 w-4" />
                {activeTask === 'cases' ? 'Exporting…' : 'Export Cases CSV'}
              </Button>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="files">
          <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2 xl:col-span-2">
                <label htmlFor="file-q" className="text-sm font-medium text-muted-foreground">Search</label>
                <Input id="file-q" value={fileFilters.q} onChange={(event) => setFileFilters((current) => ({ ...current, q: event.target.value }))} placeholder="Filename, case, uploader, module" />
              </div>
              <div className="space-y-2">
                <label htmlFor="file-case-id" className="text-sm font-medium text-muted-foreground">Case ID</label>
                <Input id="file-case-id" value={fileFilters.caseId} onChange={(event) => setFileFilters((current) => ({ ...current, caseId: event.target.value }))} placeholder="Filter a specific case" />
              </div>
              <div className="space-y-2">
                <label htmlFor="file-type" className="text-sm font-medium text-muted-foreground">Telecom module</label>
                <Input id="file-type" value={fileFilters.fileType} onChange={(event) => setFileFilters((current) => ({ ...current, fileType: event.target.value }))} placeholder="cdr, ipdr, sdr, ild" />
              </div>
              <div className="space-y-2">
                <label htmlFor="file-status" className="text-sm font-medium text-muted-foreground">Parse status</label>
                <Input id="file-status" value={fileFilters.parseStatus} onChange={(event) => setFileFilters((current) => ({ ...current, parseStatus: event.target.value }))} placeholder="pending, completed, failed" />
              </div>
              <div className="space-y-2">
                <label htmlFor="file-uploader" className="text-sm font-medium text-muted-foreground">Uploader</label>
                <Input id="file-uploader" value={fileFilters.uploader} onChange={(event) => setFileFilters((current) => ({ ...current, uploader: event.target.value }))} placeholder="Officer name or buckle ID" />
              </div>
              <div className="space-y-2">
                <label htmlFor="file-date-from" className="text-sm font-medium text-muted-foreground">Date from</label>
                <Input id="file-date-from" type="date" value={fileFilters.dateFrom} onChange={(event) => setFileFilters((current) => ({ ...current, dateFrom: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <label htmlFor="file-date-to" className="text-sm font-medium text-muted-foreground">Date to</label>
                <Input id="file-date-to" type="date" value={fileFilters.dateTo} onChange={(event) => setFileFilters((current) => ({ ...current, dateTo: event.target.value }))} />
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <label htmlFor="file-reason" className="text-sm font-medium text-muted-foreground">Reason for export</label>
              <Textarea id="file-reason" value={fileFilters.reason} onChange={(event) => setFileFilters((current) => ({ ...current, reason: event.target.value }))} rows={3} placeholder="Why is this file export needed?" />
            </div>

            <div className="mt-4 flex justify-end">
              <Button
                type="button"
                disabled={activeTask !== null || !fileFilters.reason.trim()}
                onClick={() => void runExport('files', () => adminConsoleAPI.exportFilesFromCenter({
                  ...fileFilters,
                  dateFrom: toStartOfDayIso(fileFilters.dateFrom),
                  dateTo: toEndOfDayIso(fileFilters.dateTo),
                  reason: fileFilters.reason.trim(),
                }))}
              >
                <FileSpreadsheet className="h-4 w-4" />
                {activeTask === 'files' ? 'Exporting…' : 'Export Files CSV'}
              </Button>
            </div>
          </section>
        </TabsContent>
      </Tabs>

      <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xl font-semibold">Export Audit Trail</h3>
          <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{historyQuery.data.items.length} entries</span>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border/70 text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                <th className="px-4 py-3 font-semibold">When</th>
                <th className="px-4 py-3 font-semibold">Actor</th>
                <th className="px-4 py-3 font-semibold">Scope</th>
                <th className="px-4 py-3 font-semibold">Rows</th>
                <th className="px-4 py-3 font-semibold">Result</th>
                <th className="px-4 py-3 font-semibold">Reason</th>
              </tr>
            </thead>
            <tbody>
              {historyQuery.data.items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8">
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-5 text-center text-sm text-muted-foreground">
                      No admin exports have been logged yet.
                    </div>
                  </td>
                </tr>
              ) : (
                historyQuery.data.items.map((item) => (
                  <tr key={item.id} className="border-b border-border/50 align-top last:border-b-0">
                    <td className="px-4 py-4 text-muted-foreground">{formatTimestamp(item.createdAt)}</td>
                    <td className="px-4 py-4">
                      <div className="font-medium">{item.actorName}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{item.actorEmail || 'No email'}</div>
                    </td>
                    <td className="px-4 py-4 font-medium">{item.exportScope || item.action}</td>
                    <td className="px-4 py-4">{item.exportedCount}</td>
                    <td className="px-4 py-4">
                      <span className={item.result === 'success' ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}>
                        {item.result}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-muted-foreground">{item.reason || 'No reason recorded'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <AdminRecentAuthDialog
        open={recentAuthOpen}
        onOpenChange={setRecentAuthOpen}
        title="Recent auth required before export"
        description="Exports are treated as sensitive operational actions. Refresh your admin authentication and the export will retry automatically."
        onSuccess={async () => {
          const retry = pendingRetry
          setPendingRetry(null)
          setRecentAuthOpen(false)
          if (retry) {
            try {
              await retry()
              toast.success('Export started. Check your downloads for the generated file.')
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'Failed to export the requested data.')
            }
          }
        }}
      />
    </div>
  )
}
