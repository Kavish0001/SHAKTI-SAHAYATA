import { Database, FileSpreadsheet, FileStack, Gauge, LayoutDashboard, LogOut, MonitorCog, ShieldAlert, ShieldCheck, Users } from 'lucide-react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAdminAuthStore } from '../store/adminAuthStore'
import { Button } from '@/components/ui/button'

const navigation = [
  { to: '/admin', label: 'Overview', icon: LayoutDashboard },
  { to: '/admin/activity', label: 'Activity', icon: Gauge },
  { to: '/admin/users', label: 'Users & Sessions', icon: Users },
  { to: '/admin/cases', label: 'Cases', icon: ShieldCheck },
  { to: '/admin/files', label: 'Files', icon: FileStack },
  { to: '/admin/database', label: 'Database', icon: Database },
  { to: '/admin/system', label: 'System', icon: MonitorCog },
  { to: '/admin/alerts', label: 'Alerts', icon: ShieldAlert },
  { to: '/admin/exports', label: 'Exports', icon: FileSpreadsheet },
]

export default function AdminLayout() {
  const navigate = useNavigate()
  const { admin, logout } = useAdminAuthStore()

  const handleLogout = async () => {
    await logout()
    navigate('/admin/login', { replace: true })
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen lg:grid-cols-[280px_1fr]">
        <aside className="border-r border-border/70 bg-slate-950 px-5 py-6 text-white dark:bg-slate-950">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-3 rounded-2xl bg-white/8 px-4 py-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-slate-950">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <div>
                <div className="text-xs uppercase tracking-[0.22em] text-slate-400">SHAKTI</div>
                <div className="text-base font-semibold">Admin Console</div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <div className="text-sm font-semibold">{admin?.fullName || 'Admin'}</div>
              <div className="mt-1 text-xs text-slate-400">{admin?.email}</div>
              <div className="mt-2 inline-flex rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-300">
                {admin?.role || 'it_admin'}
              </div>
            </div>
          </div>

          <nav className="mt-8 space-y-2">
            {navigation.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/admin'}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition ${
                    isActive
                      ? 'bg-white text-slate-950 shadow-sm'
                      : 'text-slate-300 hover:bg-white/8 hover:text-white'
                  }`
                }
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="mt-8 rounded-2xl border border-dashed border-white/15 bg-white/5 p-4 text-sm text-slate-300">
            Phase 5 turns the console into an operational workspace with system health, alerting, audited exports, recent-auth challenges, and production-facing admin guardrails.
          </div>

          <Button
            type="button"
            variant="ghost"
            onClick={() => void handleLogout()}
            className="mt-6 w-full justify-start rounded-2xl border border-white/10 bg-white/5 px-4 py-6 text-slate-200 hover:bg-white/10 hover:text-white"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </aside>

        <main className="min-w-0">
          <header className="border-b border-border/70 bg-background/80 px-6 py-5 backdrop-blur">
            <div className="flex flex-col gap-1">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Internal IT Workspace</div>
              <h1 className="text-2xl font-semibold tracking-tight">Admin Console</h1>
            </div>
          </header>
          <div className="p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
