import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Search } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import type { AdminFileDeletionRow, AdminFileRow } from '../types'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const PAGE_SIZE = 20

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

export default function AdminFilesPage() {
  const [searchParams] = useSearchParams()
  const linkedCaseId = searchParams.get('caseId') || ''

  const [uploadFilters, setUploadFilters] = useState({
    q: '',
    caseId: linkedCaseId,
    fileType: '',
    parseStatus: '',
    classificationResult: '',
    uploader: '',
    dateFrom: '',
    dateTo: '',
  })
  const [deletionFilters, setDeletionFilters] = useState({
    q: '',
    caseId: linkedCaseId,
    deletedType: '',
    actor: '',
    dateFrom: '',
    dateTo: '',
  })
  const [uploadsPage, setUploadsPage] = useState(1)
  const [deletionsPage, setDeletionsPage] = useState(1)
  const [selectedUpload, setSelectedUpload] = useState<AdminFileRow | null>(null)
  const [selectedDeletion, setSelectedDeletion] = useState<AdminFileDeletionRow | null>(null)
  const [activeExport, setActiveExport] = useState<'uploads' | 'deletions' | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  const filesQuery = useQuery({
    queryKey: ['admin-files', uploadFilters, uploadsPage],
    queryFn: () =>
      adminConsoleAPI.getFiles({
        ...uploadFilters,
        page: uploadsPage,
        limit: PAGE_SIZE,
        dateFrom: toStartOfDayIso(uploadFilters.dateFrom),
        dateTo: toEndOfDayIso(uploadFilters.dateTo),
      }),
    refetchInterval: 30000,
  })

  const deletionsQuery = useQuery({
    queryKey: ['admin-file-deletions', deletionFilters, deletionsPage],
    queryFn: () =>
      adminConsoleAPI.getFileDeletions({
        ...deletionFilters,
        page: deletionsPage,
        limit: PAGE_SIZE,
        dateFrom: toStartOfDayIso(deletionFilters.dateFrom),
        dateTo: toEndOfDayIso(deletionFilters.dateTo),
      }),
    refetchInterval: 30000,
  })

  const analysisQuery = useQuery({
    queryKey: ['admin-analysis'],
    queryFn: () => adminConsoleAPI.getAnalysis(),
    refetchInterval: 30000,
  })

  const deletionRepeats = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of deletionsQuery.data?.items || []) {
      const key = `${row.case_id || 'unknown'}:${row.file_name || row.file_id || row.audit_id}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    return counts
  }, [deletionsQuery.data?.items])

  const updateUploadFilter = (key: keyof typeof uploadFilters, value: string) => {
    setUploadsPage(1)
    setUploadFilters((current) => ({ ...current, [key]: value }))
  }

  const updateDeletionFilter = (key: keyof typeof deletionFilters, value: string) => {
    setDeletionsPage(1)
    setDeletionFilters((current) => ({ ...current, [key]: value }))
  }

  const resetUploadFilters = () => {
    setUploadFilters({
      q: '',
      caseId: linkedCaseId,
      fileType: '',
      parseStatus: '',
      classificationResult: '',
      uploader: '',
      dateFrom: '',
      dateTo: '',
    })
    setUploadsPage(1)
  }

  const resetDeletionFilters = () => {
    setDeletionFilters({
      q: '',
      caseId: linkedCaseId,
      deletedType: '',
      actor: '',
      dateFrom: '',
      dateTo: '',
    })
    setDeletionsPage(1)
  }

  const handleUploadsExport = async () => {
    try {
      setActiveExport('uploads')
      setExportError(null)
      await adminConsoleAPI.exportFiles({
        ...uploadFilters,
        dateFrom: toStartOfDayIso(uploadFilters.dateFrom),
        dateTo: toEndOfDayIso(uploadFilters.dateTo),
      })
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Failed to export file governance view.')
    } finally {
      setActiveExport(null)
    }
  }

  const handleDeletionsExport = async () => {
    try {
      setActiveExport('deletions')
      setExportError(null)
      await adminConsoleAPI.exportFileDeletions({
        ...deletionFilters,
        dateFrom: toStartOfDayIso(deletionFilters.dateFrom),
        dateTo: toEndOfDayIso(deletionFilters.dateTo),
      })
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Failed to export file deletion traceability.')
    } finally {
      setActiveExport(null)
    }
  }

  if (filesQuery.isLoading || deletionsQuery.isLoading || analysisQuery.isLoading) {
    return <div className="page-loading">Loading file governance view...</div>
  }

  if (
    filesQuery.isError || !filesQuery.data
    || deletionsQuery.isError || !deletionsQuery.data
    || analysisQuery.isError || !analysisQuery.data
  ) {
    return (
      <div className="page-error">
        <AlertTriangle className="h-8 w-8" />
        <div>Failed to load the admin files governance view.</div>
      </div>
    )
  }

  const uploadTotalPages = Math.max(1, Math.ceil(filesQuery.data.pagination.total / filesQuery.data.pagination.pageSize))
  const deletionTotalPages = Math.max(1, Math.ceil(deletionsQuery.data.pagination.total / deletionsQuery.data.pagination.pageSize))

  return (
    <div className="space-y-6">
      <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-2">
              <div className="inline-flex rounded-full border border-blue-300/40 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
                Files Governance
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">Uploads, parse failures, and deletions traceability.</h2>
              <p className="text-sm leading-6 text-muted-foreground">
                Review file health across all cases, inspect parser outcomes, and trace destructive actions back to actor, case, and deleted record counts.
              </p>
            </div>
            <div className="flex flex-col items-start gap-3 lg:items-end">
              <div className="text-sm text-muted-foreground">
                {filesQuery.data.pagination.total} uploads • {deletionsQuery.data.pagination.total} deletions
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => void handleUploadsExport()} disabled={activeExport !== null}>
                  {activeExport === 'uploads' ? 'Exporting uploads…' : 'Export uploads CSV'}
                </Button>
                <Button type="button" variant="outline" onClick={() => void handleDeletionsExport()} disabled={activeExport !== null}>
                  {activeExport === 'deletions' ? 'Exporting deletions…' : 'Export deletions CSV'}
                </Button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <article className="rounded-[1.5rem] border border-border/70 bg-card/60 p-4">
              <div className="text-sm font-medium text-muted-foreground">Files in view</div>
              <div className="mt-2 text-3xl font-semibold">{filesQuery.data.summary.totalFiles}</div>
              <div className="mt-2 text-sm text-muted-foreground">{filesQuery.data.summary.uploadsToday} uploaded today</div>
            </article>
            <article className="rounded-[1.5rem] border border-border/70 bg-card/60 p-4">
              <div className="text-sm font-medium text-muted-foreground">Failed parses</div>
              <div className="mt-2 text-3xl font-semibold">{filesQuery.data.summary.failedParseFiles}</div>
              <div className="mt-2 text-sm text-muted-foreground">{analysisQuery.data.metrics.failed_jobs || 0} ingestion jobs currently problematic</div>
            </article>
            <article className="rounded-[1.5rem] border border-border/70 bg-card/60 p-4">
              <div className="text-sm font-medium text-muted-foreground">Deletion events</div>
              <div className="mt-2 text-3xl font-semibold">{deletionsQuery.data.summary.totalDeletions}</div>
              <div className="mt-2 text-sm text-muted-foreground">{deletionsQuery.data.summary.totalDeletedRecords} records removed</div>
            </article>
            <article className="rounded-[1.5rem] border border-border/70 bg-card/60 p-4">
              <div className="text-sm font-medium text-muted-foreground">Pipeline load</div>
              <div className="mt-2 text-3xl font-semibold">{analysisQuery.data.metrics.processing_jobs || 0}</div>
              <div className="mt-2 text-sm text-muted-foreground">{analysisQuery.data.metrics.queued_jobs || 0} jobs queued</div>
            </article>
          </div>

          {exportError ? (
            <div className="text-sm text-red-600 dark:text-red-300">{exportError}</div>
          ) : null}
        </div>
      </section>

      <Tabs defaultValue="uploads" className="space-y-4">
        <TabsList className="h-auto flex-wrap rounded-[1.25rem] p-1">
          <TabsTrigger value="uploads" className="rounded-xl px-4 py-2">
            Uploads
          </TabsTrigger>
          <TabsTrigger value="deletions" className="rounded-xl px-4 py-2">
            Deletions
          </TabsTrigger>
        </TabsList>

        <TabsContent value="uploads" className="space-y-4">
          <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2 xl:col-span-2">
                <label htmlFor="file-search" className="text-sm font-medium text-muted-foreground">
                  Search uploads
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="file-search"
                    value={uploadFilters.q}
                    onChange={(event) => updateUploadFilter('q', event.target.value)}
                    placeholder="Filename, case, uploader, module"
                    className="pl-10"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="file-case-id" className="text-sm font-medium text-muted-foreground">
                  Case ID
                </label>
                <Input
                  id="file-case-id"
                  value={uploadFilters.caseId}
                  onChange={(event) => updateUploadFilter('caseId', event.target.value)}
                  placeholder="Filter a specific case"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="file-module" className="text-sm font-medium text-muted-foreground">
                  Telecom module
                </label>
                <select
                  id="file-module"
                  value={uploadFilters.fileType}
                  onChange={(event) => updateUploadFilter('fileType', event.target.value)}
                  className="input-field h-11"
                >
                  <option value="">All modules</option>
                  <option value="cdr">CDR</option>
                  <option value="ipdr">IPDR</option>
                  <option value="sdr">SDR</option>
                  <option value="tower_dump">Tower Dump</option>
                  <option value="ild">ILD</option>
                </select>
              </div>

              <div className="space-y-2">
                <label htmlFor="file-parse-status" className="text-sm font-medium text-muted-foreground">
                  Parse status
                </label>
                <select
                  id="file-parse-status"
                  value={uploadFilters.parseStatus}
                  onChange={(event) => updateUploadFilter('parseStatus', event.target.value)}
                  className="input-field h-11"
                >
                  <option value="">All statuses</option>
                  <option value="pending">Pending</option>
                  <option value="processing">Processing</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                </select>
              </div>

              <div className="space-y-2">
                <label htmlFor="file-classification" className="text-sm font-medium text-muted-foreground">
                  Classification
                </label>
                <select
                  id="file-classification"
                  value={uploadFilters.classificationResult}
                  onChange={(event) => updateUploadFilter('classificationResult', event.target.value)}
                  className="input-field h-11"
                >
                  <option value="">All outcomes</option>
                  <option value="ACCEPTED">Accepted</option>
                  <option value="WRONG_TYPE">Wrong type</option>
                  <option value="REJECTED">Rejected</option>
                </select>
              </div>

              <div className="space-y-2">
                <label htmlFor="file-uploader" className="text-sm font-medium text-muted-foreground">
                  Uploader
                </label>
                <Input
                  id="file-uploader"
                  value={uploadFilters.uploader}
                  onChange={(event) => updateUploadFilter('uploader', event.target.value)}
                  placeholder="Officer name or buckle ID"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="file-date-from" className="text-sm font-medium text-muted-foreground">
                  Date from
                </label>
                <Input
                  id="file-date-from"
                  type="date"
                  value={uploadFilters.dateFrom}
                  onChange={(event) => updateUploadFilter('dateFrom', event.target.value)}
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="file-date-to" className="text-sm font-medium text-muted-foreground">
                  Date to
                </label>
                <Input
                  id="file-date-to"
                  type="date"
                  value={uploadFilters.dateTo}
                  onChange={(event) => updateUploadFilter('dateTo', event.target.value)}
                />
              </div>
            </div>

            <div className="mt-4 flex flex-wrap justify-end gap-3">
              <Button type="button" variant="outline" onClick={resetUploadFilters}>
                Reset Upload Filters
              </Button>
            </div>
          </section>

          <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-border/70 text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">File</th>
                    <th className="px-4 py-3 font-semibold">Case</th>
                    <th className="px-4 py-3 font-semibold">Module</th>
                    <th className="px-4 py-3 font-semibold">Parse</th>
                    <th className="px-4 py-3 font-semibold">Uploader</th>
                    <th className="px-4 py-3 font-semibold">Uploaded</th>
                    <th className="px-4 py-3 font-semibold text-right">Inspect</th>
                  </tr>
                </thead>
                <tbody>
                  {filesQuery.data.items.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8">
                        <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-5 text-center text-sm text-muted-foreground">
                          No uploads matched the current filters.
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filesQuery.data.items.map((file) => (
                      <tr key={file.id} className="border-b border-border/50 align-top last:border-b-0">
                        <td className="px-4 py-4">
                          <div className="font-medium">{file.original_name || file.file_name}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{file.file_name}</div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="font-medium">{file.case_name || 'No case'}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {file.case_number || 'No case number'}
                            {file.is_evidence_locked ? ' • Evidence locked' : ''}
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="font-medium">{file.telecom_module}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{file.classification_result || 'No classifier result'}</div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="font-medium">{file.parse_status}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{file.record_count} records</div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="font-medium">{file.uploaded_by_name || 'Unknown officer'}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{file.uploaded_by_buckle_id || 'No buckle ID'}</div>
                        </td>
                        <td className="px-4 py-4 text-muted-foreground">{formatTimestamp(file.uploaded_at)}</td>
                        <td className="px-4 py-4 text-right">
                          <Button type="button" variant="outline" size="sm" onClick={() => setSelectedUpload(file)}>
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
                Page {uploadsPage} of {uploadTotalPages}
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" disabled={uploadsPage <= 1} onClick={() => setUploadsPage((current) => current - 1)}>
                  Previous
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={uploadsPage >= uploadTotalPages} onClick={() => setUploadsPage((current) => current + 1)}>
                  Next
                </Button>
              </div>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="deletions" className="space-y-4">
          <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              <div className="space-y-2 xl:col-span-2">
                <label htmlFor="deletion-search" className="text-sm font-medium text-muted-foreground">
                  Search deletions
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="deletion-search"
                    value={deletionFilters.q}
                    onChange={(event) => updateDeletionFilter('q', event.target.value)}
                    placeholder="Filename, case, actor, deleted type"
                    className="pl-10"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="deletion-case-id" className="text-sm font-medium text-muted-foreground">
                  Case ID
                </label>
                <Input
                  id="deletion-case-id"
                  value={deletionFilters.caseId}
                  onChange={(event) => updateDeletionFilter('caseId', event.target.value)}
                  placeholder="Filter a specific case"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="deletion-type" className="text-sm font-medium text-muted-foreground">
                  Deleted type
                </label>
                <Input
                  id="deletion-type"
                  value={deletionFilters.deletedType}
                  onChange={(event) => updateDeletionFilter('deletedType', event.target.value)}
                  placeholder="cdr, ipdr, tower"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="deletion-actor" className="text-sm font-medium text-muted-foreground">
                  Actor
                </label>
                <Input
                  id="deletion-actor"
                  value={deletionFilters.actor}
                  onChange={(event) => updateDeletionFilter('actor', event.target.value)}
                  placeholder="Officer name or buckle ID"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="deletion-date-from" className="text-sm font-medium text-muted-foreground">
                  Date from
                </label>
                <Input
                  id="deletion-date-from"
                  type="date"
                  value={deletionFilters.dateFrom}
                  onChange={(event) => updateDeletionFilter('dateFrom', event.target.value)}
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="deletion-date-to" className="text-sm font-medium text-muted-foreground">
                  Date to
                </label>
                <Input
                  id="deletion-date-to"
                  type="date"
                  value={deletionFilters.dateTo}
                  onChange={(event) => updateDeletionFilter('dateTo', event.target.value)}
                />
              </div>
            </div>

            <div className="mt-4 flex flex-wrap justify-end gap-3">
              <Button type="button" variant="outline" onClick={resetDeletionFilters}>
                Reset Deletion Filters
              </Button>
            </div>
          </section>

          <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-border/70 text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">When</th>
                    <th className="px-4 py-3 font-semibold">Actor</th>
                    <th className="px-4 py-3 font-semibold">Case</th>
                    <th className="px-4 py-3 font-semibold">Deleted file</th>
                    <th className="px-4 py-3 font-semibold">Type</th>
                    <th className="px-4 py-3 font-semibold">Deleted records</th>
                    <th className="px-4 py-3 font-semibold text-right">Inspect</th>
                  </tr>
                </thead>
                <tbody>
                  {deletionsQuery.data.items.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8">
                        <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-5 text-center text-sm text-muted-foreground">
                          No deletions matched the current filters.
                        </div>
                      </td>
                    </tr>
                  ) : (
                    deletionsQuery.data.items.map((item) => {
                      const repeatKey = `${item.case_id || 'unknown'}:${item.file_name || item.file_id || item.audit_id}`
                      const isRepeated = (deletionRepeats.get(repeatKey) || 0) > 1

                      return (
                        <tr key={item.audit_id} className="border-b border-border/50 align-top last:border-b-0">
                          <td className="px-4 py-4 text-muted-foreground">{formatTimestamp(item.created_at)}</td>
                          <td className="px-4 py-4">
                            <div className="font-medium">{item.actor_name || 'Unknown officer'}</div>
                            <div className="mt-1 text-xs text-muted-foreground">{item.actor_buckle_id || item.actor_email || 'No actor ID'}</div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="font-medium">{item.case_name || 'Unknown case'}</div>
                            <div className="mt-1 text-xs text-muted-foreground">{item.case_number || 'No case number'}</div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="font-medium">{item.file_name || item.file_id || 'Unknown file'}</div>
                            <div className="mt-1 text-xs text-muted-foreground">{item.stored_file_name || 'No stored filename'}</div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="font-medium">{item.deleted_type}</div>
                            <div className={`mt-1 text-xs ${isRepeated ? 'text-red-600 dark:text-red-300' : 'text-muted-foreground'}`}>
                              {isRepeated ? 'Repeated deletion target in this view' : 'Single deletion event'}
                            </div>
                          </td>
                          <td className="px-4 py-4 font-medium">{item.deleted_records}</td>
                          <td className="px-4 py-4 text-right">
                            <Button type="button" variant="outline" size="sm" onClick={() => setSelectedDeletion(item)}>
                              Details
                            </Button>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-5 flex flex-col gap-3 border-t border-border/70 pt-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <div>
                Page {deletionsPage} of {deletionTotalPages}
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" disabled={deletionsPage <= 1} onClick={() => setDeletionsPage((current) => current - 1)}>
                  Previous
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={deletionsPage >= deletionTotalPages} onClick={() => setDeletionsPage((current) => current + 1)}>
                  Next
                </Button>
              </div>
            </div>
          </section>
        </TabsContent>
      </Tabs>

      <Dialog open={Boolean(selectedUpload)} onOpenChange={(open: boolean) => !open && setSelectedUpload(null)}>
        <DialogContent className="max-w-3xl rounded-[1.75rem] p-0">
          {selectedUpload ? (
            <>
              <DialogHeader className="border-b border-border/70 px-6 py-5">
                <DialogTitle>{selectedUpload.original_name || selectedUpload.file_name}</DialogTitle>
                <DialogDescription>
                  {selectedUpload.case_name || 'Unknown case'} • {formatTimestamp(selectedUpload.uploaded_at)}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-6 px-6 py-5 lg:grid-cols-[0.95fr_1.05fr]">
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Parse status</div>
                      <div className="mt-2 text-sm font-medium">{selectedUpload.parse_status}</div>
                    </div>
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Module</div>
                      <div className="mt-2 text-sm font-medium">{selectedUpload.telecom_module}</div>
                    </div>
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Classification</div>
                      <div className="mt-2 text-sm font-medium">{selectedUpload.classification_result || 'Unknown'}</div>
                    </div>
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Records</div>
                      <div className="mt-2 text-sm font-medium">{selectedUpload.record_count}</div>
                    </div>
                  </div>

                  <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4 text-sm">
                    <div className="font-medium">{selectedUpload.uploaded_by_name || 'Unknown officer'}</div>
                    <div className="mt-1 text-muted-foreground">{selectedUpload.uploaded_by_buckle_id || 'No buckle ID'}</div>
                    <div className="mt-3 flex flex-wrap gap-3 text-xs">
                      <Link to="/admin/cases" className="text-blue-700 hover:underline dark:text-blue-300">
                        Open cases view
                      </Link>
                      <Link
                        to={`/admin/activity?resourceType=file&resourceId=${encodeURIComponent(String(selectedUpload.id))}`}
                        className="text-blue-700 hover:underline dark:text-blue-300"
                      >
                        Open file activity
                      </Link>
                      {selectedUpload.case_id ? (
                        <Link to={`/admin/activity?caseId=${selectedUpload.case_id}`} className="text-blue-700 hover:underline dark:text-blue-300">
                          Open case activity
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="rounded-[1.25rem] border border-border/70 bg-slate-950 p-4 text-slate-100">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Classifier / Error Detail</div>
                  <pre className="mt-3 max-h-[24rem] overflow-auto text-xs whitespace-pre-wrap break-words">
                    {JSON.stringify(
                      {
                        expectedType: selectedUpload.expected_type,
                        detectedType: selectedUpload.detected_type,
                        confidence: selectedUpload.confidence,
                        errorMessage: selectedUpload.error_message,
                      },
                      null,
                      2
                    )}
                  </pre>
                </div>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setSelectedUpload(null)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(selectedDeletion)} onOpenChange={(open: boolean) => !open && setSelectedDeletion(null)}>
        <DialogContent className="max-w-3xl rounded-[1.75rem] p-0">
          {selectedDeletion ? (
            <>
              <DialogHeader className="border-b border-border/70 px-6 py-5">
                <DialogTitle>{selectedDeletion.file_name || 'Deleted file'}</DialogTitle>
                <DialogDescription>
                  {selectedDeletion.actor_name || 'Unknown officer'} • {formatTimestamp(selectedDeletion.created_at)}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-6 px-6 py-5 lg:grid-cols-[0.95fr_1.05fr]">
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Case</div>
                      <div className="mt-2 text-sm font-medium">{selectedDeletion.case_name || 'Unknown case'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{selectedDeletion.case_number || 'No case number'}</div>
                    </div>
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Deleted type</div>
                      <div className="mt-2 text-sm font-medium">{selectedDeletion.deleted_type}</div>
                    </div>
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Deleted records</div>
                      <div className="mt-2 text-sm font-medium">{selectedDeletion.deleted_records}</div>
                    </div>
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">IP address</div>
                      <div className="mt-2 text-sm font-medium">{selectedDeletion.ip_address || 'n/a'}</div>
                    </div>
                  </div>

                  <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4 text-sm">
                    <div className="font-medium">{selectedDeletion.actor_name || 'Unknown officer'}</div>
                    <div className="mt-1 text-muted-foreground">
                      {selectedDeletion.actor_buckle_id || selectedDeletion.actor_email || 'No actor ID'}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-3 text-xs">
                      {selectedDeletion.file_id ? (
                        <Link
                          to={`/admin/activity?resourceType=file&resourceId=${encodeURIComponent(selectedDeletion.file_id)}`}
                          className="text-blue-700 hover:underline dark:text-blue-300"
                        >
                          Open file activity
                        </Link>
                      ) : null}
                      {selectedDeletion.case_id ? (
                        <Link to={`/admin/activity?caseId=${selectedDeletion.case_id}`} className="text-blue-700 hover:underline dark:text-blue-300">
                          Open case activity
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="rounded-[1.25rem] border border-border/70 bg-slate-950 p-4 text-slate-100">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Deletion Audit Payload</div>
                  <pre className="mt-3 max-h-[24rem] overflow-auto text-xs whitespace-pre-wrap break-words">
                    {JSON.stringify(selectedDeletion.details || {}, null, 2)}
                  </pre>
                </div>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setSelectedDeletion(null)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
