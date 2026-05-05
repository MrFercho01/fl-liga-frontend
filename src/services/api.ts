import type { League } from '../types/league.ts'
import type { LiveMatch, LiveSettings, LiveStaffRole, LiveTimerAction } from '../types/live.ts'
import type {
  AuditLogEntry,
  AuthUser,
  ClientAccessTokenSummary,
  ClientAccessValidation,
  CreateLeaguePayload,
  FixtureScheduleEntry,
  FixtureResponse,
  LoginPayload,
  PlayedMatchRecord,
  RegisteredTeam,
  RoundAwardsEntry,
  RoundAwardsRankingEntry,
  UserWithLeagues,
} from '../types/admin.ts'

interface ApiOk<T> {
  ok: true
  data: T
}

interface ApiError {
  ok: false
  message: string
  code?: string
}

type ApiResponse<T> = ApiOk<T> | ApiError

const runtimeApiBaseUrl = (() => {
  if (typeof window === 'undefined') return 'http://localhost:4000'
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  return `${protocol}//${window.location.hostname}:4000`
})()

export const apiBaseUrl = (import.meta.env.VITE_API_URL as string | undefined)?.trim() || runtimeApiBaseUrl

let authToken = localStorage.getItem('@fl_liga_auth_token') ?? ''
let _sessionExpiredCallback: (() => void) | null = null

const SESSION_EXPIRED_CODES = new Set(['SESSION_EXPIRED', 'INACTIVE', 'NO_AUTH', 'NO_USER'])

const buildHeaders = (headers?: HeadersInit): HeadersInit => {
  const base: Record<string, string> = {}
  if (authToken) {
    base.Authorization = `Bearer ${authToken}`
  }

  if (!headers) return base
  return {
    ...base,
    ...(headers as Record<string, string>),
  }
}

const apiFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const response = await fetch(url, {
    ...init,
    headers: buildHeaders(init?.headers),
  })

  if (response.status === 401 && authToken && _sessionExpiredCallback) {
    _sessionExpiredCallback()
  }

  return response
}

const buildValidationErrorMessage = (payload: {
  message?: string
  errors?: {
    fieldErrors?: Record<string, string[] | undefined>
  }
}) => {
  const fieldErrors = payload.errors?.fieldErrors
  if (!fieldErrors) return payload.message ?? 'Payload inválido'

  const firstInvalidField = Object.entries(fieldErrors).find(([, messages]) => Array.isArray(messages) && messages.length > 0)
  if (!firstInvalidField) return payload.message ?? 'Payload inválido'

  const [field, messages] = firstInvalidField
  const reason = messages?.[0] ?? 'valor inválido'
  return `Campo inválido: ${field} (${reason})`
}

