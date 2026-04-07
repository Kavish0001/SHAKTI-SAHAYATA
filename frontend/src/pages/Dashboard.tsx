import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, BriefcaseBusiness, FolderPlus, RadioTower } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '../stores/authStore'
import SessionClock from '../components/dashboard/SessionClock'
import StatCards from '../components/dashboard/StatCards'
import EmptyState from '../components/dashboard/EmptyState'
import { caseAPI, dashboardAPI } from '../components/lib/apis'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Reveal } from '@/components/shared/Reveal'
import { SparklesCore } from '@/components/ui/aceternity/sparkles'
import { CardContainer, CardBody, CardItem } from '@/components/ui/aceternity/3d-card'

interface DashboardStats {
  totalCases: number
  activeCases: number
  totalFiles: number
  recentCases: CaseSummary[]
}

interface CaseSummary {
  id: number
  case_name: string
  case_number: string
  operator?: string | null
  status: string
  priority?: string | null
  file_count?: number | null
  updated_at?: string | null
  is_evidence_locked?: boolean | null
  canArchive?: boolean
  canDelete?: boolean
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [stats, setStats] = useState<DashboardStats>({ totalCases: 0, activeCases: 0, totalFiles: 0, recentCases: [] })
  const [cases, setCases] = useState<CaseSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState<{ caseId: number | null; action: 'archive' | 'delete' | null }>({
    caseId: null,
    action: null,
  })

  useEffect(() => {
    void loadDashboard()
  }, [])

  const loadDashboard = async () => {
    try {
      const [nextStats, caseList] = await Promise.all([
        dashboardAPI.getStats(),
        caseAPI.list({ limit: 50 }),
      ])
      setStats(nextStats)
      setCases(caseList.items || [])
    } catch (err) {
      console.error('Dashboard load error:', err)
    } finally {
      setLoading(false)
    }
  }

  const getPriorityClass = (priority?: string) => {
    if (!priority) return 'bg-slate-500/10 text-slate-500 dark:text-slate-300'

    const map: Record<string, string> = {
      critical: 'bg-red-500/10 text-red-600 dark:text-red-300',
      high: 'bg-orange-500/10 text-orange-600 dark:text-orange-300',
      medium: 'bg-blue-500/10 text-blue-600 dark:text-blue-300',
      low: 'bg-slate-500/10 text-slate-500 dark:text-slate-300',
    }

    return map[priority] || map.low
  }

  const getStatusClass = (status?: string) => {
    const map: Record<string, string> = {
      open: 'status-open',
      active: 'status-open',
      archived: 'status-archived',
      closed: 'status-closed',
    }

    return map[status || ''] || 'status-closed'
  }

  const handleArchiveCase = async (caseItem: CaseSummary, event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()

    if (caseItem.is_evidence_locked) return

    const confirmed = window.confirm(`Archive ${caseItem.case_name} and move it out of the active investigation workspace?`)
    if (!confirmed) return

    setPendingAction({ caseId: caseItem.id, action: 'archive' })

    try {
      await caseAPI.archive(String(caseItem.id))
      toast.success(`${caseItem.case_name} was moved to archive.`)
      await loadDashboard()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to archive case'
      toast.error(message)
    } finally {
      setPendingAction({ caseId: null, action: null })
    }
  }

