import { adminApiClient } from './adminApiClient'
import type { AdminIdentity, AdminSessionInfo } from '../types'

export const adminAuthAPI = {
  async login(email: string, password: string) {
    return adminApiClient.request<{
      accessToken: string
      expiresAt: string | null
      session: AdminSessionInfo | null
      admin: AdminIdentity
    }>('/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
      redirectOn401: false,
    })
  },

  async logout() {
    return adminApiClient.request('/auth/logout', { method: 'POST' })
  },

  async bootstrap() {
    return adminApiClient.request<{
      authenticated: boolean
      accessToken?: string
      expiresAt?: string | null
      session?: AdminSessionInfo | null
      admin?: AdminIdentity
    }>('/auth/bootstrap', {
      auth: false,
      redirectOn401: false,
      retryOn401: false,
    })
  },

  async getMe() {
    return adminApiClient.request<AdminIdentity>('/auth/me')
  },
}
