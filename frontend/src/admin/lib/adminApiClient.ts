import { resolveBackendBaseUrl, ApiError } from '../../lib/apiClient'

let inMemoryAdminAccessToken: string | null = null
let adminAuthFailureHandler: (() => void) | null = null
let refreshPromise: Promise<boolean> | null = null

const redirectToAdminLogin = () => {
  if (typeof window === 'undefined') return
  if (window.location.pathname !== '/admin/login') {
    window.location.href = '/admin/login'
  }
}

export const setAdminAccessToken = (token: string | null) => {
  inMemoryAdminAccessToken = token
}

export const getAdminAccessToken = () => inMemoryAdminAccessToken

export const clearAdminAccessToken = () => {
  inMemoryAdminAccessToken = null
}

export const registerAdminAuthFailureHandler = (handler: (() => void) | null) => {
  adminAuthFailureHandler = handler
}

const resolveAdminApiBaseUrl = () => `${resolveBackendBaseUrl()}/api/admin`

type RequestOptions = {
  method?: string
  body?: BodyInit | Record<string, unknown> | null
  headers?: Record<string, string>
  auth?: boolean
  redirectOn401?: boolean
  retryOn401?: boolean
}

const parseResponsePayload = async <T>(response: Response): Promise<T> => {
  const raw = await response.text()
  if (!raw) return null as T

  try {
    return JSON.parse(raw) as T
  } catch {
    return ({ error: raw } as unknown) as T
  }
}

const buildApiError = (
  response: Response,
  data?: { error?: string; code?: string }
) => {
  const retryAfterHeader = response.headers.get('retry-after')
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) || null : null

  return new ApiError(
    data?.error || `Request failed with status ${response.status}`,
    response.status,
    data?.code,
    retryAfter
  )
}

class AdminApiClient {
  private isAuthRecoveryEndpoint(endpoint: string) {
    return endpoint.startsWith('/auth/refresh') || endpoint.startsWith('/auth/bootstrap')
  }

  async refreshAccessToken(redirectOn401 = true): Promise<boolean> {
    if (refreshPromise) return refreshPromise

    refreshPromise = (async () => {
      try {
        const response = await fetch(`${resolveAdminApiBaseUrl()}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        })
        const data = await parseResponsePayload<{ accessToken?: string; error?: string }>(response)

        if (response.status === 429) {
          throw buildApiError(response, data)
        }

        if (!response.ok || !data?.accessToken) {
          clearAdminAccessToken()
          adminAuthFailureHandler?.()
          if (redirectOn401) redirectToAdminLogin()
          return false
        }

        setAdminAccessToken(data.accessToken)
        return true
      } catch (error) {
        if (error instanceof ApiError && error.status === 429) throw error
        clearAdminAccessToken()
        adminAuthFailureHandler?.()
        if (redirectOn401) redirectToAdminLogin()
        return false
      } finally {
        refreshPromise = null
      }
    })()

    return refreshPromise
  }

  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const {
      method = 'GET',
      body = null,
      headers = {},
      auth = true,
      redirectOn401 = true,
      retryOn401 = true,
    } = options

    const token = auth ? getAdminAccessToken() : null
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData

    const requestHeaders: Record<string, string> = {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    }

    if (!isFormData) {
      requestHeaders['Content-Type'] = requestHeaders['Content-Type'] || 'application/json'
    }

    const requestInit: RequestInit = {
      method,
      headers: requestHeaders,
      credentials: 'include',
    }

    if (body !== null && body !== undefined) {
      requestInit.body = isFormData || typeof body === 'string'
        ? (body as BodyInit)
        : JSON.stringify(body)
    }

    const response = await fetch(`${resolveAdminApiBaseUrl()}${endpoint}`, requestInit)

    if (response.status === 401 && auth && retryOn401 && !this.isAuthRecoveryEndpoint(endpoint)) {
      const refreshed = await this.refreshAccessToken(redirectOn401)
      if (refreshed) {
        return this.request<T>(endpoint, { ...options, retryOn401: false })
      }
      throw new ApiError('Admin session expired. Please sign in again.', 401)
    }

    const data = await parseResponsePayload<T & { error?: string }>(response)
    if (!response.ok) {
      if (response.status === 401 && redirectOn401) {
        clearAdminAccessToken()
        adminAuthFailureHandler?.()
        redirectToAdminLogin()
      }
      throw buildApiError(response, data)
    }

    return data
  }
}

export const adminApiClient = new AdminApiClient()
