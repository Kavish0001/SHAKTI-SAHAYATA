import { useEffect, useState } from 'react'
import { systemAPI } from '../lib/apis'
import { useAuthStore } from '../../stores/authStore'

type Diagnostics = Awaited<ReturnType<typeof systemAPI.getDiagnostics>>

type StatusTone = 'healthy' | 'warning' | 'error' | 'neutral'

const toneClasses: Record<StatusTone, string> = {
  healthy: 'border-emerald-200 bg-emerald-50/80 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300',
  warning: 'border-amber-200 bg-amber-50/80 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300',
  error: 'border-red-200 bg-red-50/80 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300',
      neutral: 'border-slate-200 bg-slate-50/80 text-slate-700 dark:border-slate-800 dark:bg-card/60 dark:text-slate-300',
}

function StatusCard({
  title,
  status,
  detail,
  tone,
}: {
  title: string
  status: string
  detail: string
  tone: StatusTone
}) {
  return (
    <div className={`rounded-xl border p-4 ${toneClasses[tone]}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-bold uppercase tracking-[0.18em]">{title}</p>
        <span className="text-xs font-semibold">{status}</span>
      </div>
      <p className="mt-2 text-sm leading-relaxed">{detail}</p>
    </div>
  )
}

function formatTime(value: string | null | undefined) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString()
}

export default function SystemDiagnosticsPanel() {
  const { user, token } = useAuthStore()
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [loading, setLoading] = useState(true)
  const [selfChecking, setSelfChecking] = useState(false)
  const [error, setError] = useState('')
  const [lastChecked, setLastChecked] = useState<string | null>(null)

  const loadDiagnostics = async () => {
    try {
      setLoading(true)
      setError('')
      const payload = await systemAPI.getDiagnostics()
      setDiagnostics(payload)
      setLastChecked(new Date().toISOString())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Diagnostics request failed')
      setDiagnostics(null)
      setLastChecked(new Date().toISOString())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadDiagnostics()
  }, [])

  const runSelfCheck = async () => {
    try {
      setSelfChecking(true)
      await systemAPI.runSelfCheck()
      await loadDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run self-check')
    } finally {
      setSelfChecking(false)
    }
  }

  const authTone: StatusTone = user && token ? 'healthy' : 'error'
  const backendTone: StatusTone = error ? 'error' : diagnostics?.backend?.status === 'ok' ? 'healthy' : 'warning'
  const dbTone: StatusTone = diagnostics?.database?.connected ? 'healthy' : diagnostics ? 'error' : 'neutral'
  const ollamaTone: StatusTone = diagnostics?.ollama?.available ? 'healthy' : diagnostics ? 'warning' : 'neutral'
  const readyStatus = diagnostics?.health?.ready?.status || 'unknown'
  const startupStatus = diagnostics?.health?.startup?.status || 'unknown'
  const backupStatus = diagnostics?.backups?.latestBackup?.status || 'unknown'
  const restoreStatus = diagnostics?.backups?.latestRestore?.status || 'unknown'
  const readinessTone: StatusTone = readyStatus === 'ready' ? 'healthy' : readyStatus === 'degraded' ? 'warning' : diagnostics ? 'error' : 'neutral'
  const startupTone: StatusTone = startupStatus === 'pass' ? 'healthy' : startupStatus === 'degraded' ? 'warning' : diagnostics ? 'error' : 'neutral'
  const backupTone: StatusTone = backupStatus === 'success' ? 'healthy' : diagnostics?.backups?.latestBackup ? 'warning' : 'neutral'
  const restoreTone: StatusTone = restoreStatus === 'verified' ? 'healthy' : diagnostics?.backups?.latestRestore ? 'warning' : 'neutral'

  const authDetail = user && token
    ? `${user.fullName || user.buckleId} is authenticated with the canonical token store.`
    : 'No authenticated user is available in the canonical frontend auth store.'

  const backendDetail = error
    ? error
    : diagnostics
      ? `Backend ${diagnostics.backend.version} is running in ${diagnostics.backend.mode} mode.`
      : 'Backend diagnostics not loaded yet.'

  const dbDetail = diagnostics?.database?.connected
    ? 'Database connectivity check passed.'
    : diagnostics?.database?.error || 'Database health has not been confirmed yet.'

  const ollamaDetail = diagnostics?.ollama?.available
    ? `Ollama reachable at ${diagnostics.ollama.baseUrl} using model ${diagnostics.ollama.model}.`
    : diagnostics?.ollama?.error || 'Ollama health has not been confirmed yet.'

  const chatbotDetail = diagnostics
    ? `Deterministic mode: ${diagnostics.chatbot.deterministicAvailable ? 'available' : 'unavailable'} • LLM mode: ${diagnostics.chatbot.llmAvailable ? 'available' : 'degraded'}`
    : 'Chatbot capability summary unavailable until diagnostics load.'

  const readyDetail = diagnostics?.health?.ready?.checks
    ? Object.entries(diagnostics.health.ready.checks)
        .map(([key, value]) => `${key}: ${value.status}${value.reason ? ` (${value.reason})` : ''}`)
        .join(' • ')
    : 'Readiness checks have not been loaded yet.'

  const startupDetail = diagnostics?.health?.startup?.checks
    ? Object.entries(diagnostics.health.startup.checks)
        .map(([key, value]) => `${key}: ${value.status}${value.reason ? ` (${value.reason})` : ''}`)
        .join(' • ')
    : 'Startup self-check report is not available yet.'

  const backupDetail = diagnostics?.backups?.latestBackup
    ? `Last backup ${formatTime(diagnostics.backups.latestBackup.completedAt)} • Cases ${diagnostics.backups.latestBackup.caseCount ?? 'n/a'} • Files ${diagnostics.backups.latestBackup.uploadedFileCount ?? 'n/a'}`
    : 'No backup metadata has been recorded yet.'

  const restoreDetail = diagnostics?.backups?.latestRestore
    ? `Last restore drill ${formatTime(diagnostics.backups.latestRestore.verifiedAt)} • Target ${diagnostics.backups.latestRestore.targetDatabase || 'n/a'}`
    : 'No restore verification has been recorded yet.'

  return (
    <section className="rounded-xl border border-border-light bg-card/70 p-6 dark:border-slate-800">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-xl font-black text-slate-900 dark:text-white">System Diagnostics</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Quick visibility into auth, backend, database, and Ollama health without opening DevTools.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {lastChecked ? `Last checked ${new Date(lastChecked).toLocaleString()}` : 'Not checked yet'}
          </div>
          <button
            type="button"
            onClick={() => void runSelfCheck()}
            disabled={loading || selfChecking}
            className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-semibold hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:bg-card dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {selfChecking ? 'Running self-check...' : 'Run self-check'}
          </button>
          <button
            type="button"
            onClick={() => void loadDiagnostics()}
            disabled={loading}
            className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-60"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatusCard title="Auth" status={user && token ? 'Authenticated' : 'Missing'} detail={authDetail} tone={authTone} />
        <StatusCard title="Backend" status={error ? 'Unavailable' : diagnostics?.backend?.status === 'ok' ? 'Healthy' : 'Unknown'} detail={backendDetail} tone={backendTone} />
        <StatusCard title="Database" status={diagnostics?.database?.connected ? 'Connected' : diagnostics ? 'Unavailable' : 'Unknown'} detail={dbDetail} tone={dbTone} />
        <StatusCard title="Ollama" status={diagnostics?.ollama?.available ? 'Reachable' : diagnostics ? 'Unavailable' : 'Unknown'} detail={ollamaDetail} tone={ollamaTone} />
      </div>

      <div className="mt-5">
        <div className="mb-3">
          <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-slate-700 dark:text-slate-300">
            Release Readiness
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Startup checks, readiness state, and backup/restore metadata for internal release operations.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <StatusCard title="Ready" status={readyStatus} detail={readyDetail} tone={readinessTone} />
          <StatusCard title="Startup" status={startupStatus} detail={startupDetail} tone={startupTone} />
          <StatusCard title="Last Backup" status={backupStatus} detail={backupDetail} tone={backupTone} />
          <StatusCard title="Restore Drill" status={restoreStatus} detail={restoreDetail} tone={restoreTone} />
        </div>
      </div>

        <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-800 dark:bg-card/60">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-slate-700 dark:text-slate-300">
            Chatbot Capability
          </h3>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {diagnostics?.requester?.buckleId || user?.buckleId || 'Unknown requester'}
          </span>
        </div>
        <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{chatbotDetail}</p>
      </div>

      <div className="mt-5">
        <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-slate-700 dark:text-slate-300">
          Raw Diagnostics
        </h3>
        <pre className="mt-2 rounded-xl border border-slate-200 bg-slate-950 text-slate-100 text-xs whitespace-pre-wrap break-words p-4 overflow-x-auto dark:border-slate-800">
          {diagnostics
            ? JSON.stringify(diagnostics, null, 2)
            : JSON.stringify({ error: error || 'Diagnostics not loaded yet' }, null, 2)}
        </pre>
      </div>
    </section>
  )
}
