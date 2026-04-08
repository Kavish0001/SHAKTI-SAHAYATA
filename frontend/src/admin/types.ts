export interface AdminIdentity {
  id: number
  email: string
  fullName: string
  role: string
  permissions: string[]
  isActive?: boolean
  lastLogin?: string | null
  createdAt?: string | null
}

export interface AdminSessionInfo {
  id: string | null
  startedAt: string | null
}

export type AdminAuthStatus = 'unknown' | 'authenticated' | 'unauthenticated'
