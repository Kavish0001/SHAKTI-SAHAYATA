import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Database, HardDrive, RefreshCcw, ShieldCheck, TimerReset, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { adminConsoleAPI } from '../lib/api'
import type { AdminSystemStatusBlock } from '../types'
import { Button } from '@/components/ui/button'

const formatTimestamp = (value?: string | null) => {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

const formatMemory = (value?: number) => {
  if (!value || value <= 0) return '0 MB'
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

const getRecordValue = (record: Record<string, unknown> | null | undefined, keys: string[]) => {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value
    }
  }
  return null
}

const formatMetadataTimestamp = (record: Record<string, unknown> | null | undefined) =>
  formatTimestamp(
    (getRecordValue(record, ['completedAt', 'timestamp', 'startedAt', 'restoredAt']) as string | null | undefined) || null
  )

const statusTone = (status?: string) => {
  if (status === 'pass' || status === 'ready') return 'text-emerald-700 dark:text-emerald-300'
  if (status === 'fail' || status === 'not_ready') return 'text-red-700 dark:text-red-300'
  return 'text-amber-700 dark:text-amber-300'
}

function StatusCard({
  title,
  block,
  icon: Icon,
}: {
  title: string
  block: AdminSystemStatusBlock
  icon: typeof Database
}) {
  return (
    <article className="rounded-[1.5rem] border border-border/70 bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-muted-foreground">{title}</div>
          <div className={`mt-2 text-2xl font-semibold capitalize ${statusTone(block.status)}`}>{block.status}</div>
        </div>
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-900 text-white dark:bg-white dark:text-slate-900">
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <div className="mt-3 text-sm text-muted-foreground">{block.detail}</div>
      <div className="mt-3 text-xs text-muted-foreground">Checked {formatTimestamp(block.checkedAt as string | null | undefined)}</div>
    </article>
  )
}