  const handleDeleteCase = async (caseItem: CaseSummary, event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()

    if (caseItem.is_evidence_locked) return

    const confirmed = window.confirm(`Delete ${caseItem.case_name} permanently? This will remove the case and its linked workspace data.`)
    if (!confirmed) return

    setPendingAction({ caseId: caseItem.id, action: 'delete' })

    try {
      await caseAPI.remove(String(caseItem.id))
      toast.success(`${caseItem.case_name} was deleted.`)
      await loadDashboard()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete case'
      toast.error(message)
    } finally {
      setPendingAction({ caseId: null, action: null })
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Card className="dashboard-hero rounded-[2rem]">
          <CardContent className="grid gap-6 p-6 sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="space-y-4">
              <Skeleton className="h-6 w-32 rounded-full" />
              <Skeleton className="h-12 w-full max-w-lg rounded-2xl" />
              <Skeleton className="h-5 w-64 rounded-xl" />
              <div className="flex gap-3">
                <Skeleton className="h-11 w-40 rounded-2xl" />
                <Skeleton className="h-11 w-40 rounded-2xl" />
              </div>
            </div>
            <Skeleton className="h-36 w-full rounded-[1.75rem] sm:w-[250px]" />
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-32 rounded-[1.5rem]" />
          ))}
        </div>

        <Card className="rounded-[2rem]">
          <CardContent className="space-y-4 p-6">
            <Skeleton className="h-6 w-48 rounded-xl" />
            <div className="grid gap-4 xl:grid-cols-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-56 rounded-[1.75rem]" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="dashboard">
      <Reveal>
        <Card className="dashboard-hero rounded-[2rem]">
          <CardContent className="grid gap-6 p-0 sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="space-y-4">
              <Badge className="w-fit rounded-full border border-shakti-300/25 bg-shakti-50 text-shakti-700 dark:border-shakti-400/20 dark:bg-shakti-500/10 dark:text-shakti-200">
                Mission Control
              </Badge>
              <div className="relative">
                <div className="absolute inset-x-0 top-0 h-40 w-full overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,white,transparent)] pointer-events-none">
                  <SparklesCore
                    background="transparent"
                    minSize={0.4}
                    maxSize={1}
                    particleDensity={50}
                    className="w-full h-full"
                    particleColor="#3f67f2"
                  />
                </div>
                <h1 className="relative z-10 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
                  Welcome back, <span className="hero-name">{user?.fullName || 'Officer'}</span>
                </h1>
                <p className="hero-subtitle text-base leading-8">
                  {(user?.role === 'super_admin'
                    ? 'Super Administrator'
                    : user?.role === 'station_admin'
                      ? 'Station Administrator'
                      : 'Investigation Officer')}
                  {' • '}
                  {user?.buckleId}
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => navigate('/create-case')} className="h-11 rounded-2xl px-5">
                  <FolderPlus className="h-4 w-4" />
                  New Case
                </Button>
                <Button variant="outline" onClick={() => navigate('/osint')} className="h-11 rounded-2xl border-shakti-300/35 bg-white dark:bg-white/5">
                  <RadioTower className="h-4 w-4" />
                  Open OSINT Tools
                </Button>
              </div>
            </div>
            <SessionClock />
          </CardContent>
        </Card>
      </Reveal>

      <Reveal delayMs={70}>
        <StatCards totalCases={stats.totalCases} activeCases={stats.activeCases} totalFiles={stats.totalFiles} />
      </Reveal>

      {cases.length === 0 ? (
        <Reveal delayMs={120}>
          <EmptyState onCreateCase={() => navigate('/create-case')} />
        </Reveal>
      ) : (
        <div className="space-y-5">
          <Reveal delayMs={120}>
            <div className="section-header flex items-end justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">Case Overview</div>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Your investigations</h2>
              </div>
              <Button onClick={() => navigate('/create-case')} className="rounded-2xl">
                <FolderPlus className="h-4 w-4" />
                New Case
              </Button>
            </div>
          </Reveal>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {cases.map((c, index) => (
              <Reveal key={c.id} delayMs={Math.min(index * 60, 240)}>
               <CardContainer containerClassName="py-0" className="w-full">
                <CardBody className="h-auto w-full">
                <CardItem as={Card} translateZ={20} className="glass-card-hover h-full w-full cursor-pointer rounded-[1.75rem]" onClick={() => navigate(`/case/${c.id}`)}>
                  <CardHeader className="space-y-4 pb-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 gap-3">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-100 to-shakti-100 text-shakti-700 dark:from-blue-500/10 dark:to-shakti-500/10 dark:text-shakti-200">
                          <BriefcaseBusiness className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                          <CardTitle className="truncate text-xl">{c.case_name}</CardTitle>
                          <CardDescription className="mt-1 text-sm">
                            {c.case_number}
                            {c.operator ? ` • ${c.operator}` : ''}
                          </CardDescription>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <Badge className={`${getStatusClass(c.status)} rounded-full`}>
                          {c.status}
                        </Badge>
                        <Badge className={`${getPriorityClass(c.priority ?? undefined)} rounded-full`}>
                          {c.priority || 'normal'}
                        </Badge>
                        {(c.canArchive || c.canDelete) ? (
                          <div className="mt-1 flex flex-col items-end gap-2">
                            {c.canArchive && c.status !== 'archived' ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={(event) => void handleArchiveCase(c, event)}
                                disabled={(pendingAction.caseId === c.id && pendingAction.action === 'archive') || Boolean(c.is_evidence_locked)}
                                title={c.is_evidence_locked ? 'Evidence lock prevents case archival.' : 'Move this case to archive'}
                                className="h-8 rounded-full border-amber-300/60 bg-amber-50/80 px-3 text-xs font-semibold text-amber-700 hover:bg-amber-100/80 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/20"
                              >
                                {pendingAction.caseId === c.id && pendingAction.action === 'archive' ? 'Closing...' : 'Close Case'}
                              </Button>
                            ) : null}
                            {c.canDelete ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={(event) => void handleDeleteCase(c, event)}
                                disabled={(pendingAction.caseId === c.id && pendingAction.action === 'delete') || Boolean(c.is_evidence_locked)}
                                title={c.is_evidence_locked ? 'Evidence lock prevents case deletion.' : 'Delete this case permanently'}
                                className="h-8 rounded-full border-red-300/60 bg-red-50/80 px-3 text-xs font-semibold text-red-700 hover:bg-red-100/80 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200 dark:hover:bg-red-500/20"
                              >
                                {pendingAction.caseId === c.id && pendingAction.action === 'delete' ? 'Deleting...' : 'Delete Case'}
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-2xl bg-muted/60 p-4">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Files</div>
                        <div className="mt-2 text-2xl font-semibold">{c.file_count || 0}</div>
                      </div>
                      <div className="rounded-2xl bg-muted/60 p-4">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Updated</div>
                        <div className="mt-2 text-sm font-medium">
                          {c.updated_at ? new Date(c.updated_at).toLocaleDateString() : 'N/A'}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between border-t border-border/70 pt-4 text-sm text-slate-500 dark:text-slate-400">
                      <span>Open case workspace</span>
                      <ArrowRight className="h-4 w-4" />
                    </div>
                  </CardContent>
                </CardItem>
                </CardBody>
               </CardContainer>
              </Reveal>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
