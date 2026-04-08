import { useEffect } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { Shield } from 'lucide-react'
import { useAdminAuthStore } from '../store/adminAuthStore'

export default function AdminProtectedRoute() {
  const { authStatus, bootstrapAuth } = useAdminAuthStore()

  useEffect(() => {
    if (authStatus === 'unknown') {
      void bootstrapAuth()
    }
  }, [authStatus, bootstrapAuth])

  if (authStatus === 'unknown') {
    return (
      <div className="min-h-screen bg-background px-4 flex items-center justify-center">
        <div className="glass-card w-full max-w-md rounded-[2rem] px-8 py-10 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] bg-slate-900 text-white dark:bg-white dark:text-slate-900">
            <Shield className="h-8 w-8" />
          </div>
          <div className="mx-auto mt-6 h-12 w-12 animate-spin rounded-full border-4 border-slate-300/25 border-t-slate-700 dark:border-slate-600/30 dark:border-t-slate-100" />
          <p className="mt-5 text-sm font-medium text-slate-600 dark:text-slate-300">Restoring admin console session...</p>
        </div>
      </div>
    )
  }

  if (authStatus !== 'authenticated') {
    return <Navigate to="/admin/login" replace />
  }

  return <Outlet />
}
