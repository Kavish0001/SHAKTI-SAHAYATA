import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { adminAuthAPI } from '../lib/api'
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
import { Input } from '@/components/ui/input'

interface AdminRecentAuthDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  description?: string
  onSuccess?: () => void | Promise<void>
}

export default function AdminRecentAuthDialog({
  open,
  onOpenChange,
  title = 'Refresh recent admin authentication',
  description = 'Enter your password and, if required for your role, the current authenticator code.',
  onSuccess,
}: AdminRecentAuthDialogProps) {
  const admin = useAdminAuthStore((state) => state.admin)
  const setAuth = useAdminAuthStore((state) => state.setAuth)
  const currentSession = useAdminAuthStore((state) => state.session)

  const [password, setPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) {
      setPassword('')
      setTotpCode('')
      setSubmitting(false)
      setError('')
    }
  }, [open])

  const handleSubmit = async () => {
    if (!admin) return

    setSubmitting(true)
    setError('')

    try {
      const response = await adminAuthAPI.reauthenticate(password, totpCode.trim() || undefined)
      setAuth(response.accessToken, admin, response.session ?? currentSession)
      toast.success('Recent admin authentication refreshed.')
      onOpenChange(false)
      await onSuccess?.()
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : 'Failed to refresh recent admin authentication.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-[1.75rem]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {error ? <div className="text-sm text-red-600 dark:text-red-300">{error}</div> : null}

          <div className="space-y-2">
            <label htmlFor="reauth-password" className="text-sm font-medium text-muted-foreground">
              Password
            </label>
            <Input
              id="reauth-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your admin password"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="reauth-totp" className="text-sm font-medium text-muted-foreground">
              TOTP Code
            </label>
            <Input
              id="reauth-totp"
              inputMode="numeric"
              pattern="[0-9]*"
              value={totpCode}
              onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6-digit authenticator code"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={submitting || !password.trim()} onClick={() => void handleSubmit()}>
            {submitting ? 'Verifying…' : 'Refresh Authentication'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
