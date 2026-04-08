import { create } from 'zustand'
import type { AdminAuthStatus, AdminIdentity, AdminSessionInfo } from '../types'
import { adminAuthAPI } from '../lib/api'
import {
  ApiError,
} from '../../lib/apiClient'
import {
  clearAdminAccessToken,
  registerAdminAuthFailureHandler,
  setAdminAccessToken,
} from '../lib/adminApiClient'

interface AdminAuthState {
  token: string | null
  admin: AdminIdentity | null
  session: AdminSessionInfo | null
  authStatus: AdminAuthStatus
  setAuth: (token: string, admin: AdminIdentity, session?: AdminSessionInfo | null) => void
  clearAuth: () => void
  bootstrapAuth: () => Promise<void>
  logout: () => Promise<void>
}

export const useAdminAuthStore = create<AdminAuthState>((set, get) => ({
  token: null,
  admin: null,
  session: null,
  authStatus: 'unknown',

  setAuth: (token, admin, session = null) => {
    setAdminAccessToken(token)
    set({ token, admin, session, authStatus: 'authenticated' })
  },

  clearAuth: () => {
    clearAdminAccessToken()
    set({ token: null, admin: null, session: null, authStatus: 'unauthenticated' })
  },

  bootstrapAuth: async () => {
    try {
      const data = await adminAuthAPI.bootstrap()
      if (!data?.authenticated || !data.accessToken || !data.admin) {
        get().clearAuth()
        return
      }

      get().setAuth(data.accessToken, data.admin, data.session ?? null)
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        return
      }
      get().clearAuth()
    }
  },

  logout: async () => {
    try {
      await adminAuthAPI.logout()
    } catch {
      // Ignore logout API failures and clear local state anyway.
    } finally {
      get().clearAuth()
    }
  },
}))

registerAdminAuthFailureHandler(() => {
  useAdminAuthStore.getState().clearAuth()
})
