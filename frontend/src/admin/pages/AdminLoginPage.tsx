import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertCircle, ArrowLeft, Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { adminAuthAPI } from '../lib/api'
import { useAdminAuthStore } from '../store/adminAuthStore'

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Admin login failed. Please try again.'
}

export default function AdminLoginPage() {
  const navigate = useNavigate()
  const { admin, authStatus, setAuth } = useAdminAuthStore()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    if (authStatus === 'authenticated' && admin) {
      navigate('/admin', { replace: true })
    }
  }, [admin, authStatus, navigate])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setLoading(true)

    try {
      const data = await adminAuthAPI.loginWithTotp(email.trim().toLowerCase(), password, totpCode.trim())
      setAuth(data.accessToken, data.admin, data.session)
      navigate('/admin', { replace: true })
    } catch (error: unknown) {
      setError(getErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-background px-4 py-8 sm:px-6 lg:px-8">
      <div className="relative mx-auto flex min-h-[calc(100vh-4rem)] max-w-7xl items-center justify-center">
        <Card className="glass-card mx-auto w-full max-w-lg rounded-[2rem] border-white/60 bg-white/80 p-0 shadow-[0_28px_80px_rgba(10,19,51,0.18)] dark:border-white/10 dark:bg-surface-900/82">
          <CardHeader className="space-y-5 border-b border-border/70 pb-6 px-6 sm:px-8 pt-6">
            <div className="flex items-center justify-between">
              <Button asChild variant="ghost" size="sm" className="rounded-xl px-3">
                <Link to="/login">
                  <ArrowLeft className="h-4 w-4" />
                  Officer Login
                </Link>
              </Button>
              <Badge className="rounded-full border border-slate-300/40 bg-slate-100/90 text-slate-700 dark:border-slate-400/20 dark:bg-slate-500/10 dark:text-slate-200">
                IT Access Only
              </Badge>
            </div>

            <div className="space-y-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-[1.35rem] bg-slate-900 text-white dark:bg-white dark:text-slate-900">
                <ShieldCheck className="h-7 w-7" />
              </div>
              <div>
                <CardTitle className="text-3xl">Admin console sign-in</CardTitle>
                <CardDescription className="mt-2 text-base leading-7">
                  Use your internal IT admin account to enter the isolated SHAKTI backend console.
                </CardDescription>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-6 p-6 sm:p-8">
            {error ? (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-700 dark:text-red-300">
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              </div>
            ) : null}

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <label htmlFor="admin-email" className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Email Address
                </label>
                <Input
                  id="admin-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="it.admin@police.gov.in"
                  className="h-12 rounded-xl border-slate-200 bg-white/80 dark:border-white/10 dark:bg-surface-900/90"
                  required
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="admin-password" className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Password
                </label>
                <div className="relative">
                  <Input
                    id="admin-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Enter your secure password"
                    className="h-12 rounded-xl border-slate-200 bg-white/80 pr-12 dark:border-white/10 dark:bg-surface-900/90"
                    required
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-xl"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="admin-totp" className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  TOTP Code
                </label>
                <Input
                  id="admin-totp"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="6-digit authenticator code"
                  className="h-12 rounded-xl border-slate-200 bg-white/80 dark:border-white/10 dark:bg-surface-900/90"
                />
                <p className="text-xs text-muted-foreground">
                  Required when TOTP enforcement is enabled for your admin role.
                </p>
              </div>

              <Button type="submit" disabled={loading} className="h-12 w-full rounded-2xl text-base bg-slate-900 hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">
                {loading ? 'Signing in...' : 'Enter Admin Console'}
              </Button>
            </form>

            <div className="rounded-2xl border border-slate-300/25 bg-slate-100 px-4 py-3 text-sm text-slate-700 dark:border-slate-400/20 dark:bg-slate-500/10 dark:text-slate-200">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <span>This login is isolated from officer sessions and uses separate admin tokens, cookies, and permissions.</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
