import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Search } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import type { ActivityEvent } from '../types'
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

const PAGE_SIZE = 25

const emptyFilters = {
  q: '',
  source: '',
  actorType: '',
  actor: '',
  action: '',
  resourceType: '',
  resourceId: '',
  caseId: '',
  sessionId: '',
  ipAddress: '',
  dateFrom: '',
  dateTo: '',
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

export default function AdminActivityPage() {
  const [searchParams] = useSearchParams()
  const [filters, setFilters] = useState(() => ({
    ...emptyFilters,
    q: searchParams.get('q') || '',
    resourceType: searchParams.get('resourceType') || '',
    caseId: searchParams.get('caseId') || '',
    resourceId: searchParams.get('resourceId') || '',
    sessionId: searchParams.get('sessionId') || '',
  }))
  const [page, setPage] = useState(1)
  const [selectedEvent, setSelectedEvent] = useState<ActivityEvent | null>(null)

  const activityQuery = useQuery({
    queryKey: ['admin-activity', filters, page],
    queryFn: () =>
      adminConsoleAPI.getActivity({
        ...filters,
        page,
        limit: PAGE_SIZE,
        dateFrom: toStartOfDayIso(filters.dateFrom),
        dateTo: toEndOfDayIso(filters.dateTo),
      }),
    refetchInterval: 15000,
  })

  const updateFilter = (key: keyof typeof emptyFilters, value: string) => {
    setPage(1)
    setFilters((current) => ({ ...current, [key]: value }))
  }

  const clearFilters = () => {
    setFilters(emptyFilters)
    setPage(1)
    setSelectedEvent(null)
  }

  if (activityQuery.isLoading) {
    return <div className="page-loading">Loading activity feed...</div>
  }

  if (activityQuery.isError || !activityQuery.data) {
    return (
      <div className="page-error">
        <AlertTriangle className="h-8 w-8" />
        <div>Failed to load the admin activity feed.</div>
      </div>
    )
  }

  const items = activityQuery.data.items
  const total = activityQuery.data.pagination.total
  const totalPages = Math.max(1, Math.ceil(total / activityQuery.data.pagination.pageSize))

  return (
    <div className="space-y-6">
      <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-2">
              <div className="inline-flex rounded-full border border-blue-300/40 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
                Global Activity Feed
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">Unified audit timeline for officer and admin actions.</h2>
              <p className="text-sm leading-6 text-muted-foreground">
                Search across actors, sessions, IP addresses, resources, and raw detail payloads. The feed refreshes every 15 seconds to keep live operations visible.
              </p>
            </div>
            <div className="text-sm text-muted-foreground">
              {total} events
              {activityQuery.isFetching ? ' • Refreshing…' : ' • Live polling enabled'}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-2 xl:col-span-2">
              <label htmlFor="activity-search" className="text-sm font-medium text-muted-foreground">
                Search everything
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="activity-search"
                  value={filters.q}
                  onChange={(event) => updateFilter('q', event.target.value)}
                  placeholder="Actor, action, resource, or JSON detail"
                  className="pl-10"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="activity-source" className="text-sm font-medium text-muted-foreground">
                Source
              </label>
              <select
                id="activity-source"
                value={filters.source}
                onChange={(event) => updateFilter('source', event.target.value)}
                className="input-field h-11"
              >
                <option value="">All sources</option>
                <option value="audit">Officer audit</option>
                <option value="admin">Admin actions</option>
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="activity-actor-type" className="text-sm font-medium text-muted-foreground">
                Actor type
              </label>
              <select
                id="activity-actor-type"
                value={filters.actorType}
                onChange={(event) => updateFilter('actorType', event.target.value)}
                className="input-field h-11"
              >
                <option value="">All actors</option>
                <option value="officer">Officer</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="activity-actor" className="text-sm font-medium text-muted-foreground">
                Actor
              </label>
              <Input
                id="activity-actor"
                value={filters.actor}
                onChange={(event) => updateFilter('actor', event.target.value)}
                placeholder="Name, email, or actor ID"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="activity-action" className="text-sm font-medium text-muted-foreground">
                Action
              </label>
              <Input
                id="activity-action"
                value={filters.action}
                onChange={(event) => updateFilter('action', event.target.value)}
                placeholder="FILE_DELETE, ADMIN_LOGIN"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="activity-resource-type" className="text-sm font-medium text-muted-foreground">
                Resource type
              </label>
              <Input
                id="activity-resource-type"
                value={filters.resourceType}
                onChange={(event) => updateFilter('resourceType', event.target.value)}
                placeholder="case, session, file"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="activity-resource-id" className="text-sm font-medium text-muted-foreground">
                Resource ID
              </label>
              <Input
                id="activity-resource-id"
                value={filters.resourceId}
                onChange={(event) => updateFilter('resourceId', event.target.value)}
                placeholder="Specific resource identifier"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="activity-case-id" className="text-sm font-medium text-muted-foreground">
                Case ID
              </label>
              <Input
                id="activity-case-id"
                value={filters.caseId}
                onChange={(event) => updateFilter('caseId', event.target.value)}
                placeholder="Filter case resource rows"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="activity-session-id" className="text-sm font-medium text-muted-foreground">
                Session ID
              </label>
              <Input
                id="activity-session-id"
                value={filters.sessionId}
                onChange={(event) => updateFilter('sessionId', event.target.value)}
                placeholder="Exact session identifier"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="activity-ip" className="text-sm font-medium text-muted-foreground">
                IP address
              </label>
              <Input
                id="activity-ip"
                value={filters.ipAddress}
                onChange={(event) => updateFilter('ipAddress', event.target.value)}
                placeholder="10.0.0.24"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="activity-date-from" className="text-sm font-medium text-muted-foreground">
                Date from
              </label>
              <Input
                id="activity-date-from"
                type="date"
                value={filters.dateFrom}
                onChange={(event) => updateFilter('dateFrom', event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="activity-date-to" className="text-sm font-medium text-muted-foreground">
                Date to
              </label>
              <Input
                id="activity-date-to"
                type="date"
                value={filters.dateTo}
                onChange={(event) => updateFilter('dateTo', event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-3">
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
                <th className="px-4 py-3 font-semibold">Time</th>
                <th className="px-4 py-3 font-semibold">Actor</th>
                <th className="px-4 py-3 font-semibold">Action</th>
                <th className="px-4 py-3 font-semibold">Resource</th>
                <th className="px-4 py-3 font-semibold">Session / IP</th>
                <th className="px-4 py-3 font-semibold">Source</th>
                <th className="px-4 py-3 font-semibold text-right">Inspect</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8">
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-5 text-center text-sm text-muted-foreground">
                      No activity matched the current filters.
                    </div>
                  </td>
                </tr>
              ) : (
                items.map((event) => (
                  <tr key={`${event.source}-${event.id}`} className="border-b border-border/50 align-top last:border-b-0">
                    <td className="px-4 py-4 text-muted-foreground">{formatTimestamp(event.created_at)}</td>
                    <td className="px-4 py-4">
                      <div className="font-medium">{event.actor_name || 'Unknown actor'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {event.actor_email || event.actor_id || 'No actor identifier'}
                      </div>
                      <div className="mt-2 inline-flex rounded-full border border-border/70 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        {event.actor_type}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-medium">{event.action}</div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-medium">{event.resource_type || 'resource'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{event.resource_id || 'No resource ID'}</div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-medium">{event.session_id || 'No session'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{event.ip_address || 'No IP address'}</div>
                    </td>
                    <td className="px-4 py-4">
                      <span className="inline-flex rounded-full border border-border/70 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        {event.source}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <Button type="button" variant="outline" size="sm" onClick={() => setSelectedEvent(event)}>
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </section>

      <Dialog open={Boolean(selectedEvent)} onOpenChange={(open: boolean) => !open && setSelectedEvent(null)}>
        <DialogContent className="max-w-3xl rounded-[1.75rem] p-0">
          {selectedEvent ? (
            <>
              <DialogHeader className="border-b border-border/70 px-6 py-5">
                <DialogTitle>{selectedEvent.action}</DialogTitle>
                <DialogDescription>
                  {selectedEvent.actor_name || 'Unknown actor'} • {formatTimestamp(selectedEvent.created_at)}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-6 px-6 py-5 lg:grid-cols-[0.9fr_1.1fr]">
                <div className="space-y-3">
                  <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                    <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Actor</div>
                    <div className="mt-2 text-sm font-medium">{selectedEvent.actor_name || 'Unknown actor'}</div>
                    <div className="mt-1 text-sm text-muted-foreground">{selectedEvent.actor_email || 'No email recorded'}</div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {selectedEvent.actor_type} {selectedEvent.actor_role ? `• ${selectedEvent.actor_role}` : ''}
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Resource</div>
                      <div className="mt-2 text-sm font-medium">{selectedEvent.resource_type || 'n/a'}</div>
                    </div>
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Resource ID</div>
                      <div className="mt-2 text-sm font-medium break-all">{selectedEvent.resource_id || 'n/a'}</div>
                    </div>
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Session</div>
                      <div className="mt-2 text-sm font-medium break-all">{selectedEvent.session_id || 'n/a'}</div>
                    </div>
                    <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">IP Address</div>
                      <div className="mt-2 text-sm font-medium">{selectedEvent.ip_address || 'n/a'}</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-[1.25rem] border border-border/70 bg-slate-950 p-4 text-slate-100">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Raw Details JSON</div>
                  <pre className="mt-3 max-h-[26rem] overflow-auto text-xs whitespace-pre-wrap break-words">
                    {JSON.stringify(selectedEvent.details || {}, null, 2)}
                  </pre>
                </div>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setSelectedEvent(null)}>
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