export default function AdminSystemPage() {
  const queryClient = useQueryClient()

  const healthQuery = useQuery({
    queryKey: ['admin-system-health'],
    queryFn: () => adminConsoleAPI.getSystemHealth(),
    refetchInterval: 30000,
  })

  const selfCheckMutation = useMutation({
    mutationFn: () => adminConsoleAPI.runSystemSelfCheck(),
    onSuccess: async (payload) => {
      toast.success(`System self-check completed with status ${payload.status}.`)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-system-health'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-alerts'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
      ])
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to run system self-check.')
    },
  })

  if (healthQuery.isLoading) {
    return <div className="page-loading">Loading system operations view...</div>
  }

  if (healthQuery.isError || !healthQuery.data) {
    return (
      <div className="page-error">
        <AlertTriangle className="h-8 w-8" />
        <div>Failed to load the system operations view.</div>
      </div>
    )
  }

  const snapshot = healthQuery.data
  const latestBackup = (snapshot.backups.latestBackup || null) as Record<string, unknown> | null
  const latestRestore = (snapshot.backups.latestRestore || null) as Record<string, unknown> | null
  const securityCards = [
    { title: 'TOTP Enforcement', block: snapshot.security.totp, icon: ShieldCheck },
    { title: 'Session Rotation', block: snapshot.security.sessionRotation, icon: TimerReset },
    { title: 'Network Restriction', block: snapshot.security.networkRestriction, icon: Workflow },
    { title: 'Recent Auth Policy', block: snapshot.security.recentAuth, icon: RefreshCcw },
  ]

  return (
    <div className="space-y-6">
      <section className="rounded-[1.75rem] border border-border/70 bg-card p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl space-y-2">
            <div className="inline-flex rounded-full border border-blue-300/40 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
              System Operations
            </div>
            <h2 className="text-3xl font-semibold tracking-tight">Operational health, security posture, and self-check control.</h2>
            <p className="text-sm leading-7 text-muted-foreground">
              This page consolidates backend readiness, database and uploads state, backup metadata, retention health, and the guardrails that make the admin console safe to run in staging and production.
            </p>
          </div>

          <div className="flex flex-col items-start gap-3 xl:items-end">
            <div className={`text-sm font-semibold uppercase tracking-[0.18em] ${statusTone(snapshot.overallStatus)}`}>
              Overall status: {snapshot.overallStatus}
            </div>
            <Button type="button" onClick={() => selfCheckMutation.mutate()} disabled={selfCheckMutation.isPending}>
              <RefreshCcw className="h-4 w-4" />
              {selfCheckMutation.isPending ? 'Running self-check…' : 'Run Self-Check'}
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatusCard title="Backend Readiness" block={{ status: snapshot.backend.ready.status, detail: `Backend readiness is ${snapshot.backend.ready.status}.`, checkedAt: snapshot.backend.ready.timestamp }} icon={Workflow} />
        <StatusCard title="Database" block={snapshot.database} icon={Database} />
        <StatusCard title="Uploads" block={snapshot.uploads} icon={HardDrive} />
        <StatusCard title="Backups" block={snapshot.backups} icon={TimerReset} />
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <article className="rounded-[1.75rem] border border-border/70 bg-card p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xl font-semibold">Operational Snapshot</h3>
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{formatTimestamp(snapshot.generatedAt)}</div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Database latency</div>
              <div className="mt-2 text-2xl font-semibold">{snapshot.database.latencyMs || 0} ms</div>
              <div className="mt-2 text-sm text-muted-foreground">Server time {formatTimestamp(snapshot.database.serverTime as string | null | undefined)}</div>
            </div>
            <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Uploads directory</div>
              <div className="mt-2 text-2xl font-semibold">{snapshot.uploads.topLevelFileCount || 0}</div>
              <div className="mt-2 text-sm text-muted-foreground">Top-level files at {String(snapshot.uploads.path || 'n/a')}</div>
            </div>
            <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Runtime memory</div>
              <div className="mt-2 text-2xl font-semibold">{formatMemory(snapshot.runtime.memory?.rss)}</div>
              <div className="mt-2 text-sm text-muted-foreground">Heap used {formatMemory(snapshot.runtime.memory?.heapUsed)}</div>
            </div>
            <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Retention</div>
              <div className="mt-2 text-2xl font-semibold">{snapshot.retention.lastResult?.deletedActionLogs ?? 0}</div>
              <div className="mt-2 text-sm text-muted-foreground">Last cleanup removed audit rows</div>
            </div>
          </div>
        </article>

        <article className="rounded-[1.75rem] border border-border/70 bg-card p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xl font-semibold">Recent Self-Checks</h3>
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{snapshot.selfChecks.length} runs</div>
          </div>

          <div className="mt-4 space-y-3">
            {snapshot.selfChecks.length === 0 ? (
              <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-5 text-sm text-muted-foreground">
                No admin-triggered self-checks have been logged yet.
              </div>
            ) : (
              snapshot.selfChecks.map((run) => (
                <div key={run.id} className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm font-semibold uppercase tracking-[0.16em] ${statusTone(run.status)}`}>{run.status}</span>
                    <span className="text-xs text-muted-foreground">{run.durationMs || 0} ms</span>
                  </div>
                  <div className="mt-2 text-sm text-muted-foreground">
                    {run.actorName} • {formatTimestamp(run.createdAt)}
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    Failed: {run.failedChecks.join(', ') || 'none'} • Degraded: {run.degradedChecks.join(', ') || 'none'}
                  </div>
                </div>
              ))
            )}
          </div>
        </article>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-[1.75rem] border border-border/70 bg-card p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xl font-semibold">Latest Backup Metadata</h3>
            <span className={`text-xs font-semibold uppercase tracking-[0.16em] ${statusTone(String(getRecordValue(latestBackup, ['status', 'result']) || snapshot.backups.status))}`}>
              {String(getRecordValue(latestBackup, ['status', 'result']) || snapshot.backups.status)}
            </span>
          </div>

          {latestBackup ? (
            <div className="mt-4 space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                  <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Completed</div>
                  <div className="mt-2 text-sm font-medium">{formatMetadataTimestamp(latestBackup)}</div>
                </div>
                <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                  <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Artifact</div>
                  <div className="mt-2 text-sm font-medium break-all">{String(getRecordValue(latestBackup, ['artifact', 'path', 'file', 'backupFile']) || 'Not recorded')}</div>
                </div>
              </div>
              <pre className="overflow-auto rounded-[1.25rem] border border-border/70 bg-slate-950 p-4 text-xs text-slate-100 whitespace-pre-wrap break-words">
                {JSON.stringify(latestBackup, null, 2)}
              </pre>
            </div>
          ) : (
            <div className="mt-4 rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-5 text-sm text-muted-foreground">
              No backup metadata is currently available in the health snapshot.
            </div>
          )}
        </article>

        <article className="rounded-[1.75rem] border border-border/70 bg-card p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xl font-semibold">Latest Restore Drill Metadata</h3>
            <span className={`text-xs font-semibold uppercase tracking-[0.16em] ${statusTone(String(getRecordValue(latestRestore, ['status', 'result']) || 'unknown'))}`}>
              {String(getRecordValue(latestRestore, ['status', 'result']) || 'unknown')}
            </span>
          </div>

          {latestRestore ? (
            <div className="mt-4 space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                  <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Completed</div>
                  <div className="mt-2 text-sm font-medium">{formatMetadataTimestamp(latestRestore)}</div>
                </div>
                <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                  <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Source Backup</div>
                  <div className="mt-2 text-sm font-medium break-all">{String(getRecordValue(latestRestore, ['sourceBackup', 'sourceBackupId', 'backupId', 'artifact']) || 'Not recorded')}</div>
                </div>
              </div>
              <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4 text-sm text-muted-foreground">
                {String(getRecordValue(latestRestore, ['summary', 'detail', 'note', 'message']) || 'No restore-drill summary was recorded.')}
              </div>
              <pre className="overflow-auto rounded-[1.25rem] border border-border/70 bg-slate-950 p-4 text-xs text-slate-100 whitespace-pre-wrap break-words">
                {JSON.stringify(latestRestore, null, 2)}
              </pre>
            </div>
          ) : (
            <div className="mt-4 rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-5 text-sm text-muted-foreground">
              No restore or restore-drill metadata is currently available in the health snapshot.
            </div>
          )}
        </article>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {securityCards.map((card) => (
          <StatusCard key={card.title} title={card.title} block={card.block} icon={card.icon} />
        ))}
      </section>

      <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
        <h3 className="text-xl font-semibold">Retention Policy</h3>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
            <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Admin sessions</div>
            <div className="mt-2 text-2xl font-semibold">{snapshot.retention.policies.sessionDays} days</div>
          </div>
          <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
            <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Refresh tokens</div>
            <div className="mt-2 text-2xl font-semibold">{snapshot.retention.policies.refreshTokenDays} days</div>
          </div>
          <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
            <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Action logs</div>
            <div className="mt-2 text-2xl font-semibold">{snapshot.retention.policies.actionLogDays} days</div>
          </div>
        </div>
      </section>
    </div>
  )
}
