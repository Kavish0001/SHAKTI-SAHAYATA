import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { ApiError } from '../../lib/apiClient'
import AdminRecentAuthDialog from '../components/AdminRecentAuthDialog'
import { adminConsoleAPI } from '../lib/api'
import type { AdminAlertItem } from '../types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

const toneClass = (severity: string) => {
  if (severity === 'critical') return 'border-red-300/40 bg-red-50 dark:border-red-500/20 dark:bg-red-500/10'
  if (severity === 'warning') return 'border-amber-300/40 bg-amber-50 dark:border-amber-500/20 dark:bg-amber-500/10'
  return 'border-blue-300/40 bg-blue-50 dark:border-blue-500/20 dark:bg-blue-500/10'
}

const formatTimestamp = (value?: string | null) => {
  if (!value) return 'Not acknowledged'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not acknowledged' : date.toLocaleString()
}

export default function AdminAlertsPage() {
  const queryClient = useQueryClient()
  const [selectedAlert, setSelectedAlert] = useState<AdminAlertItem | null>(null)
  const [ackNote, setAckNote] = useState('')
  const [recentAuthOpen, setRecentAuthOpen] = useState(false)

  const alertsQuery = useQuery({
    queryKey: ['admin-alerts'],
    queryFn: () => adminConsoleAPI.getAlerts(),
    refetchInterval: 30000,
  })

  const acknowledgeMutation = useMutation({
    mutationFn: ({ alertId, note }: { alertId: string; note: string }) => adminConsoleAPI.acknowledgeAlert(alertId, note),
    onSuccess: async () => {
      toast.success('Alert acknowledged.')
      setSelectedAlert(null)
      setAckNote('')
      await queryClient.invalidateQueries({ queryKey: ['admin-alerts'] })
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'RECENT_ADMIN_AUTH_REQUIRED') {
        setRecentAuthOpen(true)
        return
      }
      toast.error(error instanceof Error ? error.message : 'Failed to acknowledge alert.')
    },
  })

  const grouped = useMemo(() => {
    const items = alertsQuery.data?.items || []
    return {
      critical: items.filter((item) => item.severity === 'critical'),
      warning: items.filter((item) => item.severity === 'warning'),
      info: items.filter((item) => item.severity === 'info'),
    }
  }, [alertsQuery.data?.items])

  if (alertsQuery.isLoading) {
    return <div className="page-loading">Loading alerts center...</div>
  }

  if (alertsQuery.isError || !alertsQuery.data) {
    return (
      <div className="page-error">
        <AlertTriangle className="h-8 w-8" />
        <div>Failed to load the alerts center.</div>
      </div>
    )
  }

  const sections: Array<{ key: keyof typeof grouped; title: string }> = [
    { key: 'critical', title: 'Critical' },
    { key: 'warning', title: 'Warning' },
    { key: 'info', title: 'Info' },
  ]

  const handleConfirmAck = async () => {
    if (!selectedAlert) return
    await acknowledgeMutation.mutateAsync({ alertId: selectedAlert.id, note: ackNote.trim() })
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[1.75rem] border border-border/70 bg-card p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl space-y-2">
            <div className="inline-flex rounded-full border border-red-300/40 bg-red-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
              Alerts Center
            </div>
            <h2 className="text-3xl font-semibold tracking-tight">Active operational issues in one queue.</h2>
            <p className="text-sm leading-7 text-muted-foreground">
              Alerts aggregate health regressions, failed logins, deletion spikes, stalled sessions, and failed self-checks into a single attention queue with remediation targets.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Active</div>
              <div className="mt-2 text-2xl font-semibold">{alertsQuery.data.summary.total}</div>
            </div>
            <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Critical</div>
              <div className="mt-2 text-2xl font-semibold">{alertsQuery.data.summary.critical}</div>
            </div>
            <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
              <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Acknowledged</div>
              <div className="mt-2 text-2xl font-semibold">{alertsQuery.data.summary.acknowledged}</div>
            </div>
          </div>
        </div>
      </section>

      {sections.map((section) => (
        <section key={section.key} className="rounded-[1.75rem] border border-border/70 bg-card p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xl font-semibold">{section.title}</h3>
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{grouped[section.key].length} alerts</span>
          </div>

          <div className="mt-4 space-y-3">
            {grouped[section.key].length === 0 ? (
              <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-5 text-sm text-muted-foreground">
                No {section.title.toLowerCase()} alerts right now.
              </div>
            ) : (
              grouped[section.key].map((alert) => (
                <article key={alert.id} className={`rounded-[1.25rem] border px-4 py-4 ${toneClass(alert.severity)}`}>
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{alert.rule.replace(/_/g, ' ')}</span>
                        {alert.acknowledged ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Acknowledged
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full border border-red-400/20 bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-red-700 dark:text-red-300">
                            <ShieldAlert className="h-3.5 w-3.5" />
                            Needs attention
                          </span>
                        )}
                      </div>
                      <div className="text-lg font-semibold">{alert.title}</div>
                      <div className="text-sm text-muted-foreground">{alert.summary}</div>
                      <div className="text-sm text-muted-foreground">
                        Metric {String(alert.metric)} • Threshold {String(alert.threshold)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {alert.acknowledged
                          ? `Acknowledged by ${alert.acknowledgedBy || 'Unknown admin'} at ${formatTimestamp(alert.acknowledgedAt)}`
                          : 'Not yet acknowledged'}
                      </div>
                    </div>

                    <div className="flex flex-col items-start gap-2 xl:items-end">
                      <Link to={alert.href} className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-300">
                        Open remediation target
                      </Link>
                      <Button type="button" variant="outline" onClick={() => { setSelectedAlert(alert); setAckNote(alert.note || '') }}>
                        {alert.acknowledged ? 'Update Acknowledgement' : 'Acknowledge'}
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 text-sm text-muted-foreground">
                    Remediation: {alert.remediation}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      ))}

      <Dialog open={Boolean(selectedAlert)} onOpenChange={(open: boolean) => !open && setSelectedAlert(null)}>
        <DialogContent className="max-w-lg rounded-[1.75rem]">
          {selectedAlert ? (
            <>
              <DialogHeader>
                <DialogTitle>{selectedAlert.acknowledged ? 'Update alert acknowledgement' : 'Acknowledge alert'}</DialogTitle>
                <DialogDescription>
                  Record who reviewed this alert and capture any remediation note that other IT admins should see.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4 text-sm">
                  <div className="font-medium">{selectedAlert.title}</div>
                  <div className="mt-1 text-muted-foreground">{selectedAlert.summary}</div>
                </div>

                <div className="space-y-2">
                  <label htmlFor="alert-ack-note" className="text-sm font-medium text-muted-foreground">
                    Acknowledgement note
                  </label>
                  <Textarea
                    id="alert-ack-note"
                    value={ackNote}
                    onChange={(event) => setAckNote(event.target.value)}
                    placeholder="Summarize the current remediation step, owner, or expected follow-up."
                    rows={4}
                  />
                </div>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setSelectedAlert(null)}>
                  Cancel
                </Button>
                <Button type="button" disabled={acknowledgeMutation.isPending} onClick={() => void handleConfirmAck()}>
                  {acknowledgeMutation.isPending ? 'Saving…' : 'Confirm Acknowledgement'}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <AdminRecentAuthDialog
        open={recentAuthOpen}
        onOpenChange={setRecentAuthOpen}
        title="Recent auth required to acknowledge alerts"
        description="Acknowledge is treated as an operational write, so the console requires fresh admin verification before saving it."
        onSuccess={async () => {
          setRecentAuthOpen(false)
          if (selectedAlert) {
            await handleConfirmAck()
          }
        }}
      />
    </div>
  )
}
