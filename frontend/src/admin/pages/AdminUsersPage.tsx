import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, LogOut, ShieldCheck, Users } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ApiError } from '../../lib/apiClient'
import AdminRecentAuthDialog from '../components/AdminRecentAuthDialog'
import type { AdminSessionRow } from '../types'
import { adminConsoleAPI } from '../lib/api'
import { useAdminAuthStore } from '../store/adminAuthStore'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

const formatTimestamp = (value?: string | null) => {
  if (!value) return 'Never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Never' : date.toLocaleString()
}

const formatSessionAge = (value: number) => {
  if (!Number.isFinite(value) || value < 0) return 'Unknown'

  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)

  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export default function AdminUsersPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const logout = useAdminAuthStore((state) => state.logout)
  const currentSessionId = useAdminAuthStore((state) => state.session?.id ?? null)

  const [activeOnly, setActiveOnly] = useState(true)
  const [targetSession, setTargetSession] = useState<AdminSessionRow | null>(null)
  const [forceLogoutReason, setForceLogoutReason] = useState('Suspicious or stale session ended by IT')
  const [recentAuthOpen, setRecentAuthOpen] = useState(false)

  const usersQuery = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => adminConsoleAPI.getUsers(),
    refetchInterval: 30000,
  })

  const sessionsQuery = useQuery({
    queryKey: ['admin-sessions', activeOnly],
    queryFn: () => adminConsoleAPI.getSessions(activeOnly),
    refetchInterval: 15000,
  })

  const allSessions = useMemo(() => {
    const payload = sessionsQuery.data
    if (!payload) return []

    return [...payload.officerSessions, ...payload.adminSessions].sort(
      (left, right) => new Date(right.started_at).getTime() - new Date(left.started_at).getTime()
    )
  }, [sessionsQuery.data])

  const forceLogoutMutation = useMutation({
    mutationFn: async (session: AdminSessionRow) =>
      adminConsoleAPI.forceLogout(session.id, session.session_type, forceLogoutReason.trim() || 'admin_forced'),
    onSuccess: async (_result, session) => {
      toast.success(`${session.actor_name} was signed out successfully.`)
      setTargetSession(null)
      setForceLogoutReason('Suspicious or stale session ended by IT')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
      ])

      if (session.session_type === 'admin' && session.id === currentSessionId) {
        await logout()
        navigate('/admin/login', { replace: true })
      }
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'RECENT_ADMIN_AUTH_REQUIRED') {
        setRecentAuthOpen(true)
        return
      }
      const message = error instanceof Error ? error.message : 'Failed to force logout the selected session.'
      toast.error(message)
    },
  })

  if (usersQuery.isLoading || sessionsQuery.isLoading) {
    return <div className="page-loading">Loading users and sessions...</div>
  }

  if (usersQuery.isError || sessionsQuery.isError || !usersQuery.data || !sessionsQuery.data) {
    return (
      <div className="page-error">
        <AlertTriangle className="h-8 w-8" />
        <div>Failed to load the users and sessions view.</div>
      </div>
    )
  }

  const { officers, admins, summary } = usersQuery.data

  return (
    <div className="space-y-6">
      <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-2">
              <div className="inline-flex rounded-full border border-blue-300/40 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
                Users & Sessions
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">Monitor account usage and control live sessions.</h2>
              <p className="text-sm leading-6 text-muted-foreground">
                Track officer and admin activity, review active sessions, and remove stale or suspicious sessions without leaving the admin console.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button type="button" variant={activeOnly ? 'default' : 'outline'} onClick={() => setActiveOnly((current) => !current)}>
                {activeOnly ? 'Showing active sessions only' : 'Showing active and ended sessions'}
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <article className="rounded-[1.5rem] border border-border/70 bg-card/60 p-4">
              <div className="text-sm font-medium text-muted-foreground">Officer accounts</div>
              <div className="mt-2 text-3xl font-semibold">{summary.totalOfficers}</div>
              <div className="mt-2 text-sm text-muted-foreground">{summary.activeOfficerSessions} active officer sessions</div>
            </article>
            <article className="rounded-[1.5rem] border border-border/70 bg-card/60 p-4">
              <div className="text-sm font-medium text-muted-foreground">Admin accounts</div>
              <div className="mt-2 text-3xl font-semibold">{summary.totalAdmins}</div>
              <div className="mt-2 text-sm text-muted-foreground">{summary.activeAdminSessions} active admin sessions</div>
            </article>
            <article className="rounded-[1.5rem] border border-border/70 bg-card/60 p-4">
              <div className="text-sm font-medium text-muted-foreground">Live sessions in view</div>
              <div className="mt-2 text-3xl font-semibold">{allSessions.length}</div>
              <div className="mt-2 text-sm text-muted-foreground">
                {activeOnly ? 'Current live sessions only' : 'Recent session history included'}
              </div>
            </article>
            <article className="rounded-[1.5rem] border border-border/70 bg-card/60 p-4">
              <div className="text-sm font-medium text-muted-foreground">Auto refresh</div>
              <div className="mt-2 text-3xl font-semibold">15s</div>
              <div className="mt-2 text-sm text-muted-foreground">
                Session table refresh cadence for near-live visibility
              </div>
            </article>
          </div>
        </div>
      </section>

      <Tabs defaultValue="officers" className="space-y-4">
        <TabsList className="h-auto flex-wrap rounded-[1.25rem] p-1">
          <TabsTrigger value="officers" className="rounded-xl px-4 py-2">
            Officers
          </TabsTrigger>
          <TabsTrigger value="admins" className="rounded-xl px-4 py-2">
            Admins
          </TabsTrigger>
          <TabsTrigger value="sessions" className="rounded-xl px-4 py-2">
            Active Sessions
          </TabsTrigger>
        </TabsList>

        <TabsContent value="officers">
          <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-border/70 text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">Officer</th>
                    <th className="px-4 py-3 font-semibold">Buckle ID</th>
                    <th className="px-4 py-3 font-semibold">Role</th>
                    <th className="px-4 py-3 font-semibold">Cases</th>
                    <th className="px-4 py-3 font-semibold">Last login</th>
                    <th className="px-4 py-3 font-semibold">Sessions</th>
                  </tr>
                </thead>
                <tbody>
                  {officers.map((officer) => (
                    <tr key={officer.id} className="border-b border-border/50 align-top last:border-b-0">
                      <td className="px-4 py-4">
                        <div className="font-medium">{officer.full_name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{officer.email}</div>
                        <div className="mt-2 text-xs text-muted-foreground">
                          {officer.position || 'Officer'} {officer.station ? `• ${officer.station}` : ''}
                        </div>
                      </td>
                      <td className="px-4 py-4 text-muted-foreground">{officer.buckle_id || 'n/a'}</td>
                      <td className="px-4 py-4">
                        <span className="inline-flex rounded-full border border-border/70 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                          {officer.role}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <div className="font-medium">{officer.open_cases || 0} open</div>
                        <div className="mt-1 text-xs text-muted-foreground">{officer.total_cases || 0} total linked</div>
                      </td>
                      <td className="px-4 py-4 text-muted-foreground">{formatTimestamp(officer.last_login)}</td>
                      <td className="px-4 py-4">
                        <div className="font-medium">{officer.active_sessions}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{officer.login_count || 0} logins total</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="admins">
          <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-border/70 text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">Admin</th>
                    <th className="px-4 py-3 font-semibold">Role</th>
                    <th className="px-4 py-3 font-semibold">Permissions</th>
                    <th className="px-4 py-3 font-semibold">Last login</th>
                    <th className="px-4 py-3 font-semibold">Active sessions</th>
                    <th className="px-4 py-3 font-semibold">Actions (7d)</th>
                  </tr>
                </thead>
                <tbody>
                  {admins.map((admin) => (
                    <tr key={admin.id} className="border-b border-border/50 align-top last:border-b-0">
                      <td className="px-4 py-4">
                        <div className="font-medium">{admin.full_name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{admin.email}</div>
                      </td>
                      <td className="px-4 py-4">
                        <span className="inline-flex rounded-full border border-border/70 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                          {admin.role}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-muted-foreground">
                        {admin.permissions?.length ? admin.permissions.join(', ') : 'No explicit permissions listed'}
                      </td>
                      <td className="px-4 py-4 text-muted-foreground">{formatTimestamp(admin.last_login)}</td>
                      <td className="px-4 py-4 font-medium">{admin.active_sessions}</td>
                      <td className="px-4 py-4 text-muted-foreground">{admin.recent_actions_7d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="sessions">
          <section className="rounded-[1.75rem] border border-border/70 bg-card p-5">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-border/70 text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">Actor</th>
                    <th className="px-4 py-3 font-semibold">Type</th>
                    <th className="px-4 py-3 font-semibold">Started</th>
                    <th className="px-4 py-3 font-semibold">Age</th>
                    <th className="px-4 py-3 font-semibold">Network</th>
                    <th className="px-4 py-3 font-semibold">User agent</th>
                    <th className="px-4 py-3 font-semibold text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {allSessions.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8">
                        <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-5 text-center text-sm text-muted-foreground">
                          No sessions matched the current view.
                        </div>
                      </td>
                    </tr>
                  ) : (
                    allSessions.map((session) => (
                      <tr key={`${session.session_type}-${session.id}`} className="border-b border-border/50 align-top last:border-b-0">
                        <td className="px-4 py-4">
                          <div className="font-medium">{session.actor_name}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{session.actor_email}</div>
                          <div className="mt-2 text-xs text-muted-foreground">
                            {session.actor_badge || session.actor_role}
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <span className="inline-flex rounded-full border border-border/70 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                            {session.session_type}
                          </span>
                        </td>
                        <td className="px-4 py-4 text-muted-foreground">{formatTimestamp(session.started_at)}</td>
                        <td className="px-4 py-4">
                          <div className="font-medium">{formatSessionAge(session.session_age_seconds)}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {session.ended_at ? `Ended ${formatTimestamp(session.ended_at)}` : 'Currently active'}
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="font-medium">{session.ip_address || 'No IP address'}</div>
                          <div className="mt-1 text-xs text-muted-foreground break-all">{session.id}</div>
                        </td>
                        <td className="px-4 py-4 text-muted-foreground">
                          <div className="max-w-xs truncate" title={session.user_agent || 'No user agent recorded'}>
                            {session.user_agent || 'No user agent recorded'}
                          </div>
                        </td>
                        <td className="px-4 py-4 text-right">
                          <div className="flex flex-col items-end gap-2">
                            <Link
                              to={`/admin/activity?sessionId=${encodeURIComponent(session.id)}`}
                              className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
                            >
                              Open activity
                            </Link>
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              disabled={Boolean(session.ended_at)}
                              onClick={() => setTargetSession(session)}
                            >
                              <LogOut className="h-3.5 w-3.5" />
                              Force Logout
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>
      </Tabs>

      <Dialog open={Boolean(targetSession)} onOpenChange={(open: boolean) => !open && setTargetSession(null)}>
        <DialogContent className="max-w-lg rounded-[1.75rem]">
          {targetSession ? (
            <>
              <DialogHeader>
                <DialogTitle>Force logout this session?</DialogTitle>
                <DialogDescription>
                  This will end the selected {targetSession.session_type} session and revoke related refresh tokens so the user must sign in again.
                </DialogDescription>
              </DialogHeader>

              <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-4 text-sm">
                <div className="flex items-start gap-3">
                  {targetSession.session_type === 'admin' ? (
                    <ShieldCheck className="mt-0.5 h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Users className="mt-0.5 h-4 w-4 text-muted-foreground" />
                  )}
                  <div>
                    <div className="font-medium">{targetSession.actor_name}</div>
                    <div className="mt-1 text-muted-foreground">{targetSession.actor_email}</div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Started {formatTimestamp(targetSession.started_at)} • {targetSession.ip_address || 'No IP'}
                    </div>
                    <div className="mt-3">
                      <Link
                        to={`/admin/activity?sessionId=${encodeURIComponent(targetSession.id)}`}
                        className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
                      >
                        Open this session in activity feed
                      </Link>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="force-logout-reason" className="text-sm font-medium text-muted-foreground">
                  Reason for force logout
                </label>
                <Textarea
                  id="force-logout-reason"
                  value={forceLogoutReason}
                  onChange={(event) => setForceLogoutReason(event.target.value)}
                  rows={3}
                  placeholder="Capture why this session is being ended."
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setTargetSession(null)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={forceLogoutMutation.isPending || !forceLogoutReason.trim()}
                  onClick={() => targetSession && forceLogoutMutation.mutate(targetSession)}
                >
                  {forceLogoutMutation.isPending ? 'Ending session…' : 'Confirm Force Logout'}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <AdminRecentAuthDialog
        open={recentAuthOpen}
        onOpenChange={setRecentAuthOpen}
        title="Recent auth required to force logout"
        description="Force logout is a privileged admin write action. Refresh your admin authentication and the session termination will retry automatically."
        onSuccess={async () => {
          setRecentAuthOpen(false)
          if (targetSession) {
            await forceLogoutMutation.mutateAsync(targetSession)
          }
        }}
      />
    </div>
  )
}