export const apiService = {
  setAuthToken(token: string) {
    authToken = token
    if (token) {
      localStorage.setItem('@fl_liga_auth_token', token)
    } else {
      localStorage.removeItem('@fl_liga_auth_token')
    }
  },

  getAuthToken() {
    return authToken
  },

  onSessionExpired(callback: () => void) {
    _sessionExpiredCallback = callback
  },

  async login(payload: LoginPayload): Promise<ApiResponse<{ token: string; user: AuthUser }>> {
    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string; code?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo iniciar sesión', ...(errorPayload.code ? { code: errorPayload.code } : {}) }
      }

      const responsePayload = (await response.json()) as { data: { token: string; user: AuthUser } }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async validateClientAccessToken(accessToken: string): Promise<ApiResponse<ClientAccessValidation>> {
    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/client-token/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken }),
      })

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'Token inválido o vencido' }
      }

      const payload = (await response.json()) as { data: ClientAccessValidation }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async registerClientWithToken(payload: {
    accessToken: string
    fullName: string
    organizationName: string
    email: string
    password: string
  }): Promise<ApiResponse<{ token: string; user: AuthUser }>> {
    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/client/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo registrar cliente' }
      }

      const responsePayload = (await response.json()) as { data: { token: string; user: AuthUser } }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async resetClientPasswordWithToken(payload: {
    accessToken: string
    email: string
    password: string
    currentPassword?: string
  }): Promise<ApiResponse<{ ok: boolean }>> {
    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/client/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo restablecer contraseña' }
      }

      const responsePayload = (await response.json()) as { data: { ok: boolean } }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getMe(): Promise<ApiResponse<AuthUser>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/auth/me`)
      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'Sesión inválida' }
      }

      const payload = (await response.json()) as { data: AuthUser }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async logout(): Promise<ApiResponse<{ ok: boolean }>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/auth/logout`, {
        method: 'POST',
      })

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo cerrar sesión' }
      }

      return { ok: true, data: { ok: true } }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getAdminUsers(): Promise<ApiResponse<UserWithLeagues[]>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/users`)
      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo cargar usuarios' }
      }

      const payload = (await response.json()) as { data: UserWithLeagues[] }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async createClientAdminUser(payload: {
    name: string
    organizationName: string
    email: string
    password?: string
  }): Promise<ApiResponse<AuthUser>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/client-users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo crear cliente admin' }
      }

      const payloadResponse = (await response.json()) as { data: AuthUser }
      return { ok: true, data: payloadResponse.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async updateClientAdminUser(
    userId: string,
    payload: {
      name?: string
      organizationName?: string
      email?: string
      active?: boolean
    },
  ): Promise<ApiResponse<{ id: string; name: string; organizationName?: string; email: string; role: 'client_admin'; active: boolean }>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/client-users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo actualizar cliente admin' }
      }

      const payloadResponse = (await response.json()) as {
        data: { id: string; name: string; organizationName?: string; email: string; role: 'client_admin'; active: boolean }
      }
      return { ok: true, data: payloadResponse.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async resetClientAdminTemporaryPassword(
    userId: string,
  ): Promise<ApiResponse<{ id: string; name: string; temporaryPassword: string; active: boolean }>> {
    try {
      const response = await apiFetch(
        `${apiBaseUrl}/api/admin/client-users/${encodeURIComponent(userId)}/reset-temporary-password`,
        {
          method: 'POST',
        },
      )

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo regenerar contraseña temporal' }
      }

      const payloadResponse = (await response.json()) as {
        data: { id: string; name: string; temporaryPassword: string; active: boolean }
      }
      return { ok: true, data: payloadResponse.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getClientAccessTokens(): Promise<ApiResponse<ClientAccessTokenSummary[]>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/client-access-tokens`)
      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudieron cargar tokens de cliente' }
      }

      const payload = (await response.json()) as { data: ClientAccessTokenSummary[] }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async createClientAccessToken(
    clientUserId: string,
    expiresAt: string,
  ): Promise<ApiResponse<ClientAccessTokenSummary & { temporaryPassword: string; emailMessageId?: string; emailError?: string }>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/client-access-tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientUserId, expiresAt }),
      })
      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo generar token' }
      }

      const payload = (await response.json()) as {
        data: ClientAccessTokenSummary & { temporaryPassword: string; emailMessageId?: string; emailError?: string }
      }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async renewClientAccessToken(
    tokenId: string,
    expiresAt: string,
  ): Promise<ApiResponse<{ id: string; expiresAt: string; active: boolean }>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/client-access-tokens/${encodeURIComponent(tokenId)}/renew`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresAt }),
      })
      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo renovar token' }
      }

      const payload = (await response.json()) as { data: { id: string; expiresAt: string; active: boolean } }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async revokeClientAccessToken(tokenId: string): Promise<ApiResponse<{ id: string; active: boolean; revokedAt?: string }>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/client-access-tokens/${encodeURIComponent(tokenId)}/revoke`, {
        method: 'PATCH',
      })
      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo caducar token' }
      }

      const payload = (await response.json()) as { data: { id: string; active: boolean; revokedAt?: string } }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getAuditLogs(): Promise<ApiResponse<AuditLogEntry[]>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/audit-logs`)
      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo cargar auditoría' }
      }

      const payload = (await response.json()) as { data: AuditLogEntry[] }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getLeagues(): Promise<ApiResponse<League[]>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/leagues`)
      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudieron cargar las ligas' }
      }

      const payload = (await response.json()) as { data: League[] }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con el backend de FL League' }
    }
  },

  async getPublicClientLeagues(
    clientId: string,
  ): Promise<
    ApiResponse<
      Array<{
        id: string
        name: string
        slug: string
        country: string
        season: number
        slogan?: string
        themeColor?: string
        backgroundImageUrl?: string
        logoUrl?: string
        categories: Array<{ id: string; name: string }>
      }>
    >
  > {
    try {
      const response = await fetch(`${apiBaseUrl}/api/public/client/${encodeURIComponent(clientId)}/leagues`)
      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudieron cargar ligas públicas' }
      }

      const payload = (await response.json()) as {
        data: Array<{
          id: string
          name: string
          slug: string
          country: string
          season: number
          slogan?: string
          themeColor?: string
          backgroundImageUrl?: string
          logoUrl?: string
          categories: Array<{ id: string; name: string }>
        }>
      }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getPublicClientEngagement(
    clientId: string,
  ): Promise<
    ApiResponse<{
      clientId: string
      visits: number
      likes: number
      updatedAt: string
    }>
  > {
    try {
      const response = await fetch(`${apiBaseUrl}/api/public/client/${encodeURIComponent(clientId)}/engagement`)
      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo cargar engagement público' }
      }

      const payload = (await response.json()) as {
        data: {
          clientId: string
          visits: number
          likes: number
          updatedAt: string
        }
      }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async updatePublicClientEngagement(
    clientId: string,
    payload: { action: 'visit' | 'like'; delta?: -1 | 1 },
  ): Promise<
    ApiResponse<{
      clientId: string
      visits: number
      likes: number
      updatedAt: string
    }>
  > {
    try {
      const response = await fetch(`${apiBaseUrl}/api/public/client/${encodeURIComponent(clientId)}/engagement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo actualizar engagement público' }
      }

      const responsePayload = (await response.json()) as {
        data: {
          clientId: string
          visits: number
          likes: number
          updatedAt: string
        }
      }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getPublicMatchEngagement(
    clientId: string,
    leagueId: string,
    categoryId: string,
    matchId: string,
  ): Promise<ApiResponse<{ likes: number; updatedAt: string }>> {
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/public/client/${encodeURIComponent(clientId)}/matches/${encodeURIComponent(matchId)}/engagement?leagueId=${encodeURIComponent(leagueId)}&categoryId=${encodeURIComponent(categoryId)}`,
      )
      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo cargar likes del partido' }
      }

      const payload = (await response.json()) as { data: { likes: number; updatedAt: string } }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async updatePublicMatchEngagement(
    clientId: string,
    matchId: string,
    payload: { leagueId: string; categoryId: string; delta: -1 | 1 },
  ): Promise<ApiResponse<{ likes: number; updatedAt: string }>> {
    try {
      const response = await fetch(`${apiBaseUrl}/api/public/client/${encodeURIComponent(clientId)}/matches/${encodeURIComponent(matchId)}/engagement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo actualizar likes del partido' }
      }

      const responsePayload = (await response.json()) as { data: { likes: number; updatedAt: string } }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getPublicClientLeagueFixture(
    clientId: string,
    leagueId: string,
    categoryId: string,
  ): Promise<
    ApiResponse<{
      league: {
        id: string
        name: string
        country: string
        season: number
        slogan?: string
        themeColor?: string
        backgroundImageUrl?: string
        logoUrl?: string
      }
      category: {
        id: string
        name: string
      }
      teams: Array<{
        id: string
        name: string
        logoUrl?: string
        technicalStaff?: RegisteredTeam['technicalStaff']
        players: RegisteredTeam['players']
      }>
      fixture: FixtureResponse
      schedule: FixtureScheduleEntry[]
      playedMatchIds: string[]
      playedMatches: Array<{
        matchId: string
        round: number
        homeTeamName: string
        awayTeamName: string
        homeGoals: number
        awayGoals: number
        finalMinute: number
        events: Array<{
          clock: string
          type: 'shot' | 'goal' | 'own_goal' | 'penalty_goal' | 'penalty_miss' | 'yellow' | 'red' | 'double_yellow' | 'assist' | 'substitution'
          teamName: string
          playerName: string
          substitutionInPlayerName?: string
        }>
        homeLineup?: {
          starters: string[]
          substitutes: string[]
          formationKey?: string
        }
        awayLineup?: {
          starters: string[]
          substitutes: string[]
          formationKey?: string
        }
        highlightVideos?: Array<{
          id: string
          name: string
          url: string
        }>
        playedAt: string
      }>
      roundAwards: Array<{
        round: number
        roundBestPlayerId?: string
        roundBestPlayerName?: string
        roundBestPlayerTeamId?: string
        roundBestPlayerTeamName?: string
        roundBestPlayerPhotoUrl?: string
        updatedAt: string
      }>
    }>
  > {
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/public/client/${encodeURIComponent(clientId)}/leagues/${encodeURIComponent(leagueId)}/fixture?categoryId=${encodeURIComponent(categoryId)}`,
      )

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo cargar fixture público' }
      }

      const payload = (await response.json()) as {
        data: {
          league: {
            id: string
            name: string
            country: string
            season: number
            slogan?: string
            themeColor?: string
            backgroundImageUrl?: string
            logoUrl?: string
          }
          category: {
            id: string
            name: string
          }
          teams: Array<{
            id: string
            name: string
            logoUrl?: string
            technicalStaff?: RegisteredTeam['technicalStaff']
            players: RegisteredTeam['players']
          }>
          fixture: FixtureResponse
          schedule: FixtureScheduleEntry[]
          playedMatchIds: string[]
          playedMatches: Array<{
            matchId: string
            round: number
            homeTeamName: string
            awayTeamName: string
            homeGoals: number
            awayGoals: number
            finalMinute: number
            events: Array<{
              clock: string
              type: 'shot' | 'goal' | 'own_goal' | 'penalty_goal' | 'penalty_miss' | 'yellow' | 'red' | 'double_yellow' | 'assist' | 'substitution'
              teamName: string
              playerName: string
              substitutionInPlayerName?: string
            }>
            homeLineup?: {
              starters: string[]
              substitutes: string[]
              formationKey?: string
            }
            awayLineup?: {
              starters: string[]
              substitutes: string[]
              formationKey?: string
            }
            highlightVideos?: Array<{
              id: string
              name: string
              url: string
            }>
            playedAt: string
          }>
          roundAwards: Array<{
            round: number
            roundBestPlayerId?: string
            roundBestPlayerName?: string
            roundBestPlayerTeamId?: string
            roundBestPlayerTeamName?: string
            roundBestPlayerPhotoUrl?: string
            updatedAt: string
          }>
        }
      }

      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getLiveMatch(): Promise<ApiResponse<LiveMatch>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/live/match`)
      if (!response.ok) {
        return { ok: false, message: 'No se pudo cargar el partido en vivo' }
      }

      const payload = (await response.json()) as { data: LiveMatch }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con módulo live' }
    }
  },

  async getAllLiveMatches(): Promise<ApiResponse<LiveMatch[]>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/live`)
      if (!response.ok) {
        return { ok: false, message: 'No se pudieron cargar los partidos en vivo' }
      }
      const payload = (await response.json()) as { data: LiveMatch[] }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con módulo live' }
    }
  },

  async setLiveTimer(matchId: string, action: LiveTimerAction): Promise<ApiResponse<LiveMatch>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/live/timer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId, action }),
      })

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo actualizar timer' }
      }

      const payload = (await response.json()) as { data: LiveMatch }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async updateLiveSettings(matchId: string, settings: Partial<LiveSettings>): Promise<ApiResponse<LiveMatch>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/live/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId, ...settings }),
      })

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo actualizar configuración' }
      }

      const payload = (await response.json()) as { data: LiveMatch }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async saveLineup(
    matchId: string,
    teamId: string,
    starters: string[],
    substitutes: string[],
    formationKey?: string,
  ): Promise<ApiResponse<LiveMatch>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/live/lineup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId, teamId, starters, substitutes, ...(formationKey ? { formationKey } : {}) }),
      })

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo guardar alineación' }
      }

      const payload = (await response.json()) as { data: LiveMatch }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async registerLiveEvent(
    matchId: string,
    teamId: string,
    type:
      | 'shot'
      | 'goal'
      | 'own_goal'
      | 'penalty_goal'
      | 'penalty_miss'
      | 'yellow'
      | 'red'
      | 'double_yellow'
      | 'assist'
      | 'substitution'
      | 'staff_yellow'
      | 'staff_red',
    playerId: string | null,
    staffRole?: LiveStaffRole,
    substitutionInPlayerId?: string,
  ): Promise<ApiResponse<LiveMatch>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/live/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchId,
          teamId,
          type,
          playerId,
          ...(staffRole ? { staffRole } : {}),
          ...(substitutionInPlayerId ? { substitutionInPlayerId } : {}),
        }),
      })
      const responsePayload = (await response.json()) as { message?: string; data?: LiveMatch }
      if (!response.ok) {
        return { ok: false, message: responsePayload.message ?? 'No se pudo registrar evento' }
      }

      if (!responsePayload.data) {
        return { ok: false, message: 'Respuesta inválida del servidor' }
      }

      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async deleteLiveEvent(matchId: string, eventId: string): Promise<ApiResponse<LiveMatch>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/live/events/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId, eventId }),
      })

      const payload = (await response.json()) as { message?: string; data?: LiveMatch }
      if (!response.ok) {
        return { ok: false, message: payload.message ?? 'No se pudo eliminar el evento' }
      }

      if (!payload.data) {
        return { ok: false, message: 'Respuesta inválida del servidor' }
      }

      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getLeagueTeams(leagueId: string, categoryId: string): Promise<ApiResponse<RegisteredTeam[]>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/teams?categoryId=${categoryId}`)
      if (!response.ok) {
        const payload = (await response.json()) as { message?: string, code?: string }
        if (payload.code && SESSION_EXPIRED_CODES.has(payload.code)) {
          return { ok: false, message: 'Sesión expirada', code: payload.code }
        }
        return { ok: false, message: payload.message ?? 'No se pudo cargar equipos', code: payload.code }
      }

      const payload = (await response.json()) as { data: RegisteredTeam[] }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async createTeam(leagueId: string, categoryId: string, name: string): Promise<ApiResponse<RegisteredTeam>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, categoryId }),
      })

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo crear equipo' }
      }

      const payload = (await response.json()) as { data: RegisteredTeam }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async addPlayerToTeam(
    teamId: string,
    player: {
      name: string
      nickname: string
      age: number
      number: number
      position: string
      registrationStatus?: 'pending' | 'registered'
      photoUrl?: string
      replacePlayerId?: string
      replacementReason?: 'injury'
    },
  ): Promise<ApiResponse<RegisteredTeam>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/teams/${teamId}/players`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(player),
      })

      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo agregar jugador' }
      }

      const payload = (await response.json()) as { data: RegisteredTeam }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getLeagueFixture(leagueId: string, categoryId: string): Promise<ApiResponse<FixtureResponse>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/fixture?categoryId=${categoryId}`)
      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo generar fixture' }
      }

      const payload = (await response.json()) as { data: FixtureResponse }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async createLeague(payload: CreateLeaguePayload): Promise<ApiResponse<League>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo crear la liga' }
      }

      const responsePayload = (await response.json()) as { data: League }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async deleteLeague(leagueId: string): Promise<ApiResponse<{ ok: boolean }>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo eliminar la liga' }
      }

      return { ok: true, data: { ok: true } }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async updateLeague(
    leagueId: string,
    payload: {
      name?: string
      slug?: string
      country?: string
      season?: number
      slogan?: string
      themeColor?: string
      backgroundImageUrl?: string
      logoUrl?: string
      categories?: CreateLeaguePayload['categories']
    },
  ): Promise<ApiResponse<League>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo actualizar la liga' }
      }

      const responsePayload = (await response.json()) as { data: League }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async updateCategoryRules(
    leagueId: string,
    categoryId: string,
    rules: {
      playersOnField?: number
      maxRegisteredPlayers?: number
      matchMinutes?: number
      breakMinutes?: number
      courtsCount?: number
      allowDraws?: boolean
      pointsWin?: number
      pointsDraw?: number
      pointsLoss?: number
      resolveDrawByPenalties?: boolean
      playoffQualifiedTeams?: number
      playoffHomeAway?: boolean
      finalStageRoundOf16Enabled?: boolean
      finalStageRoundOf8Enabled?: boolean
      finalStageQuarterFinalsEnabled?: boolean
      finalStageSemiFinalsEnabled?: boolean
      finalStageFinalEnabled?: boolean
      finalStageTwoLegged?: boolean
      finalStageRoundOf16TwoLegged?: boolean
      finalStageRoundOf8TwoLegged?: boolean
      finalStageQuarterFinalsTwoLegged?: boolean
      finalStageSemiFinalsTwoLegged?: boolean
      finalStageFinalTwoLegged?: boolean
      doubleRoundRobin?: boolean
      regularSeasonRounds?: number
    },
  ): Promise<ApiResponse<League>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/categories/${categoryId}/rules`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as {
          message?: string
          errors?: {
            fieldErrors?: Record<string, string[] | undefined>
          }
        }
        return {
          ok: false,
          message: buildValidationErrorMessage(errorPayload) ?? 'No se pudo actualizar reglas de competencia',
        }
      }

      const responsePayload = (await response.json()) as { data: League }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async updateTeam(
    teamId: string,
    payload: {
      name?: string
      categoryId?: string
      active?: boolean
      logoUrl?: string
      primaryColor?: string
      secondaryColor?: string
      technicalStaff?: RegisteredTeam['technicalStaff']
    },
  ): Promise<ApiResponse<RegisteredTeam>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/teams/${teamId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo actualizar el equipo' }
      }

      const responsePayload = (await response.json()) as { data: RegisteredTeam }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async deleteTeam(teamId: string): Promise<ApiResponse<{ ok: boolean }>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/teams/${teamId}`, { method: 'DELETE' })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo eliminar el equipo' }
      }

      return { ok: true, data: { ok: true } }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async updatePlayer(
    teamId: string,
    playerId: string,
    payload: {
      name?: string
      nickname?: string
      age?: number
      number?: number
      position?: string
      registrationStatus?: 'pending' | 'registered'
      photoUrl?: string
    },
  ): Promise<ApiResponse<RegisteredTeam>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/teams/${teamId}/players/${playerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo actualizar el jugador' }
      }

      const responsePayload = (await response.json()) as { data: RegisteredTeam }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async deletePlayer(teamId: string, playerId: string): Promise<ApiResponse<RegisteredTeam>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/teams/${teamId}/players/${playerId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo eliminar el jugador' }
      }

      const responsePayload = (await response.json()) as { data: RegisteredTeam }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async createTeamWithLogo(
    leagueId: string,
    categoryId: string,
    name: string,
    logoUrl?: string,
    options?: {
      primaryColor?: string
      secondaryColor?: string
      director?: { name: string; photoUrl?: string }
      assistant?: { name: string; photoUrl?: string }
    },
  ): Promise<ApiResponse<RegisteredTeam>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          categoryId,
          logoUrl,
          primaryColor: options?.primaryColor,
          secondaryColor: options?.secondaryColor,
          technicalStaff: {
            director: options?.director,
            assistant: options?.assistant,
          },
        }),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo crear equipo' }
      }

      const responsePayload = (await response.json()) as { data: RegisteredTeam }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async loadLiveMatch(payload: {
    matchId: string
    leagueId: string
    categoryId: string
    homeTeamId: string
    awayTeamId: string
  }): Promise<ApiResponse<LiveMatch>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/live/load-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo preparar el partido en vivo' }
      }

      const responsePayload = (await response.json()) as { data: LiveMatch }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getFixtureSchedule(
    leagueId: string,
    categoryId: string,
  ): Promise<ApiResponse<FixtureScheduleEntry[]>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/fixture-schedule?categoryId=${categoryId}`)
      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo cargar agenda de fixture' }
      }

      const payload = (await response.json()) as { data: FixtureScheduleEntry[] }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async saveFixtureSchedule(
    leagueId: string,
    matchId: string,
    payload: { categoryId: string; round: number; scheduledAt: string; venue?: string; status?: 'scheduled' | 'postponed' },
  ): Promise<ApiResponse<{ matchId: string; scheduledAt: string; venue?: string; status?: 'scheduled' | 'postponed' }>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/matches/${encodeURIComponent(matchId)}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo guardar fecha del partido' }
      }

      const responsePayload = (await response.json()) as { data: { matchId: string; scheduledAt: string; venue?: string; status?: 'scheduled' | 'postponed' } }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async deleteFixtureSchedule(
    leagueId: string,
    matchId: string,
    categoryId: string,
  ): Promise<ApiResponse<{ deleted: boolean }>> {
    try {
      const response = await apiFetch(
        `${apiBaseUrl}/api/admin/leagues/${leagueId}/matches/${encodeURIComponent(matchId)}/schedule?categoryId=${encodeURIComponent(categoryId)}`,
        {
          method: 'DELETE',
        },
      )

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo eliminar fecha del partido' }
      }

      const responsePayload = (await response.json()) as { data: { deleted: boolean } }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getRoundAwards(
    leagueId: string,
    categoryId: string,
  ): Promise<ApiResponse<RoundAwardsEntry[]>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/round-awards?categoryId=${categoryId}`)
      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo cargar mejores jugadoras por fecha' }
      }

      const payload = (await response.json()) as { data: RoundAwardsEntry[] }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async saveRoundAwards(
    leagueId: string,
    payload: {
      categoryId: string
      round: number
      matchBestPlayers: RoundAwardsEntry['matchBestPlayers']
      roundBestPlayerId?: string
      roundBestPlayerName?: string
      roundBestPlayerTeamId?: string
      roundBestPlayerTeamName?: string
    },
  ): Promise<ApiResponse<RoundAwardsEntry>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/round-awards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo guardar mejores jugadoras de la fecha' }
      }

      const responsePayload = (await response.json()) as { data: RoundAwardsEntry }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getRoundAwardsRanking(
    leagueId: string,
    categoryId: string,
  ): Promise<ApiResponse<RoundAwardsRankingEntry[]>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/round-awards-ranking?categoryId=${categoryId}`)
      if (!response.ok) {
        const payload = (await response.json()) as { message?: string }
        return { ok: false, message: payload.message ?? 'No se pudo cargar ranking de jugadora de la fecha' }
      }

      const payload = (await response.json()) as { data: RoundAwardsRankingEntry[] }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async getPlayedMatches(leagueId: string, categoryId: string): Promise<ApiResponse<PlayedMatchRecord[]>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/played-matches?categoryId=${categoryId}`)
      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo cargar partidos jugados' }
      }

      const payload = (await response.json()) as { data: PlayedMatchRecord[] }
      return { ok: true, data: payload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async savePlayedMatch(leagueId: string, payload: PlayedMatchRecord): Promise<ApiResponse<PlayedMatchRecord>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/played-matches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo guardar partido jugado' }
      }

      const responsePayload = (await response.json()) as { data: PlayedMatchRecord }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async addPlayedMatchVideo(
    leagueId: string,
    matchId: string,
    payload: { categoryId: string; name: string; url: string },
  ): Promise<ApiResponse<PlayedMatchRecord>> {
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/played-matches/${matchId}/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo guardar video del partido' }
      }

      const responsePayload = (await response.json()) as { data: PlayedMatchRecord }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async uploadPlayedMatchVideo(
    leagueId: string,
    matchId: string,
    payload: { categoryId: string; file: File; name?: string },
  ): Promise<ApiResponse<PlayedMatchRecord>> {
    try {
      const formData = new FormData()
      formData.append('categoryId', payload.categoryId)
      if (payload.name?.trim()) {
        formData.append('name', payload.name.trim())
      }
      formData.append('video', payload.file)

      const response = await apiFetch(`${apiBaseUrl}/api/admin/leagues/${leagueId}/played-matches/${matchId}/videos/upload`, {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo subir video del partido' }
      }

      const responsePayload = (await response.json()) as { data: PlayedMatchRecord }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },

  async deletePlayedMatchVideo(
    leagueId: string,
    matchId: string,
    videoId: string,
    categoryId: string,
  ): Promise<ApiResponse<PlayedMatchRecord>> {
    try {
      const response = await apiFetch(
        `${apiBaseUrl}/api/admin/leagues/${leagueId}/played-matches/${matchId}/videos/${videoId}?categoryId=${encodeURIComponent(categoryId)}`,
        { method: 'DELETE' },
      )

      if (!response.ok) {
        const errorPayload = (await response.json()) as { message?: string }
        return { ok: false, message: errorPayload.message ?? 'No se pudo eliminar el video' }
      }

      const responsePayload = (await response.json()) as { data: PlayedMatchRecord }
      return { ok: true, data: responsePayload.data }
    } catch {
      return { ok: false, message: 'Sin conexión con backend' }
    }
  },
}
