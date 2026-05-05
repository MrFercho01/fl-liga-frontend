import { toPng } from 'html-to-image'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { AdminTeamsPanel } from './components/AdminTeamsPanel.tsx'
import { ClientPortal } from './components/ClientPortal.tsx'
import { ListSectionControls, PaginationControls } from './components/ListSectionControls'
import { StoreFooter } from './components/StoreFooter'
import { apiBaseUrl, apiService } from './services/api'
import type {
  AuditLogEntry,
  AuthUser,
  ClientAccessTokenSummary,
  ClientAccessValidation,
  FixtureScheduleEntry,
  FixtureResponse,
  PlayedMatchRecord,
  RegisteredTeam,
  RoundAwardsRankingEntry,
  UserWithLeagues,
} from './types/admin.ts'
import type { League } from './types/league'
import type { LiveEvent, LiveMatch, LivePlayer, LiveStaffRole, LiveTeam } from './types/live'

const leagueTitle = 'FL League'
const authUserStorageKey = '@fl_liga_auth_user'
const TOKEN_PAGE_SIZE = 6
const CLIENT_ADMIN_PAGE_SIZE = 8
const PUBLIC_ROWS_PAGE_SIZE = 8

type TokenStatusFilter = 'all' | 'active' | 'expired'
type ClientAdminStatusFilter = 'all' | 'active' | 'inactive'

const toDateTimeLocalValue = (value: string | number | Date) => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''

  const offsetMs = date.getTimezoneOffset() * 60 * 1000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

const isTokenCurrentlyActive = (token: Pick<ClientAccessTokenSummary, 'active' | 'expiresAt'>) => {
  const expiresAtMs = new Date(token.expiresAt).getTime()
  return token.active && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
}

interface ScheduledMatchItem {
  id: string
  round: number
  homeTeamId: string
  awayTeamId: string
  scheduledAt: string
  venue?: string
}

interface CompetitionRulesDraft {
  allowDraws: boolean
  pointsWin: number
  pointsDraw: number
  pointsLoss: number
  courtsCount: number
  maxRegisteredPlayers: number
  resolveDrawByPenalties: boolean
  playoffQualifiedTeams: number
  finalStageRoundOf16Enabled: boolean
  finalStageRoundOf8Enabled: boolean
  finalStageQuarterFinalsEnabled: boolean
  finalStageSemiFinalsEnabled: boolean
  finalStageFinalEnabled: boolean
  finalStageTwoLegged: boolean
  finalStageRoundOf16TwoLegged: boolean
  finalStageRoundOf8TwoLegged: boolean
  finalStageQuarterFinalsTwoLegged: boolean
  finalStageSemiFinalsTwoLegged: boolean
  finalStageFinalTwoLegged: boolean
  doubleRoundRobin: boolean
  regularSeasonRounds: number
}

interface FormationOption {
  key: string
  label: string
  lines: number[]
}

interface SubstitutionTimelineEntry {
  id: string
  clock: string
  minute: number
  outPlayerId: string
  inPlayerId: string
}

type HistoryTabKey = 'standings' | 'scorers' | 'assists' | 'yellows' | 'reds'

const buildFormationOptions = (playersOnField: number): FormationOption[] => {
  if (playersOnField <= 1) {
    return [{ key: '1', label: '1', lines: [1] }]
  }

  const presetByPlayers: Record<number, number[][]> = {
    8: [
      [1, 3, 3, 1],
      [1, 4, 2, 1],
      [1, 2, 3, 2],
      [1, 3, 2, 2],
      [1, 2, 2, 3],
    ],
    9: [
      [1, 3, 3, 2],
      [1, 4, 3, 1],
      [1, 3, 2, 3],
      [1, 2, 3, 3],
      [1, 4, 2, 2],
    ],
    11: [
      [1, 4, 3, 3],
      [1, 3, 5, 2],
      [1, 5, 3, 2],
      [1, 4, 4, 2],
      [1, 3, 4, 3],
      [1, 5, 2, 3],
    ],
  }

  if (playersOnField === 6) {
    return [
      { key: '1-3-1-1', label: '1 - 3 - 1 - 1', lines: [1, 3, 1, 1] },
      { key: '1-2-2-1', label: '1 - 2 - 2 - 1', lines: [1, 2, 2, 1] },
      { key: '1-3-2', label: '1 - 3 - 2', lines: [1, 3, 2] },
      { key: '1-4-1', label: '1 - 4 - 1', lines: [1, 4, 1] },
      { key: '1-2-3', label: '1 - 2 - 3', lines: [1, 2, 3] },
      { key: '1-1-3-1', label: '1 - 1 - 3 - 1', lines: [1, 1, 3, 1] },
    ]
  }

  if (presetByPlayers[playersOnField]) {
    return presetByPlayers[playersOnField].map((lines) => ({
      key: lines.join('-'),
      label: lines.join(' - '),
      lines,
    }))
  }

  const fieldPlayers = playersOnField - 1
  const options: FormationOption[] = []

  if (fieldPlayers >= 2) {
    for (let first = 1; first <= fieldPlayers - 1; first += 1) {
      const second = fieldPlayers - first
      options.push({
        key: `1-${first}-${second}`,
        label: `1 - ${first} - ${second}`,
        lines: [1, first, second],
      })
    }
  }

  if (fieldPlayers >= 3) {
    for (let first = 1; first <= fieldPlayers - 2; first += 1) {
      for (let second = 1; second <= fieldPlayers - first - 1; second += 1) {
        const third = fieldPlayers - first - second
        options.push({
          key: `1-${first}-${second}-${third}`,
          label: `1 - ${first} - ${second} - ${third}`,
          lines: [1, first, second, third],
        })
      }
    }
  }

  const dedup = new Map<string, FormationOption>()
  options.forEach((option) => {
    if (!dedup.has(option.key)) {
      dedup.set(option.key, option)
    }
  })

  return Array.from(dedup.values())
}

const sameStringArray = (left: string[], right: string[]) =>
  left.length === right.length && left.every((item, index) => item === right[index])

const clampInt = (value: number, minimum: number, maximum: number, fallback: number) => {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(maximum, Math.max(minimum, normalized))
}

const normalizeLabel = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

const formatCompactPlayerName = (name: string, maxLength = 18) => {
  const cleaned = name.trim().replace(/\s+/g, ' ')
  if (!cleaned) return 'Sin nombre'

  const words = cleaned.split(' ')
  if (words.length === 1) {
    if (cleaned.length <= maxLength) return cleaned
    return `${cleaned.slice(0, Math.max(1, maxLength - 1))}…`
  }

  const firstInitial = words[0].charAt(0).toUpperCase()
  const lastName = words[words.length - 1]
  const compact = `${firstInitial}. ${lastName}`
  if (compact.length <= maxLength) return compact
  return `${firstInitial}. ${lastName.slice(0, Math.max(1, maxLength - 4))}…`
}

const parseFormationLines = (formationKey?: string) => {
  if (!formationKey) return null
  const parsed = formationKey
    .split('-')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0)
  return parsed.length > 0 ? parsed : null
}

const buildVisualLines = (
  players: Array<{ id: string; name: string; number: number; position?: string }>,
  formationKey?: string,
) => {
  if (players.length === 0) return [] as Array<Array<{ id: string; name: string; number: number; position?: string }>>
  if (players.length === 1) return [players]

  const ordered = players.slice()
  const parsedFormation = parseFormationLines(formationKey)

  if (parsedFormation) {
    const lines: Array<Array<{ id: string; name: string; number: number; position?: string }>> = []
    let cursor = 0

    parsedFormation.forEach((lineSize) => {
      lines.push(ordered.slice(cursor, cursor + lineSize))
      cursor += lineSize
    })

    if (cursor < ordered.length) {
      const lastLine = lines[lines.length - 1] ?? []
      lines[lines.length - 1] = [...lastLine, ...ordered.slice(cursor)]
    }

    return lines.filter((line) => line.length > 0)
  }

  const goalkeeper = ordered.slice(0, 1)
  const outfield = ordered.slice(1)
  if (outfield.length === 0) return [goalkeeper]

  const lineCount = outfield.length >= 9 ? 4 : outfield.length >= 6 ? 3 : 2
  const base = Math.floor(outfield.length / lineCount)
  let remainder = outfield.length % lineCount
  let cursor = 0

  const lines: Array<Array<{ id: string; name: string; number: number; position?: string }>> = [goalkeeper]
  for (let index = 0; index < lineCount; index += 1) {
    const size = base + (remainder > 0 ? 1 : 0)
    remainder -= remainder > 0 ? 1 : 0
    lines.push(outfield.slice(cursor, cursor + size))
    cursor += size
  }

  return lines.filter((line) => line.length > 0)
}

const parseManualMatchId = (matchId: string, round: number) => {
  if (matchId.startsWith('manual__')) {
    const [prefix, rawRound, homeTeamId, awayTeamId] = matchId.split('__')
    if (prefix === 'manual' && Number(rawRound) === round && homeTeamId && awayTeamId) {
      return { homeTeamId, awayTeamId }
    }
  }

  const legacyPrefix = `manual-${round}-`
  if (matchId.startsWith(legacyPrefix)) {
    const parts = matchId.replace(legacyPrefix, '').split('-')
    if (parts.length >= 10) {
      const homeTeamId = parts.slice(0, 5).join('-')
      const awayTeamId = parts.slice(5).join('-')
      if (homeTeamId && awayTeamId) {
        return { homeTeamId, awayTeamId }
      }
    }
  }

  return null
}

const buildRoundLabel = (
  round: number,
  rules: {
    regularSeasonRounds: number
    finalStageRoundOf16Enabled: boolean
    finalStageRoundOf8Enabled: boolean
    finalStageQuarterFinalsEnabled: boolean
    finalStageSemiFinalsEnabled: boolean
    finalStageFinalEnabled: boolean
    finalStageRoundOf16TwoLegged: boolean
    finalStageRoundOf8TwoLegged: boolean
    finalStageQuarterFinalsTwoLegged: boolean
    finalStageSemiFinalsTwoLegged: boolean
    finalStageFinalTwoLegged: boolean
  },
) => {
  if (round <= rules.regularSeasonRounds) {
    return `Fecha ${round}`
  }

  const stages = [
    rules.finalStageRoundOf16Enabled ? { label: 'Dieciseisavos', twoLegged: rules.finalStageRoundOf16TwoLegged } : null,
    rules.finalStageRoundOf8Enabled ? { label: 'Octavos', twoLegged: rules.finalStageRoundOf8TwoLegged } : null,
    rules.finalStageQuarterFinalsEnabled ? { label: 'Cuartos', twoLegged: rules.finalStageQuarterFinalsTwoLegged } : null,
    rules.finalStageSemiFinalsEnabled ? { label: 'Semifinales', twoLegged: rules.finalStageSemiFinalsTwoLegged } : null,
    rules.finalStageFinalEnabled ? { label: 'Final', twoLegged: rules.finalStageFinalTwoLegged } : null,
  ].filter(Boolean) as Array<{ label: string; twoLegged: boolean }>

  let remaining = round - rules.regularSeasonRounds - 1

  for (const stage of stages) {
    const stageRounds = stage.twoLegged ? 2 : 1
    if (remaining < stageRounds) {
      if (!stage.twoLegged) {
        return stage.label
      }
      const legLabel = remaining === 0 ? 'Ida' : 'Vuelta'
      return `${stage.label} · ${legLabel}`
    }
    remaining -= stageRounds
  }

  return `Fase final ${round - rules.regularSeasonRounds}`
}

const dataUrlToFile = async (dataUrl: string, fileName: string) => {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return new File([blob], fileName, { type: 'image/png' })
}

function App() {
  const clientRouteMatch =
    typeof window !== 'undefined' ? window.location.pathname.match(/^\/cliente\/([^/]+)\/?$/i) : null
  const publicClientId = clientRouteMatch?.[1] ? decodeURIComponent(clientRouteMatch[1]) : ''

  const historyTop5CardRef = useRef<HTMLDivElement | null>(null)
  const historyTableRefs = useRef<Record<HistoryTabKey, HTMLDivElement | null>>({
    standings: null,
    scorers: null,
    assists: null,
    yellows: null,
    reds: null,
  })
  const [leagues, setLeagues] = useState<League[]>([])
  const [selectedLeagueId, setSelectedLeagueId] = useState('')
  const [liveMatch, setLiveMatch] = useState<LiveMatch | null>(null)
  const [selectedTeamId, setSelectedTeamId] = useState('')
  const [selectedPlayerId, setSelectedPlayerId] = useState('')
  const [selectedStaffRole, setSelectedStaffRole] = useState<LiveStaffRole>('director')
  const [adminMessage, setAdminMessage] = useState('')
  const [lineupStarters, setLineupStarters] = useState<string[]>([])
  const [lineupSubstitutes, setLineupSubstitutes] = useState<string[]>([])
  const [settingsDraft, setSettingsDraft] = useState({
    playersOnField: 11,
    matchMinutes: 90,
    breakMinutes: 15,
    homeHasBye: false,
    awayHasBye: false,
  })
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [adminView, setAdminView] = useState<'ligas' | 'partidos' | 'configuracion' | 'gestion' | 'historial' | 'auditoria'>('ligas')

  const [matchCategoryId, setMatchCategoryId] = useState('')
  const [leagueTeams, setLeagueTeams] = useState<RegisteredTeam[]>([])
  const [leagueFixture, setLeagueFixture] = useState<FixtureResponse | null>(null)
  const [selectedPendingMatchId, setSelectedPendingMatchId] = useState('')
  const [selectedPendingRound, setSelectedPendingRound] = useState('')
  const [matchesTab, setMatchesTab] = useState<'regular' | 'finales'>('regular')
  const [selectedPlayedMatchId, setSelectedPlayedMatchId] = useState('')
  const [selectedMvpPlayerId, setSelectedMvpPlayerId] = useState('')
  const [fixtureDateDraft, setFixtureDateDraft] = useState('')
  const [fixtureVenueDraft, setFixtureVenueDraft] = useState('')
  const [hoveredStarterId, setHoveredStarterId] = useState('')
  const [teamFormationById, setTeamFormationById] = useState<Record<string, string>>({})
  const [savingFormation, setSavingFormation] = useState(false)
  const [starterSlots, setStarterSlots] = useState<string[]>([])
  const [clockNowMs, setClockNowMs] = useState(() => Date.now())
  const [liveTimerAnchor, setLiveTimerAnchor] = useState({
    elapsedSeconds: 0,
    running: false,
    capturedAt: Date.now(),
  })
  const [authUser, setAuthUser] = useState<AuthUser | null>(() => {
    const raw = localStorage.getItem(authUserStorageKey)
    if (!raw) return null

    try {
      return JSON.parse(raw) as AuthUser
    } catch {
      return null
    }
  })
  const [sessionExpired, setSessionExpired] = useState(false)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginMode, setLoginMode] = useState<'super_admin' | 'client_admin'>('client_admin')
  const [superAdminUnlocked, setSuperAdminUnlocked] = useState(false)
  const superAdminHoldTimerRef = useRef<number | null>(null)
  const [clientAccessTokenInput, setClientAccessTokenInput] = useState('')
  const [clientTokenValidation, setClientTokenValidation] = useState<ClientAccessValidation | null>(null)
  const [clientTokenValidated, setClientTokenValidated] = useState(false)
  const [registerClientName, setRegisterClientName] = useState('')
  const [registerClientOrganization, setRegisterClientOrganization] = useState('')
  const [registerClientEmail, setRegisterClientEmail] = useState('')
  const [registerClientPassword, setRegisterClientPassword] = useState('')
  const [registerClientPasswordConfirm, setRegisterClientPasswordConfirm] = useState('')
  const [showClientRegister, setShowClientRegister] = useState(false)
  const [showClientResetPassword, setShowClientResetPassword] = useState(false)
  const [resetClientEmail, setResetClientEmail] = useState('')
  const [resetClientPassword, setResetClientPassword] = useState('')
  const [resetClientPasswordConfirm, setResetClientPasswordConfirm] = useState('')
  const [creatingClientUser, setCreatingClientUser] = useState(false)
  const [clientAccessTokens, setClientAccessTokens] = useState<ClientAccessTokenSummary[]>([])
  const [tokenClientUserIdDraft, setTokenClientUserIdDraft] = useState('')
  const [tokenExpiresAtDraft, setTokenExpiresAtDraft] = useState('')
  const [renewingTokenId, setRenewingTokenId] = useState('')
  const [renewTokenExpiresAtDraft, setRenewTokenExpiresAtDraft] = useState('')
  const [tokenStatusFilter, setTokenStatusFilter] = useState<TokenStatusFilter>('all')
  const [tokenPage, setTokenPage] = useState(1)
  const [clientAdminStatusFilter, setClientAdminStatusFilter] = useState<ClientAdminStatusFilter>('all')
  const [clientAdminPage, setClientAdminPage] = useState(1)
  const [publicRowsQuery, setPublicRowsQuery] = useState('')
  const [publicRowsPage, setPublicRowsPage] = useState(1)
  const [generatedTokenMessage, setGeneratedTokenMessage] = useState('')
  const [newClientNameDraft, setNewClientNameDraft] = useState('')
  const [newClientOrganizationDraft, setNewClientOrganizationDraft] = useState('')
  const [newClientEmailDraft, setNewClientEmailDraft] = useState('')
  const [newClientPasswordDraft, setNewClientPasswordDraft] = useState('')
  const [editingClientId, setEditingClientId] = useState('')
  const [editClientNameDraft, setEditClientNameDraft] = useState('')
  const [editClientOrganizationDraft, setEditClientOrganizationDraft] = useState('')
  const [editClientEmailDraft, setEditClientEmailDraft] = useState('')
  const [showLoginPassword, setShowLoginPassword] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [usersOverview, setUsersOverview] = useState<UserWithLeagues[]>([])
  const [superAdminLigasTab, setSuperAdminLigasTab] = useState<'ligas' | 'clientes'>('ligas')
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([])
  const [auditPage, setAuditPage] = useState(1)
  const [fixtureScheduleEntries, setFixtureScheduleEntries] = useState<FixtureScheduleEntry[]>([])
  const [fixtureDatesMap, setFixtureDatesMap] = useState<Record<string, string>>({})
  const [fixtureVenuesMap, setFixtureVenuesMap] = useState<Record<string, string>>({})
  const [playedMatchesMap, setPlayedMatchesMap] = useState<Record<string, PlayedMatchRecord>>({})
  const [roundAwardsRanking, setRoundAwardsRanking] = useState<RoundAwardsRankingEntry[]>([])
  const [substitutionOutPlayerId, setSubstitutionOutPlayerId] = useState('')
  const [substitutionInPlayerId, setSubstitutionInPlayerId] = useState('')
  const [substitutionVisualByTeam, setSubstitutionVisualByTeam] = useState<
    Record<string, { outPlayerIds: string[]; inPlayerIds: string[] }>
  >({})
  const [substitutionTimelineByTeam, setSubstitutionTimelineByTeam] = useState<
    Record<string, SubstitutionTimelineEntry[]>
  >({})
  const [historySeasonFilter, setHistorySeasonFilter] = useState<number>(2026)
  const [activeHistoryTab, setActiveHistoryTab] = useState<HistoryTabKey>('standings')
  const [scorersSearchTerm, setScorersSearchTerm] = useState('')
  const [assistsSearchTerm, setAssistsSearchTerm] = useState('')
  const [yellowsSearchTerm, setYellowsSearchTerm] = useState('')
  const [redsSearchTerm, setRedsSearchTerm] = useState('')
  const [scorersPage, setScorersPage] = useState(1)
  const [assistsPage, setAssistsPage] = useState(1)
  const [yellowsPage, setYellowsPage] = useState(1)
  const [redsPage, setRedsPage] = useState(1)
  const [homePenaltiesDraft, setHomePenaltiesDraft] = useState('')
  const [awayPenaltiesDraft, setAwayPenaltiesDraft] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [finalsLeftSeedTeamIds, setFinalsLeftSeedTeamIds] = useState<string[]>([])
  const [finalsRightSeedTeamIds, setFinalsRightSeedTeamIds] = useState<string[]>([])
  const [draggingFinalSeedTeamId, setDraggingFinalSeedTeamId] = useState('')
  const [showMvpModal, setShowMvpModal] = useState(false)
  const [finishingMatch, setFinishingMatch] = useState(false)
  const [mvpSearchTerm, setMvpSearchTerm] = useState('')
  const [secondHalfStarted, setSecondHalfStarted] = useState(false)
  const [competitionRulesDraft, setCompetitionRulesDraft] = useState<CompetitionRulesDraft>({
    allowDraws: true,
    pointsWin: 3,
    pointsDraw: 1,
    pointsLoss: 0,
    courtsCount: 1,
    maxRegisteredPlayers: 25,
    resolveDrawByPenalties: false,
    playoffQualifiedTeams: 8,
    finalStageRoundOf16Enabled: false,
    finalStageRoundOf8Enabled: false,
    finalStageQuarterFinalsEnabled: true,
    finalStageSemiFinalsEnabled: true,
    finalStageFinalEnabled: true,
    finalStageTwoLegged: false,
    finalStageRoundOf16TwoLegged: false,
    finalStageRoundOf8TwoLegged: false,
    finalStageQuarterFinalsTwoLegged: false,
    finalStageSemiFinalsTwoLegged: false,
    finalStageFinalTwoLegged: false,
    doubleRoundRobin: false,
    regularSeasonRounds: 9,
  })

  useEffect(() => {
    if (!superAdminUnlocked && loginMode === 'super_admin') {
      setLoginMode('client_admin')
      return
    }

    if (loginMode === 'super_admin') {
      setClientTokenValidated(false)
      setClientTokenValidation(null)
      setShowClientRegister(false)
      setShowClientResetPassword(false)
      setClientAccessTokenInput('')
      return
    }

    setLoginEmail('')
    setLoginPassword('')
  }, [loginMode, superAdminUnlocked])

  const loadLeagues = useCallback(async () => {
    if (!authUser) {
      setLoading(false)
      setLeagues([])
      return
    }

    setLoading(true)
    setErrorMessage('')

    const response = await apiService.getLeagues()
    if (!response.ok) {
      setErrorMessage(response.message)
      setLoading(false)
      return
    }

    setLeagues(response.data)
    setSelectedLeagueId((currentSelectedLeagueId) => {
      if (response.data.length === 0) return ''
      const stillExists = response.data.some((league) => league.id === currentSelectedLeagueId)
      return stillExists ? currentSelectedLeagueId : (response.data[0]?.id ?? '')
    })

    const liveResponse = await apiService.getLiveMatch()
    if (liveResponse.ok) {
      setLiveMatch(liveResponse.data)
      setSelectedTeamId(liveResponse.data.homeTeam.id)
      setLineupStarters(liveResponse.data.homeTeam.starters)
      setLineupSubstitutes(liveResponse.data.homeTeam.substitutes)
    }

    if (authUser.role === 'super_admin') {
      const [usersResponse, auditResponse, accessTokensResponse] = await Promise.all([
        apiService.getAdminUsers(),
        apiService.getAuditLogs(),
        apiService.getClientAccessTokens(),
      ])
      if (usersResponse.ok) {
        setUsersOverview(usersResponse.data)
        const firstClient = usersResponse.data.find((item) => item.role === 'client_admin')
        setTokenClientUserIdDraft((current) => current || firstClient?.id || '')
      }
      if (auditResponse.ok) {
        setAuditLogs(auditResponse.data)
        setAuditPage(1)
      }
      if (accessTokensResponse.ok) {
        setClientAccessTokens(accessTokensResponse.data)
      }
    } else {
      setUsersOverview([])
      setAuditLogs([])
      setAuditPage(1)
      setClientAccessTokens([])
    }

    setLoading(false)
  }, [authUser])

  useEffect(() => {
    queueMicrotask(() => {
      void loadLeagues()
    })
  }, [loadLeagues])

  useEffect(() => {
    const socket = io(apiBaseUrl, {
      transports: ['websocket'],
    })

    socket.on('live:update', (snapshot: LiveMatch) => {
      setLiveMatch(snapshot)
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  useEffect(() => {
    apiService.onSessionExpired(() => {
      apiService.setAuthToken('')
      localStorage.removeItem('@fl_liga_auth_user')
      setAuthUser(null)
      setLeagues([])
      setSelectedLeagueId('')
      setSessionExpired(true)
    })
  }, [])

  useEffect(() => {
    if (!apiService.getAuthToken()) return

    queueMicrotask(async () => {
      const response = await apiService.getMe()
      if (!response.ok) {
        apiService.setAuthToken('')
        setAuthUser(null)
        return
      }

      setAuthUser(response.data)
    })
  }, [])

  const selectedLeague = useMemo(
    () => leagues.find((league) => league.id === selectedLeagueId) ?? null,
    [leagues, selectedLeagueId],
  )

  const orderedClientAccessTokens = useMemo(() => {
    return [...clientAccessTokens].sort((left, right) => {
      const leftExpiresAt = new Date(left.expiresAt).getTime()
      const rightExpiresAt = new Date(right.expiresAt).getTime()
      const leftIsActive = isTokenCurrentlyActive(left)
      const rightIsActive = isTokenCurrentlyActive(right)

      if (leftIsActive !== rightIsActive) {
        return leftIsActive ? 1 : -1
      }

      return leftExpiresAt - rightExpiresAt
    })
  }, [clientAccessTokens])

  const filteredClientAccessTokens = useMemo(() => {
    if (tokenStatusFilter === 'all') return orderedClientAccessTokens
    if (tokenStatusFilter === 'active') {
      return orderedClientAccessTokens.filter((token) => isTokenCurrentlyActive(token))
    }

    return orderedClientAccessTokens.filter((token) => !isTokenCurrentlyActive(token))
  }, [orderedClientAccessTokens, tokenStatusFilter])

  const tokenTotalPages = Math.max(1, Math.ceil(filteredClientAccessTokens.length / TOKEN_PAGE_SIZE))
  const tokenPageStartIndex = filteredClientAccessTokens.length === 0 ? 0 : (tokenPage - 1) * TOKEN_PAGE_SIZE + 1
  const tokenPageEndIndex = Math.min(tokenPage * TOKEN_PAGE_SIZE, filteredClientAccessTokens.length)

  const paginatedClientAccessTokens = useMemo(() => {
    const start = (tokenPage - 1) * TOKEN_PAGE_SIZE
    return filteredClientAccessTokens.slice(start, start + TOKEN_PAGE_SIZE)
  }, [filteredClientAccessTokens, tokenPage])

  useEffect(() => {
    setTokenPage((current) => Math.min(current, tokenTotalPages))
  }, [tokenTotalPages])

  const resetMatchSelection = () => {
    setSelectedPendingMatchId('')
    setSelectedPlayedMatchId('')
    setFixtureDateDraft('')
    setFixtureVenueDraft('')
    setSelectedPendingRound('')
  }

  const handleSelectLeague = (leagueId: string) => {
    setSelectedLeagueId(leagueId)
    setMatchCategoryId('')
    resetMatchSelection()
  }

  useEffect(() => {
    if (!authUser) {
      localStorage.removeItem(authUserStorageKey)
      return
    }

    localStorage.setItem(authUserStorageKey, JSON.stringify(authUser))
  }, [authUser])

  const activeMatchCategoryId =
    matchCategoryId && selectedLeague?.categories.some((category) => category.id === matchCategoryId)
      ? matchCategoryId
      : (selectedLeague?.categories[0]?.id ?? '')

  const hasExplicitMatchCategory = Boolean(
    selectedLeague && matchCategoryId && selectedLeague.categories.some((category) => category.id === matchCategoryId),
  )

  const selectedCategoryRules = useMemo(() => {
    return selectedLeague?.categories.find((item) => item.id === activeMatchCategoryId)?.rules
  }, [activeMatchCategoryId, selectedLeague])

  const selectedCategoryCourtsCount = Math.max(1, selectedCategoryRules?.courtsCount ?? 1)

  useEffect(() => {
    if (!selectedCategoryRules) return
    queueMicrotask(() => {
      setSettingsDraft((current) => ({
        ...current,
        playersOnField: selectedCategoryRules.playersOnField ?? 11,
        matchMinutes: selectedCategoryRules.matchMinutes ?? 90,
        breakMinutes: selectedCategoryRules.breakMinutes ?? 15,
      }))
      setCompetitionRulesDraft((current) => {
        const baseFinalTwoLegged =
          selectedCategoryRules.finalStageFinalTwoLegged
          ?? selectedCategoryRules.finalStageTwoLegged
          ?? selectedCategoryRules.playoffHomeAway
          ?? false

        return {
          ...current,
          allowDraws: selectedCategoryRules.allowDraws ?? true,
          pointsWin: selectedCategoryRules.pointsWin ?? 3,
          pointsDraw: selectedCategoryRules.pointsDraw ?? 1,
          pointsLoss: selectedCategoryRules.pointsLoss ?? 0,
          courtsCount: selectedCategoryRules.courtsCount ?? 1,
          maxRegisteredPlayers: selectedCategoryRules.maxRegisteredPlayers ?? 25,
          resolveDrawByPenalties: selectedCategoryRules.resolveDrawByPenalties ?? false,
          playoffQualifiedTeams: selectedCategoryRules.playoffQualifiedTeams ?? 8,
          finalStageRoundOf16Enabled: selectedCategoryRules.finalStageRoundOf16Enabled ?? false,
          finalStageRoundOf8Enabled: selectedCategoryRules.finalStageRoundOf8Enabled ?? false,
          finalStageQuarterFinalsEnabled:
            selectedCategoryRules.finalStageQuarterFinalsEnabled ?? true,
          finalStageSemiFinalsEnabled: selectedCategoryRules.finalStageSemiFinalsEnabled ?? true,
          finalStageFinalEnabled: selectedCategoryRules.finalStageFinalEnabled ?? true,
          finalStageTwoLegged: baseFinalTwoLegged,
          finalStageRoundOf16TwoLegged:
            selectedCategoryRules.finalStageRoundOf16TwoLegged ?? false,
          finalStageRoundOf8TwoLegged: selectedCategoryRules.finalStageRoundOf8TwoLegged ?? false,
          finalStageQuarterFinalsTwoLegged:
            selectedCategoryRules.finalStageQuarterFinalsTwoLegged ?? false,
          finalStageSemiFinalsTwoLegged:
            selectedCategoryRules.finalStageSemiFinalsTwoLegged ?? false,
          finalStageFinalTwoLegged:
            selectedCategoryRules.finalStageFinalTwoLegged
            ?? selectedCategoryRules.finalStageTwoLegged
            ?? selectedCategoryRules.playoffHomeAway
            ?? false,
          doubleRoundRobin: selectedCategoryRules.doubleRoundRobin ?? false,
          regularSeasonRounds: selectedCategoryRules.regularSeasonRounds ?? 9,
        }
      })
    })
  }, [selectedCategoryRules])

  useEffect(() => {
    queueMicrotask(() => {
      setHomePenaltiesDraft('')
      setAwayPenaltiesDraft('')
    })
  }, [selectedPendingMatchId])

  useEffect(() => {
    let disposed = false

    const run = async () => {
      if (!selectedLeague || !activeMatchCategoryId) {
        if (!disposed) {
          setLeagueTeams([])
          setLeagueFixture(null)
          setFixtureScheduleEntries([])
          setFixtureDatesMap({})
          setFixtureVenuesMap({})
          setPlayedMatchesMap({})
          setRoundAwardsRanking([])
        }
        return
      }

      const [teamsResponse, fixtureResponse, scheduleResponse, playedResponse, rankingResponse] = await Promise.all([
        apiService.getLeagueTeams(selectedLeague.id, activeMatchCategoryId),
        apiService.getLeagueFixture(selectedLeague.id, activeMatchCategoryId),
        apiService.getFixtureSchedule(selectedLeague.id, activeMatchCategoryId),
        apiService.getPlayedMatches(selectedLeague.id, activeMatchCategoryId),
        apiService.getRoundAwardsRanking(selectedLeague.id, activeMatchCategoryId),
      ])

      if (disposed) return

      if (teamsResponse.ok) {
        setLeagueTeams(teamsResponse.data)
      }

      if (fixtureResponse.ok) {
        setLeagueFixture(fixtureResponse.data)
      }

      if (scheduleResponse?.ok) {
        const scheduleMap: Record<string, string> = {}
        const venueMap: Record<string, string> = {}
        scheduleResponse.data.forEach((entry: { matchId: string; scheduledAt: string; venue?: string }) => {
          scheduleMap[entry.matchId] = entry.scheduledAt
          if (entry.venue) {
            venueMap[entry.matchId] = entry.venue
          }
        })
        setFixtureScheduleEntries(scheduleResponse.data)
        setFixtureDatesMap(scheduleMap)
        setFixtureVenuesMap(venueMap)
      } else {
        setFixtureScheduleEntries([])
        setFixtureDatesMap({})
        setFixtureVenuesMap({})
      }

      if (playedResponse?.ok) {
        const nextPlayedMap: Record<string, PlayedMatchRecord> = {}
        playedResponse.data.forEach((record: PlayedMatchRecord) => {
          nextPlayedMap[record.matchId] = record
        })
        setPlayedMatchesMap(nextPlayedMap)
      } else {
        setPlayedMatchesMap({})
      }

      if (rankingResponse?.ok) {
        setRoundAwardsRanking(rankingResponse.data)
      } else {
        setRoundAwardsRanking([])
      }
    }

    void run()

    return () => {
      disposed = true
    }
  }, [activeMatchCategoryId, selectedLeague])

  const selectedTeam = useMemo(() => {
    if (!liveMatch) return null
    if (liveMatch.homeTeam.id === selectedTeamId) return liveMatch.homeTeam
    if (liveMatch.awayTeam.id === selectedTeamId) return liveMatch.awayTeam
    return liveMatch.homeTeam
  }, [liveMatch, selectedTeamId])

  useEffect(() => {
    if (!liveMatch) return
    setLiveTimerAnchor({
      elapsedSeconds: liveMatch.timer.elapsedSeconds,
      running: liveMatch.timer.running,
      capturedAt: Date.now(),
    })
  }, [liveMatch])

  useEffect(() => {
    if (!liveTimerAnchor.running) return

    const interval = window.setInterval(() => {
      setClockNowMs(Date.now())
    }, 1000)

    return () => window.clearInterval(interval)
  }, [liveTimerAnchor.running])

  const liveElapsedSeconds = useMemo(() => {
    if (!liveMatch) return 0
    if (!liveTimerAnchor.running) {
      return liveTimerAnchor.elapsedSeconds
    }

    const delta = Math.floor((clockNowMs - liveTimerAnchor.capturedAt) / 1000)
    return liveTimerAnchor.elapsedSeconds + Math.max(delta, 0)
  }, [clockNowMs, liveMatch, liveTimerAnchor])

  const liveCurrentMinute = Math.floor(liveElapsedSeconds / 60)

  const allRegisteredPlayers = useMemo(() => {
    if (!selectedTeam) return []
    return selectedTeam.players
  }, [selectedTeam])

  const formationOptions = useMemo(() => buildFormationOptions(settingsDraft.playersOnField), [settingsDraft.playersOnField])

  const selectedFormationKey = useMemo(() => {
    const stored = selectedTeamId ? teamFormationById[selectedTeamId] : ''
    if (stored && formationOptions.some((option) => option.key === stored)) {
      return stored
    }
    return formationOptions[0]?.key ?? ''
  }, [formationOptions, selectedTeamId, teamFormationById])

  const setFormationForSelectedTeam = useCallback((formationKey: string) => {
    if (!selectedTeamId) return
    setTeamFormationById((current) => ({
      ...current,
      [selectedTeamId]: formationKey,
    }))
  }, [selectedTeamId])

  const handleFormationChange = useCallback(
    async (formationKey: string) => {
      if (!selectedTeam) return
      if (savingFormation) return
      if (liveMatch?.status === 'finished') {
        applyActionFeedback(false, '', 'Partido finalizado: no se puede cambiar la formación')
        return
      }

      setFormationForSelectedTeam(formationKey)

      setSavingFormation(true)
      try {
        const response = await apiService.saveLineup(
          selectedTeam.id,
          selectedTeam.starters,
          selectedTeam.substitutes,
          formationKey,
        )

        applyActionFeedback(
          response.ok,
          'Formación guardada y sincronizada en vivo',
          response.ok ? '' : response.message,
        )
      } finally {
        setSavingFormation(false)
      }
    },
    [liveMatch, savingFormation, selectedTeam, setFormationForSelectedTeam],
  )

  const activeFormation = useMemo(
    () => formationOptions.find((option) => option.key === selectedFormationKey) ?? formationOptions[0] ?? null,
    [formationOptions, selectedFormationKey],
  )

  const formationSlotsCount = useMemo(
    () => activeFormation?.lines.reduce((acc, value) => acc + value, 0) ?? settingsDraft.playersOnField,
    [activeFormation, settingsDraft.playersOnField],
  )

  const formationRows = useMemo(() => {
    if (!activeFormation) return [] as Array<{ rowIndex: number; slotIndices: number[]; label: string }>

    let cursor = 0
    return activeFormation.lines.map((playersInLine, rowIndex) => {
      const slotIndices = Array.from({ length: playersInLine }, (_, offset) => cursor + offset)
      cursor += playersInLine

      let label = `Línea ${rowIndex + 1}`
      if (rowIndex === 0) {
        label = 'Arco'
      } else if (rowIndex === activeFormation.lines.length - 1) {
        label = 'Ataque'
      }

      return {
        rowIndex,
        slotIndices,
        label,
      }
    })
  }, [activeFormation])

  const liveIsFinished = liveMatch?.status === 'finished'
  const liveHasStarted = Boolean((liveMatch?.status === 'live') || (liveMatch?.timer.elapsedSeconds ?? 0) > 0)
  const liveTimerRunning = Boolean(liveMatch?.timer.running)
  const canRegisterLiveEvents = Boolean(!liveIsFinished && liveTimerRunning)
  const canKickoff = Boolean(!liveIsFinished && !liveHasStarted)
  const canEndFirstHalf = Boolean(!liveIsFinished && liveHasStarted && liveTimerRunning && !secondHalfStarted)
  const canStartSecondHalf = Boolean(!liveIsFinished && liveHasStarted && !liveTimerRunning && !secondHalfStarted)
  const canResetTimer = Boolean(!liveIsFinished && liveHasStarted)
  const canFinalizeMatch = Boolean(!liveIsFinished && liveHasStarted)

  const playerMap = useMemo(() => {
    if (!selectedTeam) return new Map<string, LivePlayer>()
    return new Map(selectedTeam.players.map((player) => [player.id, player]))
  }, [selectedTeam])

  const applySlotsToLineup = useCallback(
    (nextSlots: string[]) => {
      if (!selectedTeam) return

      const starters = nextSlots.filter(Boolean)
      const starterSet = new Set(starters)
      const allowedIds = new Set(allRegisteredPlayers.map((player) => player.id))
      const redCarded = new Set(selectedTeam.redCarded)

      const nextSubstitutes = allRegisteredPlayers
        .map((player) => player.id)
        .filter((playerId) => allowedIds.has(playerId) && !starterSet.has(playerId) && !redCarded.has(playerId))

      setStarterSlots(nextSlots)
      setLineupStarters(starters)
      setLineupSubstitutes(nextSubstitutes)
    },
    [allRegisteredPlayers, selectedTeam],
  )

  const selectedPlayerLiveStats = useMemo(() => {
    if (!selectedTeam || !selectedPlayerId) {
      return { shots: 0, goals: 0, assists: 0, yellows: 0, reds: 0 }
    }

    return (
      selectedTeam.playerStats[selectedPlayerId] ?? {
        shots: 0,
        goals: 0,
        assists: 0,
        yellows: 0,
        reds: 0,
      }
    )
  }, [selectedPlayerId, selectedTeam])

  const substitutedOutByTeam = useMemo(() => {
    const map = new Map<string, Set<string>>()
    if (!liveMatch) return map

    liveMatch.events.forEach((event) => {
      if (event.type !== 'substitution' || !event.playerId) return
      const current = map.get(event.teamId) ?? new Set<string>()
      current.add(event.playerId)
      map.set(event.teamId, current)
    })

    return map
  }, [liveMatch])

  const substitutedInByTeam = useMemo(() => {
    const map = new Map<string, Set<string>>()
    if (!liveMatch) return map

    liveMatch.events.forEach((event) => {
      if (event.type !== 'substitution' || !event.substitutionInPlayerId) return
      const current = map.get(event.teamId) ?? new Set<string>()
      current.add(event.substitutionInPlayerId)
      map.set(event.teamId, current)
    })

    return map
  }, [liveMatch])

  const selectedTeamSubstitutedOut = useMemo(() => {
    if (!selectedTeam) return new Set<string>()
    return substitutedOutByTeam.get(selectedTeam.id) ?? new Set<string>()
  }, [selectedTeam, substitutedOutByTeam])

  const selectedTeamSubstitutionVisual = useMemo(() => {
    if (!selectedTeam) return { outPlayerIds: [] as string[], inPlayerIds: [] as string[] }
    return substitutionVisualByTeam[selectedTeam.id] ?? { outPlayerIds: [] as string[], inPlayerIds: [] as string[] }
  }, [selectedTeam, substitutionVisualByTeam])

  const selectedTeamSubstitutionTimeline = useMemo(() => {
    if (!selectedTeam) return [] as SubstitutionTimelineEntry[]
    return substitutionTimelineByTeam[selectedTeam.id] ?? []
  }, [selectedTeam, substitutionTimelineByTeam])

  const selectedTeamSubstitutedIn = useMemo(() => {
    const eventTracked = selectedTeam ? substitutedInByTeam.get(selectedTeam.id) : null
    return new Set<string>([...(eventTracked ? Array.from(eventTracked) : []), ...selectedTeamSubstitutionVisual.inPlayerIds])
  }, [selectedTeam, selectedTeamSubstitutionVisual.inPlayerIds, substitutedInByTeam])

  const substituteVisualIds = useMemo(() => {
    if (!selectedTeam) return [] as string[]
    const visibleIds = new Set<string>([...lineupSubstitutes, ...selectedTeamSubstitutionVisual.inPlayerIds])
    return selectedTeam.players.map((player) => player.id).filter((id) => visibleIds.has(id))
  }, [lineupSubstitutes, selectedTeam, selectedTeamSubstitutionVisual.inPlayerIds])

  const playerBadges = useCallback(
    (playerId: string) => {
      if (!selectedTeam) return [] as string[]

      const stats = selectedTeam.playerStats[playerId] ?? { goals: 0, assists: 0, yellows: 0, reds: 0 }
      const badges: string[] = []

      if (stats.goals > 0) badges.push(`⚽ ${stats.goals}`)
      if (stats.assists > 0) badges.push(`🅰 ${stats.assists}`)
      if (stats.yellows > 0) badges.push(`🟨 ${stats.yellows}`)
      if (stats.reds > 0) badges.push(`🟥 ${stats.reds}`)

      if (selectedTeamSubstitutedOut.has(playerId)) badges.push('↘ Salió')
      if (selectedTeamSubstitutedIn.has(playerId)) badges.push('↗ Entró')

      return badges
    },
    [selectedTeam, selectedTeamSubstitutedIn, selectedTeamSubstitutedOut],
  )

  const liveTotals = useMemo(() => {
    if (!liveMatch) {
      return { shots: 0, goals: 0, assists: 0, yellows: 0, reds: 0 }
    }

    return {
      shots: liveMatch.homeTeam.stats.shots + liveMatch.awayTeam.stats.shots,
      goals: liveMatch.homeTeam.stats.goals + liveMatch.awayTeam.stats.goals,
      assists: liveMatch.homeTeam.stats.assists + liveMatch.awayTeam.stats.assists,
      yellows: liveMatch.homeTeam.stats.yellows + liveMatch.awayTeam.stats.yellows,
      reds: liveMatch.homeTeam.stats.reds + liveMatch.awayTeam.stats.reds,
    }
  }, [liveMatch])

  const statPercent = (value: number, total: number) => {
    if (total <= 0) return 0
    return Math.round((value / total) * 100)
  }

  const formatTimer = (seconds: number) => {
    const minutes = Math.floor(seconds / 60)
    const left = seconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(left).padStart(2, '0')}`
  }

  const eventLabel = (type: string) => {
    const labels: Record<string, string> = {
      shot: 'Remate',
      goal: 'Gol',
      penalty_goal: 'Gol de penal',
      penalty_miss: 'Penal fallado',
      assist: 'Asistencia',
      yellow: 'Tarjeta amarilla',
      red: 'Tarjeta roja',
      double_yellow: 'Doble amarilla (TR)',
      substitution: 'Cambio',
      staff_yellow: 'TA cuerpo técnico',
      staff_red: 'TR cuerpo técnico',
    }

    return labels[type] ?? type
  }

  const staffRoleLabel = (role: LiveStaffRole) => (role === 'director' ? 'DT' : 'AT')

  const resolveEventActorLabel = useCallback((
    team: LiveTeam,
    event: { playerId: string | null; staffRole?: LiveStaffRole; type?: LiveEvent['type']; substitutionInPlayerId?: string },
  ) => {
    if (event.staffRole) {
      const staffName = team.technicalStaff?.[event.staffRole]?.name?.trim() || 'Sin registrar'
      return `${staffRoleLabel(event.staffRole)} ${staffName}`
    }

    if (!event.playerId) return 'Sin jugador'
    const player = team.players.find((item) => item.id === event.playerId)
    const outPlayerName = player?.name ?? 'Sin jugador'

    if (event.type === 'substitution') {
      const inPlayerName = event.substitutionInPlayerId
        ? (team.players.find((item) => item.id === event.substitutionInPlayerId)?.name ?? 'Sin jugador')
        : ''

      return inPlayerName ? `${outPlayerName} ↘ · ${inPlayerName} ↗` : `${outPlayerName} ↘`
    }

    return outPlayerName
  }, [])

  const resolveLiveTeamById = useCallback(
    (teamId: string) => {
      if (!liveMatch) return null
      if (liveMatch.homeTeam.id === teamId) return liveMatch.homeTeam
      if (liveMatch.awayTeam.id === teamId) return liveMatch.awayTeam
      return null
    },
    [liveMatch],
  )

  const resolveEventTypeForCard = useCallback(
    (
      teamId: string,
      playerId: string | null,
      eventType: 'shot' | 'goal' | 'penalty_goal' | 'penalty_miss' | 'yellow' | 'red' | 'assist' | 'substitution',
    ) => {
      if (eventType !== 'yellow' || !playerId) {
        return { type: eventType as typeof eventType | 'double_yellow', isDoubleYellow: false }
      }

      const team = resolveLiveTeamById(teamId)
      if (!team) {
        return { type: eventType as typeof eventType | 'double_yellow', isDoubleYellow: false }
      }

      const stats = team.playerStats[playerId]
      const alreadyYellow = (stats?.yellows ?? 0) >= 1
      const alreadyRed = (stats?.reds ?? 0) >= 1 || team.redCarded.includes(playerId)

      if (alreadyYellow && !alreadyRed) {
        return { type: 'double_yellow' as const, isDoubleYellow: true }
      }

      return { type: eventType as typeof eventType | 'double_yellow', isDoubleYellow: false }
    },
    [resolveLiveTeamById],
  )

  const syncTeamDraft = (team: LiveTeam) => {
    setSelectedTeamId(team.id)
    setLineupStarters(team.starters)
    setLineupSubstitutes(team.substitutes)
    setSelectedPlayerId(team.players[0]?.id ?? '')
    setSubstitutionOutPlayerId('')
    setSubstitutionInPlayerId('')
  }

  useEffect(() => {
    if (!liveMatch) return
    if (!selectedTeamId) {
      queueMicrotask(() => {
        syncTeamDraft(liveMatch.homeTeam)
      })
      return
    }

    const activeTeam = selectedTeamId === liveMatch.homeTeam.id ? liveMatch.homeTeam : liveMatch.awayTeam
    queueMicrotask(() => {
      setLineupStarters(activeTeam.starters)
      setLineupSubstitutes(activeTeam.substitutes)
    })
  }, [liveMatch, selectedTeamId])

  useEffect(() => {
    if (!liveMatch) return

    setTeamFormationById((current) => {
      const next = { ...current }
      let changed = false

      const candidates = [liveMatch.homeTeam, liveMatch.awayTeam]
      candidates.forEach((team) => {
        if (!team.formationKey) return
        if (next[team.id]) return
        next[team.id] = team.formationKey
        changed = true
      })

      return changed ? next : current
    })
  }, [liveMatch])

  useEffect(() => {
    if (!selectedTeam) return

    const hasDirector = Boolean(selectedTeam.technicalStaff?.director?.name?.trim())
    const hasAssistant = Boolean(selectedTeam.technicalStaff?.assistant?.name?.trim())
    if (selectedStaffRole === 'director' && !hasDirector && hasAssistant) {
      setSelectedStaffRole('assistant')
    }
    if (selectedStaffRole === 'assistant' && !hasAssistant && hasDirector) {
      setSelectedStaffRole('director')
    }

    const teamPlayerIds = new Set(selectedTeam.players.map((player) => player.id))
    const validStarters = lineupStarters.filter((playerId) => teamPlayerIds.has(playerId) && !selectedTeam.redCarded.includes(playerId))

    queueMicrotask(() => {
      setStarterSlots((current) => {
        const next = Array.from({ length: formationSlotsCount }, () => '')
        const pending = [...validStarters]

        if (current.length === formationSlotsCount) {
          current.forEach((playerId, index) => {
            if (!playerId) return
            const playerPos = pending.indexOf(playerId)
            if (playerPos === -1) return
            next[index] = playerId
            pending.splice(playerPos, 1)
          })
        }

        next.forEach((playerId, index) => {
          if (playerId) return
          const player = pending.shift()
          if (player) {
            next[index] = player
          }
        })

        return sameStringArray(current, next) ? current : next
      })
    })
  }, [formationSlotsCount, lineupStarters, selectedStaffRole, selectedTeam])

  const applyActionFeedback = (ok: boolean, successText: string, failText: string) => {
    setAdminMessage(ok ? successText : failText)
    window.setTimeout(() => setAdminMessage(''), 3000)
  }

  const startSuperAdminLogoPress = () => {
    if (superAdminUnlocked || authUser) return
    if (superAdminHoldTimerRef.current) {
      window.clearTimeout(superAdminHoldTimerRef.current)
    }

    superAdminHoldTimerRef.current = window.setTimeout(() => {
      setSuperAdminUnlocked(true)
      setLoginMode('super_admin')
      setLoginError('Modo Super Admin habilitado')
    }, 5000)
  }

  const endSuperAdminLogoPress = () => {
    if (!superAdminHoldTimerRef.current) return
    window.clearTimeout(superAdminHoldTimerRef.current)
    superAdminHoldTimerRef.current = null
  }

  const handleValidateClientToken = async () => {
    setLoginError('')
    const token = clientAccessTokenInput.trim()
    if (!token) {
      setLoginError('Ingresa el token compartido por super admin')
      return
    }

    const response = await apiService.validateClientAccessToken(token)
    if (!response.ok) {
      setClientTokenValidated(false)
      setClientTokenValidation(null)
      setLoginError(response.message)
      return
    }

    setClientTokenValidation(response.data)
    setClientTokenValidated(true)
    setLoginEmail(response.data.client.email)
    setRegisterClientName(response.data.client.name)
    setRegisterClientOrganization(response.data.client.organizationName ?? '')
    setRegisterClientEmail(response.data.client.email)
    setResetClientEmail(response.data.client.email)
    setLoginError('')
  }

  const handleLogin = async () => {
    setLoginError('')
    if (loginMode === 'client_admin' && !clientTokenValidated) {
      setLoginError('Primero valida tu token de cliente')
      return
    }

    const response = await apiService.login({
      identifier: loginEmail.trim(),
      password: loginPassword,
      ...(loginMode === 'client_admin' ? { accessToken: clientAccessTokenInput.trim() } : {}),
    })
    if (!response.ok) {
      if (response.code === 'MUST_CHANGE_PASSWORD') {
        setShowClientResetPassword(true)
        setResetClientEmail(loginEmail.trim())
      }
      setLoginError(response.message)
      return
    }

    apiService.setAuthToken(response.data.token)
    setAuthUser(response.data.user)
    setAdminView('ligas')
    void loadLeagues()
  }

  const handleCreateClientUser = async () => {
    if (!clientTokenValidated) {
      setLoginError('Primero valida el token de cliente')
      return
    }

    if (!registerClientName.trim() || !registerClientEmail.trim() || !registerClientPassword.trim()) {
      setLoginError('Completa nombre, correo y contraseña para crear usuario cliente')
      return
    }

    if (!registerClientOrganization.trim()) {
      setLoginError('Ingresa empresa o nombre de liga')
      return
    }

    if (registerClientPassword !== registerClientPasswordConfirm) {
      setLoginError('Las contraseñas no coinciden')
      return
    }

    setCreatingClientUser(true)
    setLoginError('')
    const response = await apiService.registerClientWithToken({
      accessToken: clientAccessTokenInput.trim(),
      fullName: registerClientName.trim(),
      organizationName: registerClientOrganization.trim(),
      email: registerClientEmail.trim(),
      password: registerClientPassword,
    })
    setCreatingClientUser(false)

    if (!response.ok) {
      setLoginError(response.message)
      return
    }

    apiService.setAuthToken(response.data.token)
    setAuthUser(response.data.user)
    setAdminView('ligas')
    void loadLeagues()
  }

  const handleResetClientPassword = async () => {
    if (!clientTokenValidated) {
      setLoginError('Primero valida el token de cliente')
      return
    }

    if (!resetClientEmail.trim() || !resetClientPassword.trim()) {
      setLoginError('Completa correo y nueva contraseña')
      return
    }

    if (resetClientPassword !== resetClientPasswordConfirm) {
      setLoginError('Las contraseñas no coinciden')
      return
    }

    const response = await apiService.resetClientPasswordWithToken({
      accessToken: clientAccessTokenInput.trim(),
      email: resetClientEmail.trim(),
      password: resetClientPassword,
      ...(loginPassword.trim() ? { currentPassword: loginPassword } : {}),
    })

    if (!response.ok) {
      setLoginError(response.message)
      return
    }

    setLoginError('Contraseña restablecida. Ya puedes iniciar sesión.')
    setShowClientResetPassword(false)
    setLoginEmail(resetClientEmail.trim())
    setLoginPassword('')
    setResetClientPassword('')
    setResetClientPasswordConfirm('')
  }

  const handleGenerateClientAccessToken = async () => {
    if (!tokenClientUserIdDraft || !tokenExpiresAtDraft) {
      setGeneratedTokenMessage('Selecciona cliente y fecha de caducidad')
      return
    }

    const expiresIso = new Date(tokenExpiresAtDraft).toISOString()
    const response = await apiService.createClientAccessToken(tokenClientUserIdDraft, expiresIso)
    if (!response.ok) {
      setGeneratedTokenMessage(response.message)
      return
    }

    setGeneratedTokenMessage(
      `Token generado: ${response.data.token} | Contraseña temporal: ${response.data.temporaryPassword}${
        response.data.publicPortalPath
          ? ` | Link público: ${window.location.origin}${response.data.publicPortalPath}`
          : ''
      }${response.data.emailError ? ` | Correo no enviado: ${response.data.emailError}` : response.data.emailMessageId ? ' | Correo enviado' : ''}`,
    )
    const refreshResponse = await apiService.getClientAccessTokens()
    if (refreshResponse.ok) {
      setClientAccessTokens(refreshResponse.data)
    }
  }

  const handleCreateClientAdmin = async () => {
    if (!newClientNameDraft.trim() || !newClientOrganizationDraft.trim() || !newClientEmailDraft.trim()) {
      setGeneratedTokenMessage('Nombre, empresa/liga y correo del cliente son obligatorios')
      return
    }

    const response = await apiService.createClientAdminUser({
      name: newClientNameDraft.trim(),
      organizationName: newClientOrganizationDraft.trim(),
      email: newClientEmailDraft.trim(),
      ...(newClientPasswordDraft.trim() ? { password: newClientPasswordDraft.trim() } : {}),
    })

    if (!response.ok) {
      setGeneratedTokenMessage(response.message)
      return
    }

    setGeneratedTokenMessage(`Cliente creado: ${response.data.name}`)
    setNewClientNameDraft('')
    setNewClientOrganizationDraft('')
    setNewClientEmailDraft('')
    setNewClientPasswordDraft('')

    const usersResponse = await apiService.getAdminUsers()
    if (usersResponse.ok) {
      setUsersOverview(usersResponse.data)
      const created = usersResponse.data.find((item) => item.email.toLowerCase() === response.data.email.toLowerCase())
      if (created) {
        setTokenClientUserIdDraft(created.id)
      }
    }
  }

  const beginEditClientAdmin = (client: UserWithLeagues) => {
    setEditingClientId(client.id)
    setEditClientNameDraft(client.name)
    setEditClientOrganizationDraft(client.organizationName ?? '')
    setEditClientEmailDraft(client.email)
  }

  const cancelEditClientAdmin = () => {
    setEditingClientId('')
    setEditClientNameDraft('')
    setEditClientOrganizationDraft('')
    setEditClientEmailDraft('')
  }

  const saveEditClientAdmin = async () => {
    if (!editingClientId) return
    if (!editClientNameDraft.trim() || !editClientOrganizationDraft.trim() || !editClientEmailDraft.trim()) {
      setGeneratedTokenMessage('Nombre, empresa/liga y correo del cliente son obligatorios para editar')
      return
    }

    const response = await apiService.updateClientAdminUser(editingClientId, {
      name: editClientNameDraft.trim(),
      organizationName: editClientOrganizationDraft.trim(),
      email: editClientEmailDraft.trim().toLowerCase(),
    })

    if (!response.ok) {
      setGeneratedTokenMessage(response.message)
      return
    }

    setGeneratedTokenMessage(`Cliente actualizado: ${response.data.name}`)
    cancelEditClientAdmin()
    await loadLeagues()
  }

  const toggleClientAdminActive = async (client: UserWithLeagues) => {
    const response = await apiService.updateClientAdminUser(client.id, {
      active: !client.active,
    })

    if (!response.ok) {
      setGeneratedTokenMessage(response.message)
      return
    }

    setGeneratedTokenMessage(
      response.data.active
        ? `Cliente reactivado: ${response.data.name}`
        : `Cliente desactivado lógicamente: ${response.data.name}`,
    )
    await loadLeagues()
  }

  const regenerateClientTemporaryPassword = async (client: UserWithLeagues) => {
    const response = await apiService.resetClientAdminTemporaryPassword(client.id)
    if (!response.ok) {
      setGeneratedTokenMessage(response.message)
      return
    }

    setGeneratedTokenMessage(
      `Contraseña temporal de ${response.data.name}: ${response.data.temporaryPassword} (visible ahora, guárdala antes de salir).`,
    )
    await loadLeagues()
  }

  const handleRevokeClientAccessToken = async (tokenId: string) => {
    if (typeof window !== 'undefined' && !window.confirm('Esto caducará el token inmediatamente. ¿Deseas continuar?')) {
      return
    }

    const response = await apiService.revokeClientAccessToken(tokenId)
    if (!response.ok) {
      setGeneratedTokenMessage(response.message)
      return
    }

    setClientAccessTokens((current) =>
      current.map((token) => (token.id === tokenId ? { ...token, active: false, revokedAt: response.data.revokedAt } : token)),
    )
    setGeneratedTokenMessage('Token caducado inmediatamente')
  }

  const handleRenewClientAccessToken = async (tokenId: string, expiresAtDraft?: string) => {
    const selectedExpiresAt = expiresAtDraft?.trim() || toDateTimeLocalValue(Date.now() + 30 * 24 * 60 * 60 * 1000)
    if (!selectedExpiresAt) {
      setGeneratedTokenMessage('Selecciona una fecha válida para renovar el token')
      return
    }

    const expiresIso = new Date(selectedExpiresAt).toISOString()
    const response = await apiService.renewClientAccessToken(tokenId, expiresIso)
    if (!response.ok) {
      setGeneratedTokenMessage(response.message)
      return
    }

    setClientAccessTokens((current) =>
      current.map((token) =>
        token.id === tokenId
          ? { ...token, expiresAt: response.data.expiresAt, active: response.data.active, revokedAt: undefined }
          : token,
      ),
    )
    setRenewingTokenId('')
    setRenewTokenExpiresAtDraft('')
    setGeneratedTokenMessage(`Token renovado hasta ${new Date(response.data.expiresAt).toLocaleString()}`)
  }

  const handleCopyPublicLink = async (url: string) => {
    if (!url || url === '-') return

    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setGeneratedTokenMessage(`No se pudo copiar automáticamente. Copia manual: ${url}`)
      return
    }

    try {
      await navigator.clipboard.writeText(url)
      setGeneratedTokenMessage(`Link copiado: ${url}`)
    } catch {
      setGeneratedTokenMessage(`No se pudo copiar automáticamente. Copia manual: ${url}`)
    }
  }

  const handleLogout = () => {
    queueMicrotask(async () => {
      await apiService.logout()
      apiService.setAuthToken('')
      setAuthUser(null)
      setLeagues([])
      setSelectedLeagueId('')
      setUsersOverview([])
      setAuditLogs([])
      setAuditPage(1)
      setLeagueTeams([])
      setLeagueFixture(null)
      setFixtureScheduleEntries([])
      setFixtureDatesMap({})
      setFixtureVenuesMap({})
      setPlayedMatchesMap({})
      setRoundAwardsRanking([])
      setSubstitutionOutPlayerId('')
      setSubstitutionInPlayerId('')
      setClientAccessTokenInput('')
      setClientTokenValidation(null)
      setClientTokenValidated(false)
      setShowClientRegister(false)
    })
  }

  const saveLineup = async () => {
    if (!selectedTeam) return
    if (liveIsFinished) {
      applyActionFeedback(false, '', 'Partido finalizado: no se puede editar la alineación')
      return
    }

    const response = await apiService.saveLineup(
      selectedTeam.id,
      lineupStarters,
      lineupSubstitutes,
      selectedFormationKey || undefined,
    )
    applyActionFeedback(response.ok, 'Alineación guardada', response.ok ? '' : response.message)
  }

  const setTimerAction = async (action: 'start' | 'stop' | 'reset' | 'finish') => {
    if (liveIsFinished) {
      applyActionFeedback(false, '', 'Partido finalizado: el timer está bloqueado')
      return
    }

    if (action === 'start' && !(canKickoff || canStartSecondHalf)) {
      applyActionFeedback(false, '', 'No se puede iniciar en este estado')
      return
    }

    if (action === 'stop' && !canEndFirstHalf) {
      applyActionFeedback(false, '', 'Solo puedes terminar PT cuando el reloj está corriendo')
      return
    }

    if (action === 'reset' && !canResetTimer) {
      applyActionFeedback(false, '', 'Debes iniciar el partido para reiniciar')
      return
    }

    if (action === 'finish' && !canFinalizeMatch) {
      applyActionFeedback(false, '', 'Debes iniciar el partido para finalizar')
      return
    }

    if (action === 'finish') {
      setShowMvpModal(true)
      return
    }

    const response = await apiService.setLiveTimer(action)
    if (response.ok) {
      setLiveMatch(response.data)
      const activeTeam =
        response.data.homeTeam.id === selectedTeamId || response.data.awayTeam.id === selectedTeamId
          ? (response.data.homeTeam.id === selectedTeamId ? response.data.homeTeam : response.data.awayTeam)
          : response.data.homeTeam
      setSelectedTeamId(activeTeam.id)
      setLineupStarters(activeTeam.starters)
      setLineupSubstitutes(activeTeam.substitutes)

      if (action === 'start' && liveHasStarted) {
        setSecondHalfStarted(true)
      }
      if (action === 'reset') {
        setSecondHalfStarted(false)
        setSelectedPlayerId('')
        setSubstitutionOutPlayerId('')
        setSubstitutionInPlayerId('')
        setSelectedMvpPlayerId('')
        setSubstitutionVisualByTeam({})
        setSubstitutionTimelineByTeam({})
      }
    }
    const labels: Record<'start' | 'stop' | 'reset' | 'finish', string> = {
      start: liveHasStarted ? 'Segundo tiempo iniciado' : 'Partido iniciado',
      stop: 'Primer tiempo terminado',
      reset: 'Live reiniciado: marcador, eventos y alineaciones en cero',
      finish: 'Partido finalizado',
    }
    applyActionFeedback(response.ok, labels[action], response.ok ? '' : response.message)
  }

  const finalizeMatchWithMvp = async () => {
    if (!selectedMvpPlayerId) {
      applyActionFeedback(false, '', 'Debes seleccionar MVP para cerrar totalmente el partido')
      return
    }
    if (finishingMatch) return

    setFinishingMatch(true)
    try {
      const finishResponse = await apiService.setLiveTimer('finish')
      if (!finishResponse.ok) {
        applyActionFeedback(false, '', finishResponse.message)
        return
      }

      const saved = await markCurrentMatchAsPlayed()
      if (!saved) {
        applyActionFeedback(false, '', 'Partido finalizado, pero no se pudo guardar historial completo')
        return
      }

      setShowMvpModal(false)
      applyActionFeedback(true, 'Partido finalizado y guardado con MVP', '')
    } finally {
      setFinishingMatch(false)
    }
  }

  const saveSettings = async () => {
    if (savingSettings) return

    if (!selectedLeague || !activeMatchCategoryId) {
      applyActionFeedback(false, '', 'Selecciona liga y categoría para guardar configuración')
      return
    }

    setSavingSettings(true)

    try {
      const sanitizedRules = {
        playersOnField: clampInt(settingsDraft.playersOnField, 5, 11, 11),
        matchMinutes: clampInt(settingsDraft.matchMinutes, 20, 120, 90),
        breakMinutes: clampInt(settingsDraft.breakMinutes, 0, 30, 15),
        allowDraws: competitionRulesDraft.allowDraws,
        pointsWin: clampInt(competitionRulesDraft.pointsWin, 0, 10, 3),
        pointsDraw: clampInt(competitionRulesDraft.pointsDraw, 0, 10, 1),
        pointsLoss: clampInt(competitionRulesDraft.pointsLoss, 0, 10, 0),
        courtsCount: clampInt(competitionRulesDraft.courtsCount, 1, 20, 1),
        maxRegisteredPlayers: clampInt(competitionRulesDraft.maxRegisteredPlayers, 5, 60, 25),
        resolveDrawByPenalties: competitionRulesDraft.resolveDrawByPenalties,
        playoffQualifiedTeams: clampInt(competitionRulesDraft.playoffQualifiedTeams, 2, 32, 8),
        playoffHomeAway: competitionRulesDraft.finalStageFinalTwoLegged,
        finalStageRoundOf16Enabled: competitionRulesDraft.finalStageRoundOf16Enabled,
        finalStageRoundOf8Enabled: competitionRulesDraft.finalStageRoundOf8Enabled,
        finalStageQuarterFinalsEnabled: competitionRulesDraft.finalStageQuarterFinalsEnabled,
        finalStageSemiFinalsEnabled: competitionRulesDraft.finalStageSemiFinalsEnabled,
        finalStageFinalEnabled: competitionRulesDraft.finalStageFinalEnabled,
        finalStageRoundOf16TwoLegged: competitionRulesDraft.finalStageRoundOf16TwoLegged,
        finalStageRoundOf8TwoLegged: competitionRulesDraft.finalStageRoundOf8TwoLegged,
        finalStageQuarterFinalsTwoLegged: competitionRulesDraft.finalStageQuarterFinalsTwoLegged,
        finalStageSemiFinalsTwoLegged: competitionRulesDraft.finalStageSemiFinalsTwoLegged,
        finalStageFinalTwoLegged: competitionRulesDraft.finalStageFinalTwoLegged,
        finalStageTwoLegged: competitionRulesDraft.finalStageFinalTwoLegged,
        doubleRoundRobin: competitionRulesDraft.doubleRoundRobin,
        regularSeasonRounds: clampInt(competitionRulesDraft.regularSeasonRounds, 1, 60, 9),
      }

      const rulesResponse = await apiService.updateCategoryRules(selectedLeague.id, activeMatchCategoryId, sanitizedRules)
      if (!rulesResponse.ok) {
        applyActionFeedback(false, '', rulesResponse.message || 'No se pudo guardar configuración')
        return
      }

      setLeagues((current) =>
        current.map((league) => (league.id === rulesResponse.data.id ? rulesResponse.data : league)),
      )

      const refreshedCategoryRules = rulesResponse.data.categories.find((item) => item.id === activeMatchCategoryId)?.rules
      if (refreshedCategoryRules) {
        setSettingsDraft((current) => ({
          ...current,
          playersOnField: refreshedCategoryRules.playersOnField ?? 11,
          matchMinutes: refreshedCategoryRules.matchMinutes ?? 90,
          breakMinutes: refreshedCategoryRules.breakMinutes ?? 15,
        }))

        setCompetitionRulesDraft((current) => {
          const baseFinalTwoLegged =
            refreshedCategoryRules.finalStageFinalTwoLegged
            ?? refreshedCategoryRules.finalStageTwoLegged
            ?? refreshedCategoryRules.playoffHomeAway
            ?? false

          return {
            ...current,
            allowDraws: refreshedCategoryRules.allowDraws ?? true,
            pointsWin: refreshedCategoryRules.pointsWin ?? 3,
            pointsDraw: refreshedCategoryRules.pointsDraw ?? 1,
            pointsLoss: refreshedCategoryRules.pointsLoss ?? 0,
            courtsCount: refreshedCategoryRules.courtsCount ?? 1,
            maxRegisteredPlayers: refreshedCategoryRules.maxRegisteredPlayers ?? 25,
            resolveDrawByPenalties: refreshedCategoryRules.resolveDrawByPenalties ?? false,
            playoffQualifiedTeams: refreshedCategoryRules.playoffQualifiedTeams ?? 8,
            finalStageRoundOf16Enabled:
              refreshedCategoryRules.finalStageRoundOf16Enabled ?? false,
            finalStageRoundOf8Enabled: refreshedCategoryRules.finalStageRoundOf8Enabled ?? false,
            finalStageQuarterFinalsEnabled:
              refreshedCategoryRules.finalStageQuarterFinalsEnabled ?? true,
            finalStageSemiFinalsEnabled: refreshedCategoryRules.finalStageSemiFinalsEnabled ?? true,
            finalStageFinalEnabled: refreshedCategoryRules.finalStageFinalEnabled ?? true,
            finalStageTwoLegged: baseFinalTwoLegged,
            finalStageRoundOf16TwoLegged:
              refreshedCategoryRules.finalStageRoundOf16TwoLegged ?? false,
            finalStageRoundOf8TwoLegged:
              refreshedCategoryRules.finalStageRoundOf8TwoLegged ?? false,
            finalStageQuarterFinalsTwoLegged:
              refreshedCategoryRules.finalStageQuarterFinalsTwoLegged ?? false,
            finalStageSemiFinalsTwoLegged:
              refreshedCategoryRules.finalStageSemiFinalsTwoLegged ?? false,
            finalStageFinalTwoLegged:
              refreshedCategoryRules.finalStageFinalTwoLegged
              ?? refreshedCategoryRules.finalStageTwoLegged
              ?? refreshedCategoryRules.playoffHomeAway
              ?? false,
            doubleRoundRobin: refreshedCategoryRules.doubleRoundRobin ?? false,
            regularSeasonRounds: refreshedCategoryRules.regularSeasonRounds ?? 9,
          }
        })
      }

      if (liveMatch) {
        const liveResponse = await apiService.updateLiveSettings(settingsDraft)
        if (!liveResponse.ok) {
          applyActionFeedback(false, '', liveResponse.message || 'No se pudo actualizar settings live')
          return
        }
      }

      await loadLeagues()
      applyActionFeedback(true, 'Reglas parametrizadas guardadas', '')
    } finally {
      setSavingSettings(false)
    }
  }

  const sendEvent = async (eventType: 'shot' | 'goal' | 'penalty_goal' | 'penalty_miss' | 'yellow' | 'red' | 'assist') => {
    if (!selectedTeam) return
    if (!canRegisterLiveEvents) {
      applyActionFeedback(false, '', 'Debes iniciar el partido para registrar eventos')
      return
    }
    if (liveIsFinished) {
      applyActionFeedback(false, '', 'Partido finalizado: no se pueden registrar eventos')
      return
    }

    const playerId = selectedPlayerId || null
    const resolved = resolveEventTypeForCard(selectedTeam.id, playerId, eventType)
    const response = await apiService.registerLiveEvent(selectedTeam.id, resolved.type, playerId)
    const feedbackMap: Record<string, string> = {
      shot: 'Remate',
      goal: 'Gol',
      penalty_goal: 'Gol de penal',
      penalty_miss: 'Penal fallado',
      assist: 'Asistencia',
      yellow: 'TA',
      red: 'TR',
      double_yellow: 'Doble amarilla (TR)',
    }
    applyActionFeedback(response.ok, `${feedbackMap[resolved.type] ?? resolved.type} registrado`, response.ok ? '' : response.message)
  }

  const sendEventForStarter = async (
    teamId: string,
    playerId: string,
    eventType: 'goal' | 'penalty_goal' | 'penalty_miss' | 'assist' | 'yellow' | 'red',
  ) => {
    if (!canRegisterLiveEvents) {
      applyActionFeedback(false, '', 'Debes iniciar el partido para registrar eventos')
      return
    }
    if (liveIsFinished) {
      applyActionFeedback(false, '', 'Partido finalizado: no se pueden registrar eventos')
      return
    }

    const resolved = resolveEventTypeForCard(teamId, playerId, eventType)
    const response = await apiService.registerLiveEvent(teamId, resolved.type, playerId)
    const labels: Record<string, string> = {
      shot: 'Remate',
      goal: 'Gol',
      penalty_goal: 'Gol de penal',
      penalty_miss: 'Penal fallado',
      assist: 'Asistencia',
      yellow: 'TA',
      red: 'TR',
      double_yellow: 'Doble amarilla (TR)',
      substitution: 'Cambio',
    }
    applyActionFeedback(response.ok, `${labels[resolved.type] ?? resolved.type} registrado`, response.ok ? '' : response.message)
  }

  const sendStaffCardEvent = async (staffRole: LiveStaffRole, eventType: 'staff_yellow' | 'staff_red') => {
    if (!selectedTeam) return
    if (!canRegisterLiveEvents) {
      applyActionFeedback(false, '', 'Debes iniciar el partido para registrar eventos')
      return
    }
    if (liveIsFinished) {
      applyActionFeedback(false, '', 'Partido finalizado: no se pueden registrar eventos')
      return
    }

    const memberName = selectedTeam.technicalStaff?.[staffRole]?.name?.trim()
    if (!memberName) {
      applyActionFeedback(false, '', staffRole === 'director' ? 'Este equipo no tiene DT registrado' : 'Este equipo no tiene AT registrado')
      return
    }

    if (selectedTeam.staffDiscipline?.[staffRole]?.sentOff) {
      applyActionFeedback(false, '', `${staffRoleLabel(staffRole)} expulsado: no puede registrar más eventos`)
      return
    }

    const response = await apiService.registerLiveEvent(selectedTeam.id, eventType, null, staffRole)
    const cardLabel = eventType === 'staff_yellow' ? 'TA' : 'TR'
    applyActionFeedback(response.ok, `${cardLabel} para ${staffRoleLabel(staffRole)} registrada`, response.ok ? '' : response.message)
  }

  const substitutionOutOptions = useMemo(() => {
    if (!selectedTeam) return [] as string[]
    return lineupStarters.filter((id) => !selectedTeam.redCarded.includes(id))
  }, [lineupStarters, selectedTeam])

  const substitutionInOptions = useMemo(() => {
    if (!selectedTeam) return [] as string[]
    return lineupSubstitutes.filter((id) => !selectedTeam.redCarded.includes(id) && !selectedTeamSubstitutedOut.has(id))
  }, [lineupSubstitutes, selectedTeam, selectedTeamSubstitutedOut])

  const eventEligiblePlayerIds = useMemo(() => {
    if (!selectedTeam) return [] as string[]
    return lineupStarters.filter((id) => !selectedTeam.redCarded.includes(id))
  }, [lineupStarters, selectedTeam])

  const registerSubstitution = async () => {
    if (!selectedTeam) return
    if (!canRegisterLiveEvents) {
      applyActionFeedback(false, '', 'Debes iniciar el partido para registrar cambios')
      return
    }
    if (liveIsFinished) {
      applyActionFeedback(false, '', 'Partido finalizado: no se pueden registrar eventos')
      return
    }

    const outgoingPlayerId = substitutionOutPlayerId
    const incomingPlayerId = substitutionInPlayerId
    if (!outgoingPlayerId || !incomingPlayerId) {
      applyActionFeedback(false, '', 'Selecciona jugador que sale y jugador que entra')
      return
    }
    if (outgoingPlayerId === incomingPlayerId) {
      applyActionFeedback(false, '', 'Los jugadores del cambio deben ser distintos')
      return
    }
    if (!lineupStarters.includes(outgoingPlayerId)) {
      applyActionFeedback(false, '', 'El jugador que sale debe estar en titulares')
      return
    }
    if (!lineupSubstitutes.includes(incomingPlayerId)) {
      applyActionFeedback(false, '', 'El jugador que entra debe estar en suplentes')
      return
    }
    if (selectedTeamSubstitutedOut.has(incomingPlayerId)) {
      applyActionFeedback(false, '', 'Este jugador ya salió por cambio y no puede reingresar')
      return
    }
    if (selectedTeam.redCarded.includes(outgoingPlayerId) || selectedTeam.redCarded.includes(incomingPlayerId)) {
      applyActionFeedback(false, '', 'No se permite cambio con un jugador expulsado (TR o doble amarilla)')
      return
    }
    if (!substitutionOutOptions.includes(outgoingPlayerId) || !substitutionInOptions.includes(incomingPlayerId)) {
      applyActionFeedback(false, '', 'El cambio seleccionado no es válido para el estado actual de cancha')
      return
    }

    const nextStarters = lineupStarters.map((id) => (id === outgoingPlayerId ? incomingPlayerId : id))
    const nextSubstitutes = lineupSubstitutes.filter((id) => id !== incomingPlayerId && id !== outgoingPlayerId)

    const lineupResponse = await apiService.saveLineup(
      selectedTeam.id,
      nextStarters,
      nextSubstitutes,
      selectedFormationKey || undefined,
    )
    if (!lineupResponse.ok) {
      applyActionFeedback(false, '', lineupResponse.message)
      return
    }

    const eventResponse = await apiService.registerLiveEvent(selectedTeam.id, 'substitution', outgoingPlayerId, undefined, incomingPlayerId)
    if (!eventResponse.ok) {
      applyActionFeedback(false, '', eventResponse.message)
      return
    }

    setLineupStarters(nextStarters)
    setLineupSubstitutes(nextSubstitutes)
    setSubstitutionOutPlayerId('')
    setSubstitutionInPlayerId('')
    setSubstitutionVisualByTeam((current) => {
      const teamEntry = current[selectedTeam.id] ?? { outPlayerIds: [], inPlayerIds: [] }
      return {
        ...current,
        [selectedTeam.id]: {
          outPlayerIds: Array.from(new Set([...teamEntry.outPlayerIds, outgoingPlayerId])),
          inPlayerIds: Array.from(new Set([...teamEntry.inPlayerIds, incomingPlayerId])),
        },
      }
    })
    setSubstitutionTimelineByTeam((current) => {
      const teamTimeline = current[selectedTeam.id] ?? []
      const timelineEntry: SubstitutionTimelineEntry = {
        id: `${Date.now()}-${outgoingPlayerId}-${incomingPlayerId}`,
        clock: formatTimer(liveElapsedSeconds),
        minute: liveCurrentMinute,
        outPlayerId: outgoingPlayerId,
        inPlayerId: incomingPlayerId,
      }

      return {
        ...current,
        [selectedTeam.id]: [...teamTimeline, timelineEntry].slice(-30),
      }
    })
    applyActionFeedback(true, 'Cambio registrado correctamente', '')
  }

  const savePendingMatchDate = () => {
    if (!selectedPendingMatch || !fixtureDateDraft || !selectedLeague || !activeMatchCategoryId) return
    const normalizedVenue = fixtureVenueDraft.trim()
    const shouldPersistVenue = selectedCategoryCourtsCount > 1
    queueMicrotask(async () => {
      const response = await apiService.saveFixtureSchedule(selectedLeague.id, selectedPendingMatch.id, {
        categoryId: activeMatchCategoryId,
        round: selectedPendingMatch.round,
        scheduledAt: fixtureDateDraft,
        ...(shouldPersistVenue && normalizedVenue ? { venue: normalizedVenue } : {}),
      })

      if (!response.ok) {
        applyActionFeedback(false, '', response.message)
        return
      }

      setFixtureDatesMap((current) => ({
        ...current,
        [selectedPendingMatch.id]: response.data.scheduledAt,
      }))
      setFixtureVenuesMap((current) => {
        const next = { ...current }
        if (response.data.venue) {
          next[selectedPendingMatch.id] = response.data.venue
        } else {
          delete next[selectedPendingMatch.id]
        }
        return next
      })
      setFixtureScheduleEntries((current) =>
        current.map((entry) =>
          entry.matchId === selectedPendingMatch.id
            ? { ...entry, scheduledAt: response.data.scheduledAt, ...(response.data.venue ? { venue: response.data.venue } : {}) }
            : entry,
        ),
      )
      applyActionFeedback(true, 'Fecha del partido guardada', '')
    })
  }

  const onDragPlayer = (event: React.DragEvent<HTMLElement>, playerId: string) => {
    event.dataTransfer.setData('text/player-id', playerId)
    event.dataTransfer.effectAllowed = 'move'
  }

  const placePlayerInStarterSlot = (playerId: string, slotIndex: number) => {
    if (!selectedTeam || liveIsFinished) return
    if (selectedTeam.redCarded.includes(playerId)) return
    if (!selectedTeam.players.some((player) => player.id === playerId)) return
    if (slotIndex < 0 || slotIndex >= starterSlots.length) return

    const nextSlots = [...starterSlots]
    const fromIndex = nextSlots.findIndex((id) => id === playerId)
    const occupiedPlayerId = nextSlots[slotIndex]

    if (fromIndex === slotIndex) return

    if (fromIndex >= 0) {
      nextSlots[fromIndex] = ''
    }

    nextSlots[slotIndex] = playerId

    if (occupiedPlayerId && fromIndex >= 0 && fromIndex !== slotIndex) {
      nextSlots[fromIndex] = occupiedPlayerId
    }

    applySlotsToLineup(nextSlots)
  }

  const removeFromStarterSlots = (playerId: string) => {
    if (liveIsFinished) return
    const currentIndex = starterSlots.findIndex((id) => id === playerId)
    if (currentIndex === -1) return
    const nextSlots = [...starterSlots]
    nextSlots[currentIndex] = ''
    applySlotsToLineup(nextSlots)
  }

  const onDropToStarterSlot = (event: React.DragEvent<HTMLDivElement>, slotIndex: number) => {
    if (liveIsFinished) return
    event.preventDefault()
    const playerId = event.dataTransfer.getData('text/player-id')
    if (!playerId) return
    placePlayerInStarterSlot(playerId, slotIndex)
  }

  const onDropToBench = (event: React.DragEvent<HTMLDivElement>) => {
    if (liveIsFinished) return
    event.preventDefault()
    const playerId = event.dataTransfer.getData('text/player-id')
    if (!playerId) return
    removeFromStarterSlots(playerId)
  }

  const generateFinalBracketFirstRound = async () => {
    if (!selectedLeague || !activeMatchCategoryId) {
      applyActionFeedback(false, '', 'Selecciona liga y categoría para generar fase final')
      return
    }

    if (finalFirstRoundPairings.length === 0) {
      applyActionFeedback(false, '', 'No hay emparejamientos válidos en el cuadro final')
      return
    }

    const firstRoundTwoLegged = finalStageTwoLeggedByOrder[0] ?? false

    let hasError = false
    for (let index = 0; index < finalFirstRoundPairings.length; index += 1) {
      const pairing = finalFirstRoundPairings[index]
      if (!pairing) continue

      const baseDate = new Date()
      baseDate.setHours(18, 0, 0, 0)
      const scheduledAt = fixtureDatesMap[pairing.matchId] || new Date(baseDate.getTime() + index * 2 * 60 * 60 * 1000).toISOString()

      const saveHomeAway = await apiService.saveFixtureSchedule(selectedLeague.id, pairing.matchId, {
        categoryId: activeMatchCategoryId,
        round: pairing.round,
        scheduledAt,
        ...(fixtureVenuesMap[pairing.matchId] ? { venue: fixtureVenuesMap[pairing.matchId] } : {}),
      })

      if (!saveHomeAway.ok) {
        hasError = true
        applyActionFeedback(false, '', saveHomeAway.message)
        break
      }

      if (firstRoundTwoLegged) {
        const returnRound = pairing.round + 1
        const returnMatchId = `manual__${returnRound}__${pairing.awayTeamId}__${pairing.homeTeamId}`
        const returnDate = new Date(new Date(scheduledAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()

        const saveReturn = await apiService.saveFixtureSchedule(selectedLeague.id, returnMatchId, {
          categoryId: activeMatchCategoryId,
          round: returnRound,
          scheduledAt: returnDate,
        })

        if (!saveReturn.ok) {
          hasError = true
          applyActionFeedback(false, '', saveReturn.message)
          break
        }
      }
    }

    if (hasError) return

    await loadLeagues()
    applyActionFeedback(true, 'Cuadro de fase final generado y programado', '')
  }

  const removeFromLineup = (playerId: string) => {
    if (liveIsFinished) return
    removeFromStarterSlots(playerId)
  }

  const teamsById = useMemo(() => {
    return new Map(leagueTeams.map((team) => [team.id, team]))
  }, [leagueTeams])

  const scheduledMatches = useMemo<ScheduledMatchItem[]>(() => {
    if (fixtureScheduleEntries.length === 0) return []

    const generatedMatchMap = new Map<string, { homeTeamId: string; awayTeamId: string }>()
    leagueFixture?.rounds.forEach((round) => {
      round.matches.forEach((match, index) => {
        if (match.hasBye || !match.awayTeamId) return
        const generatedId = `${round.round}-${index}-${match.homeTeamId}-${match.awayTeamId}`
        generatedMatchMap.set(generatedId, {
          homeTeamId: match.homeTeamId,
          awayTeamId: match.awayTeamId,
        })
      })
    })

    return fixtureScheduleEntries
      .map((entry) => {
        const generated = generatedMatchMap.get(entry.matchId)
        if (generated) {
          return {
            id: entry.matchId,
            round: entry.round,
            homeTeamId: generated.homeTeamId,
            awayTeamId: generated.awayTeamId,
            scheduledAt: entry.scheduledAt,
            ...(entry.venue ? { venue: entry.venue } : {}),
          }
        }

        const manual = parseManualMatchId(entry.matchId, entry.round)
        if (!manual) return null

        return {
          id: entry.matchId,
          round: entry.round,
          homeTeamId: manual.homeTeamId,
          awayTeamId: manual.awayTeamId,
          scheduledAt: entry.scheduledAt,
          ...(entry.venue ? { venue: entry.venue } : {}),
        }
      })
      .filter((item): item is ScheduledMatchItem => Boolean(item))
      .sort((left, right) => {
        if (left.round !== right.round) return left.round - right.round
        const leftTime = left.scheduledAt ? new Date(left.scheduledAt).getTime() : Number.POSITIVE_INFINITY
        const rightTime = right.scheduledAt ? new Date(right.scheduledAt).getTime() : Number.POSITIVE_INFINITY
        return leftTime - rightTime
      })
  }, [fixtureScheduleEntries, leagueFixture])

  const pendingMatches = useMemo(
    () => scheduledMatches.filter((match) => !playedMatchesMap[match.id]),
    [playedMatchesMap, scheduledMatches],
  )

  const playedMatches = useMemo(
    () => scheduledMatches.filter((match) => Boolean(playedMatchesMap[match.id])),
    [playedMatchesMap, scheduledMatches],
  )

  const selectedPendingMatch = pendingMatches.find((match) => match.id === selectedPendingMatchId) ?? null

  const selectedPendingHomeTeam = selectedPendingMatch
    ? teamsById.get(selectedPendingMatch.homeTeamId) ?? null
    : null

  const selectedPendingAwayTeam = selectedPendingMatch
    ? teamsById.get(selectedPendingMatch.awayTeamId) ?? null
    : null

  const finalStageRoundsInFixture = useMemo(
    () => Array.from(new Set(scheduledMatches.filter((match) => match.round > competitionRulesDraft.regularSeasonRounds).map((match) => match.round))).sort((a, b) => a - b),
    [competitionRulesDraft.regularSeasonRounds, scheduledMatches],
  )

  const hasFinalRoundTabs = finalStageRoundsInFixture.length > 0

  useEffect(() => {
    if (!hasFinalRoundTabs && matchesTab === 'finales') {
      setMatchesTab('regular')
    }
  }, [hasFinalRoundTabs, matchesTab])

  const pendingMatchesScoped = useMemo(
    () =>
      pendingMatches.filter((match) =>
        matchesTab === 'finales'
          ? match.round > competitionRulesDraft.regularSeasonRounds
          : match.round <= competitionRulesDraft.regularSeasonRounds,
      ),
    [competitionRulesDraft.regularSeasonRounds, matchesTab, pendingMatches],
  )

  const playedMatchesScoped = useMemo(
    () =>
      playedMatches.filter((match) =>
        matchesTab === 'finales'
          ? match.round > competitionRulesDraft.regularSeasonRounds
          : match.round <= competitionRulesDraft.regularSeasonRounds,
      ),
    [competitionRulesDraft.regularSeasonRounds, matchesTab, playedMatches],
  )

  const pendingRoundsScoped = useMemo(() => {
    return Array.from(new Set(pendingMatchesScoped.map((match) => match.round))).sort((a, b) => a - b)
  }, [pendingMatchesScoped])

  const activePendingRoundScoped =
    selectedPendingRound && pendingRoundsScoped.includes(Number(selectedPendingRound))
      ? Number(selectedPendingRound)
      : (pendingRoundsScoped[0] ?? 0)

  const pendingMatchesByRoundScoped = useMemo(
    () => pendingMatchesScoped.filter((match) => match.round === activePendingRoundScoped),
    [activePendingRoundScoped, pendingMatchesScoped],
  )

  const selectedPlayedMatchScoped = playedMatchesScoped.find((match) => match.id === selectedPlayedMatchId) ?? null

  const selectedPlayedStatsScoped = selectedPlayedMatchScoped ? playedMatchesMap[selectedPlayedMatchScoped.id] ?? null : null

  const selectedPlayedHomeTeamRoster = selectedPlayedMatchScoped
    ? teamsById.get(selectedPlayedMatchScoped.homeTeamId) ?? null
    : null

  const selectedPlayedAwayTeamRoster = selectedPlayedMatchScoped
    ? teamsById.get(selectedPlayedMatchScoped.awayTeamId) ?? null
    : null

  const selectedPlayedHomeLineupVisual = useMemo(() => {
    if (!selectedPlayedStatsScoped || !selectedPlayedHomeTeamRoster) return [] as Array<{ id: string; name: string; number: number; position?: string }>
    const starterIds = selectedPlayedStatsScoped.homeLineup?.starters ?? []
    return starterIds
      .map((playerId) => selectedPlayedHomeTeamRoster.players.find((player) => player.id === playerId))
      .filter((player): player is RegisteredTeam['players'][number] => Boolean(player))
      .map((player) => ({ id: player.id, name: player.name, number: player.number, position: player.position }))
  }, [selectedPlayedHomeTeamRoster, selectedPlayedStatsScoped])

  const selectedPlayedAwayLineupVisual = useMemo(() => {
    if (!selectedPlayedStatsScoped || !selectedPlayedAwayTeamRoster) return [] as Array<{ id: string; name: string; number: number; position?: string }>
    const starterIds = selectedPlayedStatsScoped.awayLineup?.starters ?? []
    return starterIds
      .map((playerId) => selectedPlayedAwayTeamRoster.players.find((player) => player.id === playerId))
      .filter((player): player is RegisteredTeam['players'][number] => Boolean(player))
      .map((player) => ({ id: player.id, name: player.name, number: player.number, position: player.position }))
  }, [selectedPlayedAwayTeamRoster, selectedPlayedStatsScoped])

  const selectedPlayedHomeVisualLines = useMemo(
    () => buildVisualLines(selectedPlayedHomeLineupVisual, selectedPlayedStatsScoped?.homeLineup?.formationKey).slice().reverse(),
    [selectedPlayedHomeLineupVisual, selectedPlayedStatsScoped?.homeLineup?.formationKey],
  )

  const selectedPlayedAwayVisualLines = useMemo(
    () => buildVisualLines(selectedPlayedAwayLineupVisual, selectedPlayedStatsScoped?.awayLineup?.formationKey),
    [selectedPlayedAwayLineupVisual, selectedPlayedStatsScoped?.awayLineup?.formationKey],
  )

  const selectedPlayedHistoryIndicators = useMemo(() => {
    const map = new Map<string, { goals: number; penaltyMisses: number; yellows: number; reds: number; substitutedOut: boolean; substitutedIn: boolean }>()
    if (!selectedPlayedStatsScoped) return map

    const homeName = normalizeLabel(selectedPlayedStatsScoped.homeTeamName)
    const awayName = normalizeLabel(selectedPlayedStatsScoped.awayTeamName)

    const resolvePlayerId = (teamName: string, playerName: string) => {
      const normalizedTeam = normalizeLabel(teamName)
      const normalizedPlayer = normalizeLabel(playerName)
      const rosterPlayers = normalizedTeam === homeName
        ? (selectedPlayedHomeTeamRoster?.players ?? [])
        : normalizedTeam === awayName
          ? (selectedPlayedAwayTeamRoster?.players ?? [])
          : []

      if (rosterPlayers.length === 0) return ''
      const player = rosterPlayers.find((item) => normalizeLabel(item.name) === normalizedPlayer)
      return player?.id ?? ''
    }

    selectedPlayedStatsScoped.events.forEach((event) => {
      const playerId = resolvePlayerId(event.teamName, event.playerName)
      if (!playerId) return

      const current = map.get(playerId) ?? {
        goals: 0,
        penaltyMisses: 0,
        yellows: 0,
        reds: 0,
        substitutedOut: false,
        substitutedIn: false,
      }

      if (event.type === 'goal' || event.type === 'penalty_goal') current.goals += 1
      if (event.type === 'penalty_miss') current.penaltyMisses += 1
      if (event.type === 'yellow') current.yellows += 1
      if (event.type === 'red') current.reds += 1
      if (event.type === 'double_yellow') {
        current.yellows += 1
        current.reds += 1
      }
      if (event.type === 'substitution') current.substitutedOut = true

      map.set(playerId, current)

      if (event.type === 'substitution' && event.substitutionInPlayerName) {
        const inPlayerId = resolvePlayerId(event.teamName, event.substitutionInPlayerName)
        if (!inPlayerId) return

        const inCurrent = map.get(inPlayerId) ?? {
          goals: 0,
          penaltyMisses: 0,
          yellows: 0,
          reds: 0,
          substitutedOut: false,
          substitutedIn: false,
        }
        inCurrent.substitutedIn = true
        map.set(inPlayerId, inCurrent)
      }
    })

    return map
  }, [selectedPlayedAwayTeamRoster, selectedPlayedHomeTeamRoster, selectedPlayedStatsScoped])

  const selectedPendingMatchScoped = pendingMatchesScoped.find((match) => match.id === selectedPendingMatchId) ?? null

  const selectedPendingHomeTeamScoped = selectedPendingMatchScoped
    ? teamsById.get(selectedPendingMatchScoped.homeTeamId) ?? null
    : null

  const selectedPendingAwayTeamScoped = selectedPendingMatchScoped
    ? teamsById.get(selectedPendingMatchScoped.awayTeamId) ?? null
    : null

  const liveLoadedForSelectedPendingScoped =
    Boolean(liveMatch && selectedPendingMatchScoped) &&
    ((liveMatch?.homeTeam.id === selectedPendingMatchScoped?.homeTeamId && liveMatch?.awayTeam.id === selectedPendingMatchScoped?.awayTeamId) ||
      (liveMatch?.homeTeam.id === selectedPendingMatchScoped?.awayTeamId && liveMatch?.awayTeam.id === selectedPendingMatchScoped?.homeTeamId))

  const configuredStageTeamCount = useMemo(() => {
    if (competitionRulesDraft.finalStageRoundOf16Enabled) return 32
    if (competitionRulesDraft.finalStageRoundOf8Enabled) return 16
    if (competitionRulesDraft.finalStageQuarterFinalsEnabled) return 8
    if (competitionRulesDraft.finalStageSemiFinalsEnabled) return 4
    if (competitionRulesDraft.finalStageFinalEnabled) return 2
    return 0
  }, [
    competitionRulesDraft.finalStageFinalEnabled,
    competitionRulesDraft.finalStageQuarterFinalsEnabled,
    competitionRulesDraft.finalStageRoundOf16Enabled,
    competitionRulesDraft.finalStageRoundOf8Enabled,
    competitionRulesDraft.finalStageSemiFinalsEnabled,
  ])

  const finalStageTwoLeggedByOrder = useMemo(() => {
    return [
      competitionRulesDraft.finalStageRoundOf16Enabled ? competitionRulesDraft.finalStageRoundOf16TwoLegged : null,
      competitionRulesDraft.finalStageRoundOf8Enabled ? competitionRulesDraft.finalStageRoundOf8TwoLegged : null,
      competitionRulesDraft.finalStageQuarterFinalsEnabled ? competitionRulesDraft.finalStageQuarterFinalsTwoLegged : null,
      competitionRulesDraft.finalStageSemiFinalsEnabled ? competitionRulesDraft.finalStageSemiFinalsTwoLegged : null,
      competitionRulesDraft.finalStageFinalEnabled ? competitionRulesDraft.finalStageFinalTwoLegged : null,
    ].filter((value): value is boolean => value !== null)
  }, [
    competitionRulesDraft.finalStageFinalEnabled,
    competitionRulesDraft.finalStageFinalTwoLegged,
    competitionRulesDraft.finalStageQuarterFinalsEnabled,
    competitionRulesDraft.finalStageQuarterFinalsTwoLegged,
    competitionRulesDraft.finalStageRoundOf16Enabled,
    competitionRulesDraft.finalStageRoundOf16TwoLegged,
    competitionRulesDraft.finalStageRoundOf8Enabled,
    competitionRulesDraft.finalStageRoundOf8TwoLegged,
    competitionRulesDraft.finalStageSemiFinalsEnabled,
    competitionRulesDraft.finalStageSemiFinalsTwoLegged,
  ])

  const finalQualifiedTeams = useMemo(() => {
    const pointsWin = competitionRulesDraft.pointsWin ?? 3
    const pointsDraw = competitionRulesDraft.pointsDraw ?? 1
    const pointsLoss = competitionRulesDraft.pointsLoss ?? 0
    const resolveDrawByPenalties = competitionRulesDraft.resolveDrawByPenalties ?? false
    const table = new Map<string, { teamId: string; teamName: string; pts: number; dg: number; gf: number }>()

    const ensure = (teamId: string) => {
      const existing = table.get(teamId)
      if (existing) return existing
      const created = {
        teamId,
        teamName: teamsById.get(teamId)?.name ?? 'Equipo',
        pts: 0,
        dg: 0,
        gf: 0,
      }
      table.set(teamId, created)
      return created
    }

    leagueTeams.forEach((team) => {
      ensure(team.id)
    })

    playedMatches.forEach((match) => {
      if (match.round > competitionRulesDraft.regularSeasonRounds) return

      const record = playedMatchesMap[match.id]
      if (!record) return

      const homeRow = ensure(match.homeTeamId)
      const awayRow = ensure(match.awayTeamId)
      const homeGoals = record.homeStats.goals
      const awayGoals = record.awayStats.goals

      homeRow.gf += homeGoals
      awayRow.gf += awayGoals
      homeRow.dg += homeGoals - awayGoals
      awayRow.dg += awayGoals - homeGoals

      if (homeGoals > awayGoals) {
        homeRow.pts += pointsWin
        awayRow.pts += pointsLoss
      } else if (awayGoals > homeGoals) {
        awayRow.pts += pointsWin
        homeRow.pts += pointsLoss
      } else if (resolveDrawByPenalties && record.penaltyShootout) {
        if (record.penaltyShootout.home > record.penaltyShootout.away) {
          homeRow.pts += pointsWin
          awayRow.pts += pointsLoss
        } else {
          awayRow.pts += pointsWin
          homeRow.pts += pointsLoss
        }
      } else {
        homeRow.pts += pointsDraw
        awayRow.pts += pointsDraw
      }
    })

    const ordered = Array.from(table.values()).sort(
      (a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf || a.teamName.localeCompare(b.teamName, 'es', { sensitivity: 'base' }),
    )

    if (ordered.length < 2) return [] as typeof ordered

    const requested = Math.max(2, competitionRulesDraft.playoffQualifiedTeams)
    const allowed = Math.min(requested, ordered.length)
    const powerOfTwo = 2 ** Math.floor(Math.log2(Math.max(2, allowed)))

    let target = powerOfTwo
    if (configuredStageTeamCount > 0) {
      target = Math.min(configuredStageTeamCount, powerOfTwo)
    }

    return ordered.slice(0, Math.max(2, target))
  }, [
    competitionRulesDraft.playoffQualifiedTeams,
    competitionRulesDraft.pointsDraw,
    competitionRulesDraft.pointsLoss,
    competitionRulesDraft.pointsWin,
    competitionRulesDraft.regularSeasonRounds,
    competitionRulesDraft.resolveDrawByPenalties,
    configuredStageTeamCount,
    leagueTeams,
    playedMatches,
    playedMatchesMap,
    teamsById,
  ])

  useEffect(() => {
    if (finalQualifiedTeams.length < 2) {
      setFinalsLeftSeedTeamIds([])
      setFinalsRightSeedTeamIds([])
      return
    }

    const half = finalQualifiedTeams.length / 2
    const left = finalQualifiedTeams.slice(0, half).map((item) => item.teamId)
    const right = finalQualifiedTeams
      .slice()
      .reverse()
      .slice(0, half)
      .map((item) => item.teamId)

    setFinalsLeftSeedTeamIds(left)
    setFinalsRightSeedTeamIds(right)
  }, [activeMatchCategoryId, finalQualifiedTeams, selectedLeague?.id])

  const firstFinalRoundNumber = competitionRulesDraft.regularSeasonRounds + 1

  const finalFirstRoundPairings = useMemo(() => {
    const size = Math.min(finalsLeftSeedTeamIds.length, finalsRightSeedTeamIds.length)
    return Array.from({ length: size }, (_, index) => ({
      order: index + 1,
      homeTeamId: finalsLeftSeedTeamIds[index] ?? '',
      awayTeamId: finalsRightSeedTeamIds[index] ?? '',
      round: firstFinalRoundNumber,
      matchId: `manual__${firstFinalRoundNumber}__${finalsLeftSeedTeamIds[index] ?? ''}__${finalsRightSeedTeamIds[index] ?? ''}`,
    })).filter((item) => item.homeTeamId && item.awayTeamId)
  }, [finalsLeftSeedTeamIds, finalsRightSeedTeamIds, firstFinalRoundNumber])

  const finalMatchesByRound = useMemo(() => {
    const map = new Map<number, ScheduledMatchItem[]>()
    scheduledMatches
      .filter((match) => match.round > competitionRulesDraft.regularSeasonRounds)
      .forEach((match) => {
        const current = map.get(match.round) ?? []
        current.push(match)
        map.set(match.round, current)
      })

    map.forEach((matches, round) => {
      map.set(
        round,
        [...matches].sort((a, b) => {
          const aDate = fixtureDatesMap[a.id] ?? a.scheduledAt ?? ''
          const bDate = fixtureDatesMap[b.id] ?? b.scheduledAt ?? ''
          return aDate.localeCompare(bDate)
        }),
      )
    })

    return map
  }, [competitionRulesDraft.regularSeasonRounds, fixtureDatesMap, scheduledMatches])

  const finalBracketStages = useMemo(() => {
    if (finalQualifiedTeams.length < 2) return [] as Array<{
      stageIndex: number
      title: string
      roundBase: number
      matches: Array<{
        key: string
        homeTeamId: string
        awayTeamId: string
        homeLabel: string
        awayLabel: string
        resultLabel: string
        winnerLabel: string
      }>
    }>

    const isSamePair = (match: ScheduledMatchItem, teamA: string, teamB: string) => {
      return (
        (match.homeTeamId === teamA && match.awayTeamId === teamB) ||
        (match.homeTeamId === teamB && match.awayTeamId === teamA)
      )
    }

    const collectPairMatches = (teamA: string, teamB: string, roundBase: number, twoLegged: boolean) => {
      const firstLeg = (finalMatchesByRound.get(roundBase) ?? []).find((match) => isSamePair(match, teamA, teamB)) ?? null
      const secondLeg = twoLegged
        ? (finalMatchesByRound.get(roundBase + 1) ?? []).find((match) => isSamePair(match, teamA, teamB)) ?? null
        : null
      return { firstLeg, secondLeg }
    }

    const buildLegGoals = (record: PlayedMatchRecord, match: ScheduledMatchItem, homeTeamId: string, awayTeamId: string) => {
      const homeGoals = match.homeTeamId === homeTeamId ? record.homeStats.goals : record.awayStats.goals
      const awayGoals = match.awayTeamId === awayTeamId ? record.awayStats.goals : record.homeStats.goals
      return { homeGoals, awayGoals }
    }

    const resolvePairResult = (homeTeamId: string, awayTeamId: string, roundBase: number, twoLegged: boolean) => {
      const { firstLeg, secondLeg } = collectPairMatches(homeTeamId, awayTeamId, roundBase, twoLegged)
      const firstRecord = firstLeg ? playedMatchesMap[firstLeg.id] ?? null : null
      const secondRecord = secondLeg ? playedMatchesMap[secondLeg.id] ?? null : null

      if (!twoLegged) {
        if (!firstRecord || !firstLeg) {
          return { resultLabel: 'Pendiente', winnerTeamId: '' }
        }

        const { homeGoals, awayGoals } = buildLegGoals(firstRecord, firstLeg, homeTeamId, awayTeamId)
        let winnerTeamId = ''
        if (homeGoals > awayGoals) winnerTeamId = homeTeamId
        if (awayGoals > homeGoals) winnerTeamId = awayTeamId

        if (!winnerTeamId && firstRecord.penaltyShootout) {
          winnerTeamId = firstRecord.penaltyShootout.home > firstRecord.penaltyShootout.away ? firstLeg.homeTeamId : firstLeg.awayTeamId
        }

        const penaltySuffix = firstRecord.penaltyShootout
          ? ` · Penales ${firstRecord.penaltyShootout.home}-${firstRecord.penaltyShootout.away}`
          : ''

        return {
          resultLabel: `${homeGoals}-${awayGoals}${penaltySuffix}`,
          winnerTeamId,
        }
      }

      if (!firstRecord && !secondRecord) {
        return { resultLabel: 'Pendiente (ida/vuelta)', winnerTeamId: '' }
      }

      let aggregateHome = 0
      let aggregateAway = 0

      if (firstRecord && firstLeg) {
        const goals = buildLegGoals(firstRecord, firstLeg, homeTeamId, awayTeamId)
        aggregateHome += goals.homeGoals
        aggregateAway += goals.awayGoals
      }

      if (secondRecord && secondLeg) {
        const goals = buildLegGoals(secondRecord, secondLeg, homeTeamId, awayTeamId)
        aggregateHome += goals.homeGoals
        aggregateAway += goals.awayGoals
      }

      let winnerTeamId = ''
      if (aggregateHome > aggregateAway) winnerTeamId = homeTeamId
      if (aggregateAway > aggregateHome) winnerTeamId = awayTeamId

      const penaltyRecord = secondRecord?.penaltyShootout ? secondRecord : firstRecord?.penaltyShootout ? firstRecord : null
      if (!winnerTeamId && penaltyRecord?.penaltyShootout) {
        const penaltyLeg = secondRecord?.penaltyShootout ? secondLeg : firstLeg
        if (!penaltyLeg) {
          return {
            resultLabel: `Global ${aggregateHome}-${aggregateAway}`,
            winnerTeamId,
          }
        }
        winnerTeamId =
          penaltyRecord.penaltyShootout.home > penaltyRecord.penaltyShootout.away
            ? penaltyLeg.homeTeamId
            : penaltyLeg.awayTeamId
      }

      const penaltySuffix = penaltyRecord?.penaltyShootout
        ? ` · Penales ${penaltyRecord.penaltyShootout.home}-${penaltyRecord.penaltyShootout.away}`
        : ''

      return {
        resultLabel: `Global ${aggregateHome}-${aggregateAway}${penaltySuffix}`,
        winnerTeamId,
      }
    }

    const stageCount = Math.max(1, Math.ceil(Math.log2(finalQualifiedTeams.length)))
    const stageDefinitions = Array.from({ length: stageCount }, (_, stageIndex) => {
      return {
        stageIndex,
        twoLegged:
          finalStageTwoLeggedByOrder[stageIndex]
          ?? finalStageTwoLeggedByOrder[finalStageTwoLeggedByOrder.length - 1]
          ?? false,
      }
    })

    let roundCursor = firstFinalRoundNumber
    const stageLayouts = stageDefinitions.map((stage) => {
      const layout = {
        ...stage,
        roundBase: roundCursor,
      }
      roundCursor += stage.twoLegged ? 2 : 1
      return layout
    })

    let projectedWinners: Array<{ teamId: string; label: string }> = []

    return stageLayouts.map((stage) => {
      const { stageIndex, roundBase, twoLegged } = stage
      const expectedMatches = Math.max(1, Math.floor(finalQualifiedTeams.length / 2 ** (stageIndex + 1)))

      const matches = Array.from({ length: expectedMatches }, (_, matchIndex) => {
        let homeTeamId = ''
        let awayTeamId = ''
        let homeLabel = ''
        let awayLabel = ''

        if (stageIndex === 0) {
          const pairing = finalFirstRoundPairings[matchIndex]
          homeTeamId = pairing?.homeTeamId ?? ''
          awayTeamId = pairing?.awayTeamId ?? ''
          homeLabel = teamsById.get(homeTeamId)?.name ?? `Clasificado ${matchIndex * 2 + 1}`
          awayLabel = teamsById.get(awayTeamId)?.name ?? `Clasificado ${matchIndex * 2 + 2}`
        } else {
          const homeProjected = projectedWinners[matchIndex * 2]
          const awayProjected = projectedWinners[matchIndex * 2 + 1]
          homeTeamId = homeProjected?.teamId ?? ''
          awayTeamId = awayProjected?.teamId ?? ''
          homeLabel = homeProjected?.label ?? `Ganador llave ${matchIndex * 2 + 1}`
          awayLabel = awayProjected?.label ?? `Ganador llave ${matchIndex * 2 + 2}`
        }

        let resultLabel = 'Pendiente'
        let winnerLabel = 'Por definir'
        let winnerTeamId = ''

        if (homeTeamId && awayTeamId) {
          const result = resolvePairResult(homeTeamId, awayTeamId, roundBase, twoLegged)
          resultLabel = result.resultLabel
          winnerTeamId = result.winnerTeamId
          winnerLabel = winnerTeamId ? teamsById.get(winnerTeamId)?.name ?? 'Ganador' : 'Por definir'
        } else {
          resultLabel = twoLegged ? 'Pendiente (ida/vuelta)' : 'Pendiente'
        }

        return {
          key: `${roundBase}-${matchIndex}`,
          homeTeamId,
          awayTeamId,
          homeLabel,
          awayLabel,
          resultLabel,
          winnerLabel,
        }
      })

      projectedWinners = matches.map((match, index) => ({
        teamId:
          match.homeTeamId && match.awayTeamId
            ? (resolvePairResult(match.homeTeamId, match.awayTeamId, roundBase, twoLegged).winnerTeamId || '')
            : '',
        label:
          match.homeTeamId && match.awayTeamId
            ? (() => {
              const winnerId = resolvePairResult(match.homeTeamId, match.awayTeamId, roundBase, twoLegged).winnerTeamId
              return winnerId ? teamsById.get(winnerId)?.name ?? `Ganador llave ${index + 1}` : `Ganador llave ${index + 1}`
            })()
            : `Ganador llave ${index + 1}`,
      }))

      return {
        stageIndex,
        title: buildRoundLabel(roundBase, {
          regularSeasonRounds: competitionRulesDraft.regularSeasonRounds,
          finalStageRoundOf16Enabled: competitionRulesDraft.finalStageRoundOf16Enabled,
          finalStageRoundOf8Enabled: competitionRulesDraft.finalStageRoundOf8Enabled,
          finalStageQuarterFinalsEnabled: competitionRulesDraft.finalStageQuarterFinalsEnabled,
          finalStageSemiFinalsEnabled: competitionRulesDraft.finalStageSemiFinalsEnabled,
          finalStageFinalEnabled: competitionRulesDraft.finalStageFinalEnabled,
          finalStageRoundOf16TwoLegged: competitionRulesDraft.finalStageRoundOf16TwoLegged,
          finalStageRoundOf8TwoLegged: competitionRulesDraft.finalStageRoundOf8TwoLegged,
          finalStageQuarterFinalsTwoLegged: competitionRulesDraft.finalStageQuarterFinalsTwoLegged,
          finalStageSemiFinalsTwoLegged: competitionRulesDraft.finalStageSemiFinalsTwoLegged,
          finalStageFinalTwoLegged: competitionRulesDraft.finalStageFinalTwoLegged,
        }),
        roundBase,
        matches,
      }
    })
  }, [
    competitionRulesDraft.regularSeasonRounds,
    competitionRulesDraft.finalStageFinalEnabled,
    competitionRulesDraft.finalStageFinalTwoLegged,
    competitionRulesDraft.finalStageQuarterFinalsEnabled,
    competitionRulesDraft.finalStageQuarterFinalsTwoLegged,
    competitionRulesDraft.finalStageRoundOf16Enabled,
    competitionRulesDraft.finalStageRoundOf16TwoLegged,
    competitionRulesDraft.finalStageRoundOf8Enabled,
    competitionRulesDraft.finalStageRoundOf8TwoLegged,
    competitionRulesDraft.finalStageSemiFinalsEnabled,
    competitionRulesDraft.finalStageSemiFinalsTwoLegged,
    finalStageTwoLeggedByOrder,
    finalFirstRoundPairings,
    finalMatchesByRound,
    finalQualifiedTeams.length,
    firstFinalRoundNumber,
    playedMatchesMap,
    teamsById,
  ])

  const onDragStartFinalSeed = (event: React.DragEvent<HTMLDivElement>, teamId: string) => {
    event.dataTransfer.setData('text/final-seed-team-id', teamId)
    event.dataTransfer.effectAllowed = 'move'
    setDraggingFinalSeedTeamId(teamId)
  }

  const onDropFinalSeed = (event: React.DragEvent<HTMLDivElement>, side: 'left' | 'right', targetIndex: number) => {
    event.preventDefault()
    const draggedTeamId = event.dataTransfer.getData('text/final-seed-team-id')
    if (!draggedTeamId) return

    const sourceSide = finalsLeftSeedTeamIds.includes(draggedTeamId) ? 'left' : finalsRightSeedTeamIds.includes(draggedTeamId) ? 'right' : null
    if (!sourceSide) return

    const nextLeft = [...finalsLeftSeedTeamIds]
    const nextRight = [...finalsRightSeedTeamIds]

    const removeFrom = (sourceSide === 'left' ? nextLeft : nextRight)
    const sourceIndex = removeFrom.indexOf(draggedTeamId)
    if (sourceIndex === -1) return
    removeFrom.splice(sourceIndex, 1)

    const insertInto = (side === 'left' ? nextLeft : nextRight)
    const boundedIndex = Math.max(0, Math.min(targetIndex, insertInto.length))
    insertInto.splice(boundedIndex, 0, draggedTeamId)

    setFinalsLeftSeedTeamIds(nextLeft)
    setFinalsRightSeedTeamIds(nextRight)
    setDraggingFinalSeedTeamId('')
  }

  const onAllowFinalSeedDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
  }

  const addHighlightVideo = async (matchId: string, file: File) => {
    if (!selectedLeague || !activeMatchCategoryId) return

    if (!file.type.startsWith('video/')) {
      applyActionFeedback(false, '', 'Selecciona un archivo de video válido')
      return
    }

    if (file.size > 12 * 1024 * 1024) {
      applyActionFeedback(false, '', 'El video supera 12MB. Sube clips cortos para mejor rendimiento.')
      return
    }

    try {
      const response = await apiService.uploadPlayedMatchVideo(selectedLeague.id, matchId, {
        categoryId: activeMatchCategoryId,
        file,
        name: file.name,
      })

      if (!response.ok) {
        applyActionFeedback(false, '', response.message)
        return
      }

      setPlayedMatchesMap((current) => ({
        ...current,
        [response.data.matchId]: response.data as PlayedMatchRecord,
      }))

      applyActionFeedback(true, 'Video de mejores jugadas cargado en Mongo', '')
    } catch {
      applyActionFeedback(false, '', 'No se pudo cargar el video')
    }
  }

  const deleteHighlightVideo = async (matchId: string, videoId: string) => {
    if (!selectedLeague || !activeMatchCategoryId) return

    try {
      const response = await apiService.deletePlayedMatchVideo(
        selectedLeague.id,
        matchId,
        videoId,
        activeMatchCategoryId,
      )

      if (!response.ok) {
        applyActionFeedback(false, '', response.message)
        return
      }

      setPlayedMatchesMap((current) => ({
        ...current,
        [response.data.matchId]: response.data as PlayedMatchRecord,
      }))

      applyActionFeedback(true, 'Video eliminado del partido', '')
    } catch {
      applyActionFeedback(false, '', 'No se pudo eliminar el video')
    }
  }

  const mvpCandidates = useMemo(() => {
    if (!liveMatch) return [] as Array<{ id: string; name: string; teamName: string; teamId: string; photoUrl?: string; number: number }>

    const home = liveMatch.homeTeam.players.map((player) => ({
      id: player.id,
      name: player.name,
      teamName: liveMatch.homeTeam.name,
      teamId: liveMatch.homeTeam.id,
      photoUrl: player.photoUrl,
      number: player.number,
    }))

    const away = liveMatch.awayTeam.players.map((player) => ({
      id: player.id,
      name: player.name,
      teamName: liveMatch.awayTeam.name,
      teamId: liveMatch.awayTeam.id,
      photoUrl: player.photoUrl,
      number: player.number,
    }))

    return [...home, ...away]
  }, [liveMatch])

  const playedMvpCandidates = useMemo(() => {
    if (!liveMatch) return [] as typeof mvpCandidates

    const startersNow = new Set([...liveMatch.homeTeam.starters, ...liveMatch.awayTeam.starters])
    const eventPlayers = new Set(liveMatch.events.map((event) => event.playerId).filter((id): id is string => Boolean(id)))

    const hasActivity = (teamId: string, playerId: string) => {
      const team = teamId === liveMatch.homeTeam.id ? liveMatch.homeTeam : liveMatch.awayTeam
      const stats = team.playerStats[playerId]
      if (!stats) return false
      return stats.goals > 0 || stats.assists > 0 || stats.shots > 0 || stats.yellows > 0 || stats.reds > 0
    }

    const filtered = mvpCandidates.filter(
      (candidate) =>
        startersNow.has(candidate.id) ||
        eventPlayers.has(candidate.id) ||
        hasActivity(candidate.teamId, candidate.id),
    )

    return filtered.length > 0 ? filtered : mvpCandidates
  }, [liveMatch, mvpCandidates])

  useEffect(() => {
    if (!showMvpModal) return
    if (playedMvpCandidates.some((candidate) => candidate.id === selectedMvpPlayerId)) return
    setSelectedMvpPlayerId('')
  }, [playedMvpCandidates, selectedMvpPlayerId, showMvpModal])

  useEffect(() => {
    if (!showMvpModal) {
      setMvpSearchTerm('')
    }
  }, [showMvpModal])

  const filteredMvpCandidates = useMemo(() => {
    const query = mvpSearchTerm.trim().toLowerCase()
    if (!query) return playedMvpCandidates

    return playedMvpCandidates.filter((candidate) =>
      `${candidate.name} ${candidate.teamName} #${candidate.number}`.toLowerCase().includes(query),
    )
  }, [mvpSearchTerm, playedMvpCandidates])

  const historyRecords = useMemo(() => {
    if (!selectedLeague || !activeMatchCategoryId) return [] as PlayedMatchRecord[]
    return Object.values(playedMatchesMap).filter(
      (record) => record.leagueId === selectedLeague.id && record.categoryId === activeMatchCategoryId,
    )
  }, [activeMatchCategoryId, playedMatchesMap, selectedLeague])

  const availableHistorySeasons = useMemo(() => {
    return Array.from(new Set(leagues.map((league) => league.season))).sort((a, b) => b - a)
  }, [leagues])

  const activeHistorySeason = selectedLeague?.season ?? historySeasonFilter

  const leaguesByHistorySeason = useMemo(() => {
    return leagues.filter((league) => league.season === activeHistorySeason)
  }, [activeHistorySeason, leagues])

  const publicBaseUrl = typeof window !== 'undefined' ? window.location.origin : ''

  const superAdminPublicRows = useMemo(() => {
    const clientUsers = usersOverview.filter((user) => user.role === 'client_admin')

    return clientUsers.flatMap((user) => {
      const companyOrLeague = user.organizationName?.trim() || '-'
      const clientLink = user.publicPortalPath ? `${publicBaseUrl}${user.publicPortalPath}` : '-'
      const leagues = Array.isArray(user.leagues) ? user.leagues : [];

      if (leagues.length === 0) {
        return [
          {
            rowId: `${user.id}__none`,
            clientName: user.name,
            companyOrLeague,
            email: user.email,
            leagueName: '-',
            leagueLink: '-',
            clientLink,
          },
        ]
      }

      return leagues.map((league) => {
        const leaguePath = league.slug ? `/cliente/${encodeURIComponent(league.slug)}` : ''
        return {
          rowId: `${user.id}__${league.id}`,
          clientName: user.name,
          companyOrLeague,
          email: user.email,
          leagueName: league.name,
          leagueLink: leaguePath ? `${publicBaseUrl}${leaguePath}` : '-',
          clientLink,
        }
      })
    })
  }, [publicBaseUrl, usersOverview])

  const clientAdminUsers = useMemo(() => {
    return usersOverview.filter((user) => user.role === 'client_admin')
  }, [usersOverview])

  const filteredClientAdminUsers = useMemo(() => {
    if (clientAdminStatusFilter === 'all') return clientAdminUsers
    if (clientAdminStatusFilter === 'active') {
      return clientAdminUsers.filter((user) => user.active)
    }

    return clientAdminUsers.filter((user) => !user.active)
  }, [clientAdminStatusFilter, clientAdminUsers])

  const clientAdminTotalPages = Math.max(1, Math.ceil(filteredClientAdminUsers.length / CLIENT_ADMIN_PAGE_SIZE))
  const clientAdminPageStartIndex = filteredClientAdminUsers.length === 0 ? 0 : (clientAdminPage - 1) * CLIENT_ADMIN_PAGE_SIZE + 1
  const clientAdminPageEndIndex = Math.min(clientAdminPage * CLIENT_ADMIN_PAGE_SIZE, filteredClientAdminUsers.length)

  const paginatedClientAdminUsers = useMemo(() => {
    const start = (clientAdminPage - 1) * CLIENT_ADMIN_PAGE_SIZE
    return filteredClientAdminUsers.slice(start, start + CLIENT_ADMIN_PAGE_SIZE)
  }, [clientAdminPage, filteredClientAdminUsers])

  const filteredSuperAdminPublicRows = useMemo(() => {
    const query = publicRowsQuery.trim().toLowerCase()
    if (!query) return superAdminPublicRows

    return superAdminPublicRows.filter((row) =>
      `${row.clientName} ${row.companyOrLeague} ${row.email} ${row.leagueName}`.toLowerCase().includes(query),
    )
  }, [publicRowsQuery, superAdminPublicRows])

  const publicRowsTotalPages = Math.max(1, Math.ceil(filteredSuperAdminPublicRows.length / PUBLIC_ROWS_PAGE_SIZE))
  const publicRowsPageStartIndex = filteredSuperAdminPublicRows.length === 0 ? 0 : (publicRowsPage - 1) * PUBLIC_ROWS_PAGE_SIZE + 1
  const publicRowsPageEndIndex = Math.min(publicRowsPage * PUBLIC_ROWS_PAGE_SIZE, filteredSuperAdminPublicRows.length)

  const paginatedSuperAdminPublicRows = useMemo(() => {
    const start = (publicRowsPage - 1) * PUBLIC_ROWS_PAGE_SIZE
    return filteredSuperAdminPublicRows.slice(start, start + PUBLIC_ROWS_PAGE_SIZE)
  }, [filteredSuperAdminPublicRows, publicRowsPage])

  useEffect(() => {
    setClientAdminPage((current) => Math.min(current, clientAdminTotalPages))
  }, [clientAdminTotalPages])

  useEffect(() => {
    setPublicRowsPage((current) => Math.min(current, publicRowsTotalPages))
  }, [publicRowsTotalPages])

  const getRoundLabel = useCallback(
    (round: number) =>
      buildRoundLabel(round, {
        regularSeasonRounds: competitionRulesDraft.regularSeasonRounds,
        finalStageRoundOf16Enabled: competitionRulesDraft.finalStageRoundOf16Enabled,
        finalStageRoundOf8Enabled: competitionRulesDraft.finalStageRoundOf8Enabled,
        finalStageQuarterFinalsEnabled: competitionRulesDraft.finalStageQuarterFinalsEnabled,
        finalStageSemiFinalsEnabled: competitionRulesDraft.finalStageSemiFinalsEnabled,
        finalStageFinalEnabled: competitionRulesDraft.finalStageFinalEnabled,
        finalStageRoundOf16TwoLegged: competitionRulesDraft.finalStageRoundOf16TwoLegged,
        finalStageRoundOf8TwoLegged: competitionRulesDraft.finalStageRoundOf8TwoLegged,
        finalStageQuarterFinalsTwoLegged: competitionRulesDraft.finalStageQuarterFinalsTwoLegged,
        finalStageSemiFinalsTwoLegged: competitionRulesDraft.finalStageSemiFinalsTwoLegged,
        finalStageFinalTwoLegged: competitionRulesDraft.finalStageFinalTwoLegged,
      }),
    [competitionRulesDraft],
  )

  const historyPlayerRankings = useMemo(() => {
    const players = new Map<
      string,
      {
        playerId: string
        playerName: string
        playerNumber: number
        teamId: string
        teamName: string
        teamLogoUrl?: string
        position: string
        matches: number
        goalsConceded: number
        avgGoalsConceded: number
        goals: number
        assists: number
        yellows: number
        reds: number
      }
    >()

    historyRecords.forEach((record) => {
      record.players.forEach((player) => {
        const current = players.get(player.playerId) ?? {
          playerId: player.playerId,
          playerName: player.playerName,
          playerNumber: teamsById.get(player.teamId)?.players.find((item) => item.id === player.playerId)?.number ?? 0,
          teamId: player.teamId,
          teamName: player.teamName,
          teamLogoUrl: teamsById.get(player.teamId)?.logoUrl,
          position: player.position,
          matches: 0,
          goalsConceded: 0,
          avgGoalsConceded: 0,
          goals: 0,
          assists: 0,
          yellows: 0,
          reds: 0,
        }

        current.matches += 1
        current.goalsConceded += player.goalsConceded
        current.goals += player.goals
        current.assists += player.assists
        current.yellows += player.yellows
        current.reds += player.reds

        players.set(player.playerId, current)
      })
    })

    const values = Array.from(players.values())
    const valuesWithAverage = values.map((item) => ({
      ...item,
      avgGoalsConceded: item.matches > 0 ? item.goalsConceded / item.matches : 0,
    }))

    const sortByMetric = (list: typeof valuesWithAverage, metric: 'goals' | 'assists' | 'yellows' | 'reds') => {
      return [...list].sort(
        (a, b) =>
          b[metric] - a[metric]
          || a.playerName.localeCompare(b.playerName, 'es', { sensitivity: 'base' })
          || a.teamName.localeCompare(b.teamName, 'es', { sensitivity: 'base' }),
      )
    }

    const keepers = valuesWithAverage
      .filter((item) => item.position.toUpperCase().includes('POR') && item.matches > 0)
      .sort(
        (a, b) =>
          a.avgGoalsConceded - b.avgGoalsConceded
          || a.playerName.localeCompare(b.playerName, 'es', { sensitivity: 'base' })
          || a.teamName.localeCompare(b.teamName, 'es', { sensitivity: 'base' }),
      )

    return {
      scorers: sortByMetric(valuesWithAverage.filter((item) => item.goals > 0), 'goals'),
      assists: sortByMetric(valuesWithAverage.filter((item) => item.assists > 0), 'assists'),
      yellows: sortByMetric(valuesWithAverage.filter((item) => item.yellows > 0), 'yellows'),
      reds: sortByMetric(valuesWithAverage.filter((item) => item.reds > 0), 'reds'),
      keepers,
    }
  }, [historyRecords, teamsById])

  const standings = useMemo(() => {
    const pointsWin = selectedCategoryRules?.pointsWin ?? 3
    const pointsDraw = selectedCategoryRules?.pointsDraw ?? 1
    const pointsLoss = selectedCategoryRules?.pointsLoss ?? 0
    const resolveDrawByPenalties = selectedCategoryRules?.resolveDrawByPenalties ?? false
    const regularSeasonRounds = selectedCategoryRules?.regularSeasonRounds ?? 9

    const table = new Map<
      string,
      {
        teamId: string
        teamName: string
        teamLogoUrl?: string
        pj: number
        pg: number
        pe: number
        pp: number
        gf: number
        gc: number
        dg: number
        pts: number
      }
    >()

    const ensure = (teamId: string, teamName: string) => {
      const row = table.get(teamId)
      if (row) return row
      const created = {
        teamId,
        teamName,
        teamLogoUrl: teamsById.get(teamId)?.logoUrl,
        pj: 0,
        pg: 0,
        pe: 0,
        pp: 0,
        gf: 0,
        gc: 0,
        dg: 0,
        pts: 0,
      }
      table.set(teamId, created)
      return created
    }

    Array.from(teamsById.values()).forEach((team) => {
      ensure(team.id, team.name)
    })

    playedMatches.forEach((match) => {
      const record = playedMatchesMap[match.id]
      if (!record) return
      if (record.round > regularSeasonRounds) return

      const homeName = teamsById.get(match.homeTeamId)?.name ?? record.homeTeamName
      const awayName = teamsById.get(match.awayTeamId)?.name ?? record.awayTeamName

      const home = ensure(match.homeTeamId, homeName)
      const away = ensure(match.awayTeamId, awayName)

      home.pj += 1
      away.pj += 1
      home.gf += record.homeStats.goals
      home.gc += record.awayStats.goals
      away.gf += record.awayStats.goals
      away.gc += record.homeStats.goals

      if (record.homeStats.goals > record.awayStats.goals) {
        home.pg += 1
        home.pts += pointsWin
        away.pp += 1
        away.pts += pointsLoss
      } else if (record.homeStats.goals < record.awayStats.goals) {
        away.pg += 1
        away.pts += pointsWin
        home.pp += 1
        home.pts += pointsLoss
      } else {
        const hasPenaltyWinner =
          resolveDrawByPenalties &&
          record.round > regularSeasonRounds &&
          record.penaltyShootout &&
          record.penaltyShootout.home !== record.penaltyShootout.away

        if (hasPenaltyWinner && record.penaltyShootout) {
          if (record.penaltyShootout.home > record.penaltyShootout.away) {
            home.pg += 1
            home.pts += pointsWin
            away.pp += 1
            away.pts += pointsLoss
          } else {
            away.pg += 1
            away.pts += pointsWin
            home.pp += 1
            home.pts += pointsLoss
          }
        } else {
          home.pe += 1
          away.pe += 1
          home.pts += pointsDraw
          away.pts += pointsDraw
        }
      }
    })

    return Array.from(table.values())
      .map((item) => ({ ...item, dg: item.gf - item.gc }))
      .sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf || a.teamName.localeCompare(b.teamName, 'es'))
  }, [playedMatches, playedMatchesMap, selectedCategoryRules, teamsById])

  const paginateHistoryRanking = useCallback(<T,>(list: T[], page: number) => {
    const pageSize = 10
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize))
    const currentPage = Math.min(Math.max(page, 1), totalPages)
    const offset = (currentPage - 1) * pageSize

    return {
      currentPage,
      totalPages,
      totalItems: list.length,
      pageItems: list.slice(offset, offset + pageSize),
    }
  }, [])

  const filteredScorers = useMemo(() => {
    const query = scorersSearchTerm.trim().toLowerCase()
    if (!query) return historyPlayerRankings.scorers
    return historyPlayerRankings.scorers.filter((item) => `${item.playerName} ${item.teamName}`.toLowerCase().includes(query))
  }, [historyPlayerRankings.scorers, scorersSearchTerm])

  const filteredAssists = useMemo(() => {
    const query = assistsSearchTerm.trim().toLowerCase()
    if (!query) return historyPlayerRankings.assists
    return historyPlayerRankings.assists.filter((item) => `${item.playerName} ${item.teamName}`.toLowerCase().includes(query))
  }, [assistsSearchTerm, historyPlayerRankings.assists])

  const filteredYellows = useMemo(() => {
    const query = yellowsSearchTerm.trim().toLowerCase()
    if (!query) return historyPlayerRankings.yellows
    return historyPlayerRankings.yellows.filter((item) => `${item.playerName} ${item.teamName}`.toLowerCase().includes(query))
  }, [historyPlayerRankings.yellows, yellowsSearchTerm])

  const filteredReds = useMemo(() => {
    const query = redsSearchTerm.trim().toLowerCase()
    if (!query) return historyPlayerRankings.reds
    return historyPlayerRankings.reds.filter((item) => `${item.playerName} ${item.teamName}`.toLowerCase().includes(query))
  }, [historyPlayerRankings.reds, redsSearchTerm])

  const scorersPagination = useMemo(() => paginateHistoryRanking(filteredScorers, scorersPage), [filteredScorers, paginateHistoryRanking, scorersPage])
  const assistsPagination = useMemo(() => paginateHistoryRanking(filteredAssists, assistsPage), [assistsPage, filteredAssists, paginateHistoryRanking])
  const yellowsPagination = useMemo(() => paginateHistoryRanking(filteredYellows, yellowsPage), [filteredYellows, paginateHistoryRanking, yellowsPage])
  const redsPagination = useMemo(() => paginateHistoryRanking(filteredReds, redsPage), [filteredReds, paginateHistoryRanking, redsPage])

  useEffect(() => {
    setScorersPage(1)
    setAssistsPage(1)
    setYellowsPage(1)
    setRedsPage(1)
  }, [selectedLeague?.id, activeMatchCategoryId, activeHistorySeason, scorersSearchTerm, assistsSearchTerm, yellowsSearchTerm, redsSearchTerm])

  const auditPagination = useMemo(() => {
    const pageSize = 12
    const totalPages = Math.max(1, Math.ceil(auditLogs.length / pageSize))
    const currentPage = Math.min(Math.max(auditPage, 1), totalPages)
    const offset = (currentPage - 1) * pageSize

    return {
      currentPage,
      totalPages,
      pageItems: auditLogs.slice(offset, offset + pageSize),
    }
  }, [auditLogs, auditPage])

  const downloadHistoryTop5Png = async () => {
    if (!historyTop5CardRef.current) {
      applyActionFeedback(false, '', 'No hay tarjeta Top 5 disponible para descargar')
      return
    }

    try {
      const dataUrl = await toPng(historyTop5CardRef.current, {
        cacheBust: true,
        pixelRatio: 2,
      })

      const leagueSlug = (selectedLeague?.name ?? 'liga').replace(/\s+/g, '-').toLowerCase()
      const fileName = `${leagueSlug}-top-5-jugadora-fecha-temporada-${activeHistorySeason}.png`

      const link = document.createElement('a')
      link.download = fileName
      link.href = dataUrl
      link.click()

      applyActionFeedback(true, 'Top 5 descargado en PNG', '')
    } catch {
      applyActionFeedback(false, '', 'No se pudo generar la imagen del Top 5')
    }
  }

  const historyTabMeta: Record<HistoryTabKey, { label: string; fileSuffix: string }> = {
    standings: { label: 'Tabla de posiciones', fileSuffix: 'tabla-posiciones' },
    scorers: { label: 'Tabla de goleadores', fileSuffix: 'tabla-goleadores' },
    assists: { label: 'Tabla de asistencias', fileSuffix: 'tabla-asistencias' },
    yellows: { label: 'Tabla TA', fileSuffix: 'tabla-ta' },
    reds: { label: 'Tabla TR', fileSuffix: 'tabla-tr' },
  }

  const captureHistoryTablePng = async (tab: HistoryTabKey) => {
    const target = historyTableRefs.current[tab]
    if (!target) {
      throw new Error('No hay tabla visible para exportar')
    }

    const width = Math.max(target.scrollWidth, target.clientWidth)
    const height = Math.max(target.scrollHeight, target.clientHeight)

    return toPng(target, {
      cacheBust: true,
      pixelRatio: 2,
      width,
      height,
      canvasWidth: width,
      canvasHeight: height,
    })
  }

  const buildHistoryTableFileName = (tab: HistoryTabKey) => {
    const leagueSlug = (selectedLeague?.name ?? 'liga').replace(/\s+/g, '-').toLowerCase()
    const suffix = historyTabMeta[tab].fileSuffix
    return `${leagueSlug}-${suffix}-temporada-${activeHistorySeason}.png`
  }

  const downloadHistoryTablePng = async (tab: HistoryTabKey) => {
    try {
      const dataUrl = await captureHistoryTablePng(tab)
      const fileName = buildHistoryTableFileName(tab)

      const link = document.createElement('a')
      link.download = fileName
      link.href = dataUrl
      link.click()

      applyActionFeedback(true, `${historyTabMeta[tab].label} descargada en PNG`, '')
    } catch {
      applyActionFeedback(false, '', `No se pudo exportar ${historyTabMeta[tab].label.toLowerCase()}`)
    }
  }

  const shareHistoryTableToWhatsApp = async (tab: HistoryTabKey) => {
    try {
      const dataUrl = await captureHistoryTablePng(tab)
      const fileName = buildHistoryTableFileName(tab)
      const shareText = `${historyTabMeta[tab].label} · ${selectedLeague?.name ?? 'Liga'} · Temporada ${activeHistorySeason}`

      const supportsFileShare =
        typeof navigator !== 'undefined'
        && 'share' in navigator
        && 'canShare' in navigator

      if (supportsFileShare) {
        const imageFile = await dataUrlToFile(dataUrl, fileName)
        const canShare = (navigator as Navigator & { canShare?: (data: ShareData) => boolean }).canShare
        if (canShare?.({ files: [imageFile] })) {
          await navigator.share({
            files: [imageFile],
            title: historyTabMeta[tab].label,
            text: `${shareText} · Compartido desde FL Liga`,
          })
          applyActionFeedback(true, `${historyTabMeta[tab].label} compartida`, '')
          return
        }
      }

      await downloadHistoryTablePng(tab)
      window.open(`https://wa.me/?text=${encodeURIComponent(`${shareText} (imagen descargada en tu dispositivo)` )}`, '_blank', 'noopener,noreferrer')
      applyActionFeedback(true, 'Abrimos WhatsApp; adjunta la imagen descargada para enviar', '')
    } catch {
      applyActionFeedback(false, '', 'No se pudo compartir la imagen por WhatsApp')
    }
  }

  const startPendingMatchLive = async () => {
    if (!selectedLeague || !activeMatchCategoryId || !selectedPendingMatch) return

    const response = await apiService.loadLiveMatch({
      leagueId: selectedLeague.id,
      categoryId: activeMatchCategoryId,
      homeTeamId: selectedPendingMatch.homeTeamId,
      awayTeamId: selectedPendingMatch.awayTeamId,
    })

    if (!response.ok) {
      applyActionFeedback(false, '', response.message)
      return
    }

    setLiveMatch(response.data)
    setSelectedTeamId(response.data.homeTeam.id)
    setLineupStarters(response.data.homeTeam.starters)
    setLineupSubstitutes(response.data.homeTeam.substitutes)
    setSettingsDraft(response.data.settings)
    setSubstitutionVisualByTeam({})
    setSubstitutionTimelineByTeam({})
    setSelectedMvpPlayerId('')
    setSecondHalfStarted(false)
    applyActionFeedback(true, 'Partido cargado para iniciar en vivo', '')
  }

  const markCurrentMatchAsPlayed = async () => {
    if (!liveMatch || !selectedPendingMatch || !selectedLeague || !activeMatchCategoryId) return false
    if (playedMatchesMap[selectedPendingMatch.id]) {
      applyActionFeedback(true, 'Este partido ya se encuentra guardado en historial', '')
      return true
    }

    const isDrawAfterRegularTime = liveMatch.homeTeam.stats.goals === liveMatch.awayTeam.stats.goals
    const isFinalStageMatch = selectedPendingMatch.round > competitionRulesDraft.regularSeasonRounds
    let penaltyShootout: PlayedMatchRecord['penaltyShootout'] | undefined

    if (isDrawAfterRegularTime && competitionRulesDraft.resolveDrawByPenalties && isFinalStageMatch) {
      const homePenalties = Number(homePenaltiesDraft)
      const awayPenalties = Number(awayPenaltiesDraft)
      if (!Number.isFinite(homePenalties) || !Number.isFinite(awayPenalties)) {
        applyActionFeedback(false, '', 'Ingresa penales válidos para local y visitante')
        return false
      }
      if (homePenalties < 0 || awayPenalties < 0) {
        applyActionFeedback(false, '', 'Los penales no pueden ser negativos')
        return false
      }
      if (homePenalties === awayPenalties) {
        applyActionFeedback(false, '', 'En penales debe existir un ganador')
        return false
      }
      penaltyShootout = {
        home: homePenalties,
        away: awayPenalties,
      }
    }

    const selectedMvp = playedMvpCandidates.find((candidate) => candidate.id === selectedMvpPlayerId)
    if (!selectedMvp) {
      applyActionFeedback(false, '', 'Selecciona un MVP válido entre las jugadoras que participaron')
      return false
    }

    const players: PlayedMatchRecord['players'] = [
      ...liveMatch.homeTeam.players.map((player) => {
        const playerStats = liveMatch.homeTeam.playerStats[player.id] ?? {
          goals: 0,
          assists: 0,
          shots: 0,
          yellows: 0,
          reds: 0,
        }

        return {
          playerId: player.id,
          playerName: player.name,
          teamId: liveMatch.homeTeam.id,
          teamName: liveMatch.homeTeam.name,
          position: player.position,
          goals: playerStats.goals,
          assists: playerStats.assists,
          shots: playerStats.shots,
          yellows: playerStats.yellows,
          reds: playerStats.reds,
          goalsConceded: liveMatch.awayTeam.stats.goals,
        }
      }),
      ...liveMatch.awayTeam.players.map((player) => {
        const playerStats = liveMatch.awayTeam.playerStats[player.id] ?? {
          goals: 0,
          assists: 0,
          shots: 0,
          yellows: 0,
          reds: 0,
        }

        return {
          playerId: player.id,
          playerName: player.name,
          teamId: liveMatch.awayTeam.id,
          teamName: liveMatch.awayTeam.name,
          position: player.position,
          goals: playerStats.goals,
          assists: playerStats.assists,
          shots: playerStats.shots,
          yellows: playerStats.yellows,
          reds: playerStats.reds,
          goalsConceded: liveMatch.homeTeam.stats.goals,
        }
      }),
    ]

    const record: PlayedMatchRecord = {
      matchId: selectedPendingMatch.id,
      leagueId: selectedLeague.id,
      categoryId: activeMatchCategoryId,
      round: selectedPendingMatch.round,
      finalMinute: liveCurrentMinute,
      homeTeamName: liveMatch.homeTeam.name,
      awayTeamName: liveMatch.awayTeam.name,
      homeStats: { ...liveMatch.homeTeam.stats },
      awayStats: { ...liveMatch.awayTeam.stats },
      ...(penaltyShootout ? { penaltyShootout } : {}),
      playerOfMatchId: selectedMvp.id,
      playerOfMatchName: selectedMvp.name,
      homeLineup: {
        starters: [...liveMatch.homeTeam.starters],
        substitutes: [...liveMatch.homeTeam.substitutes],
        formationKey: liveMatch.homeTeam.formationKey,
      },
      awayLineup: {
        starters: [...liveMatch.awayTeam.starters],
        substitutes: [...liveMatch.awayTeam.substitutes],
        formationKey: liveMatch.awayTeam.formationKey,
      },
      players,
      goals: liveMatch.events
        .filter((event) => event.type === 'goal' || event.type === 'penalty_goal')
        .map((event) => {
          const isHome = event.teamId === liveMatch.homeTeam.id
          const team = isHome ? liveMatch.homeTeam : liveMatch.awayTeam
          const player = event.playerId ? team.players.find((item) => item.id === event.playerId) : null

          return {
            minute: event.minute,
            clock: event.clock,
            teamName: team.name,
            playerName: player?.name ?? 'Sin jugador',
          }
        }),
      events: liveMatch.events.map((event) => {
        const team = event.teamId === liveMatch.homeTeam.id ? liveMatch.homeTeam : liveMatch.awayTeam
        const actorLabel = resolveEventActorLabel(team, event)
        const incomingPlayerName = event.substitutionInPlayerId
          ? (team.players.find((item) => item.id === event.substitutionInPlayerId)?.name ?? '')
          : ''

        return {
          clock: event.clock,
          type: event.type,
          teamName: team.name,
          playerName: actorLabel,
          ...(incomingPlayerName ? { substitutionInPlayerName: incomingPlayerName } : {}),
          ...(event.staffRole ? { staffRole: event.staffRole } : {}),
        }
      }),
      highlightVideos: [],
      playedAt: new Date().toISOString(),
    }

    const response = await apiService.savePlayedMatch(selectedLeague.id, record)
    if (!response.ok) {
      applyActionFeedback(false, '', response.message)
      return false
    }

    setPlayedMatchesMap((current) => ({
      ...current,
      [selectedPendingMatch.id]: response.data as PlayedMatchRecord,
    }))
    setSelectedPlayedMatchId(selectedPendingMatch.id)
    setSelectedPendingMatchId('')
    setSelectedMvpPlayerId('')
    setHomePenaltiesDraft('')
    setAwayPenaltiesDraft('')
    applyActionFeedback(true, 'Partido marcado como jugado', '')
    return true
  }

  if (publicClientId) {
    return <ClientPortal clientId={publicClientId} />
  }

  // Modal de sesión caducada — aparece sobre cualquier pantalla
  if (sessionExpired) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
        <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-8 text-center shadow-2xl">
          <div className="mb-4 flex justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/20">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
          </div>
          <h2 className="mb-2 text-xl font-bold text-white">Sesión caducada</h2>
          <p className="mb-6 text-sm text-slate-400">Tu sesión ha expirado o fue cerrada desde otro dispositivo. Por favor, inicia sesión nuevamente.</p>
          <button
            className="w-full rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white transition hover:bg-indigo-500"
            onClick={() => setSessionExpired(false)}
          >
            Ir al inicio de sesión
          </button>
        </div>
      </div>
    )
  }

  if (!authUser) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 text-slate-100">
        <main className="mx-auto flex min-h-screen w-full max-w-md items-center px-4 py-10">
          <section className="w-full rounded-2xl border border-white/10 bg-white/5 p-6">
            <div className="mb-4 flex items-center gap-3">
              <img
                src="/logo.png"
                alt="FL"
                className="h-12 w-12 rounded-full border border-white/20 bg-white object-contain p-1"
                onMouseDown={startSuperAdminLogoPress}
                onMouseUp={endSuperAdminLogoPress}
                onMouseLeave={endSuperAdminLogoPress}
                onTouchStart={startSuperAdminLogoPress}
                onTouchEnd={endSuperAdminLogoPress}
              />
              <h1 className="text-2xl font-bold text-white">FL League · Login</h1>
            </div>
            <p className="mt-2 text-sm text-slate-300">Super admin ingresa directo. Cliente admin primero valida token.</p>

            {loginMode === 'super_admin' && (
              <div className="mt-4 grid grid-cols-1 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setLoginMode('client_admin')
                    setLoginError('')
                  }}
                  className="rounded border border-cyan-300/50 bg-cyan-500/20 px-3 py-2 text-xs font-semibold text-cyan-100"
                >
                  Cliente Admin
                </button>
              </div>
            )}

            {loginMode === 'client_admin' && (
              <div className="mt-4 space-y-2 rounded border border-cyan-300/25 bg-cyan-500/5 p-3">
                <p className="text-xs text-cyan-100">Ingresa el token compartido por super admin para habilitar login/registro.</p>
                <div className="flex gap-2">
                  <input
                    value={clientAccessTokenInput}
                    onChange={(event) => {
                      setClientAccessTokenInput(event.target.value)
                      setClientTokenValidated(false)
                      setClientTokenValidation(null)
                    }}
                    placeholder="Token de acceso"
                    className="w-full rounded border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
                  />
                  <button
                    type="button"
                    onClick={() => void handleValidateClientToken()}
                    className="rounded border border-cyan-300/50 bg-cyan-500/20 px-3 py-2 text-xs font-semibold text-cyan-100"
                  >
                    Validar
                  </button>
                </div>
                {clientTokenValidation && (
                  <p className="text-xs text-slate-200">
                    Cliente: {clientTokenValidation.client.name} · Vence: {new Date(clientTokenValidation.expiresAt).toLocaleString()}
                  </p>
                )}
              </div>
            )}

            <div className="mt-4 space-y-3">
              <input
                value={loginEmail}
                onChange={(event) => setLoginEmail(event.target.value)}
                placeholder={loginMode === 'super_admin' ? 'Usuario o correo' : 'Correo'}
                className="w-full rounded border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
              />
              <div className="flex gap-2">
                <input
                  type={showLoginPassword ? 'text' : 'password'}
                  value={loginPassword}
                  onChange={(event) => setLoginPassword(event.target.value)}
                  placeholder="Contraseña"
                  className="w-full rounded border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
                />
                <button
                  type="button"
                  onClick={() => setShowLoginPassword((current) => !current)}
                  className="rounded border border-white/20 bg-slate-900 px-3 py-2 text-xs text-slate-200"
                >
                  {showLoginPassword ? 'Ocultar' : 'Mostrar'}
                </button>
              </div>
              <button
                type="button"
                onClick={() => void handleLogin()}
                className="w-full rounded bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-500"
              >
                Iniciar sesión
              </button>

              {loginMode === 'client_admin' && clientTokenValidated && (
                <div className="rounded border border-white/10 bg-slate-900/60 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-200">¿Primera vez? Crea usuario cliente</p>
                    <button
                      type="button"
                      onClick={() => setShowClientRegister((current) => !current)}
                      className="text-[11px] text-cyan-200"
                    >
                      {showClientRegister ? 'Ocultar' : 'Mostrar'}
                    </button>
                  </div>
                  {showClientRegister && (
                    <div className="space-y-2">
                      <input
                        value={registerClientName}
                        onChange={(event) => setRegisterClientName(event.target.value)}
                        placeholder="Nombre completo"
                        className="w-full rounded border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
                      />
                      <input
                        value={registerClientOrganization}
                        onChange={(event) => setRegisterClientOrganization(event.target.value)}
                        placeholder="Empresa o nombre de liga"
                        className="w-full rounded border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
                      />
                      <input
                        value={registerClientEmail}
                        onChange={(event) => setRegisterClientEmail(event.target.value)}
                        placeholder="Correo"
                        className="w-full rounded border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
                      />
                      <input
                        type="password"
                        value={registerClientPassword}
                        onChange={(event) => setRegisterClientPassword(event.target.value)}
                        placeholder="Contraseña"
                        className="w-full rounded border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
                      />
                      <input
                        type="password"
                        value={registerClientPasswordConfirm}
                        onChange={(event) => setRegisterClientPasswordConfirm(event.target.value)}
                        placeholder="Confirmar contraseña"
                        className="w-full rounded border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
                      />
                      <button
                        type="button"
                        disabled={creatingClientUser}
                        onClick={() => void handleCreateClientUser()}
                        className="w-full rounded border border-cyan-300/50 bg-cyan-500/20 px-3 py-2 text-sm font-semibold text-cyan-100 disabled:opacity-60"
                      >
                        {creatingClientUser ? 'Creando usuario...' : 'Crear usuario cliente'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {loginMode === 'client_admin' && clientTokenValidated && (
                <div className="rounded border border-white/10 bg-slate-900/60 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-200">¿Olvidaste tu contraseña?</p>
                    <button
                      type="button"
                      onClick={() => setShowClientResetPassword((current) => !current)}
                      className="text-[11px] text-cyan-200"
                    >
                      {showClientResetPassword ? 'Ocultar' : 'Restablecer'}
                    </button>
                  </div>
                  {showClientResetPassword && (
                    <div className="space-y-2">
                      <input
                        value={resetClientEmail}
                        onChange={(event) => setResetClientEmail(event.target.value)}
                        placeholder="Correo"
                        className="w-full rounded border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
                      />
                      <input
                        type="password"
                        value={resetClientPassword}
                        onChange={(event) => setResetClientPassword(event.target.value)}
                        placeholder="Nueva contraseña"
                        className="w-full rounded border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
                      />
                      <input
                        type="password"
                        value={resetClientPasswordConfirm}
                        onChange={(event) => setResetClientPasswordConfirm(event.target.value)}
                        placeholder="Confirmar nueva contraseña"
                        className="w-full rounded border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
                      />
                      <button
                        type="button"
                        onClick={() => void handleResetClientPassword()}
                        className="w-full rounded border border-cyan-300/50 bg-cyan-500/20 px-3 py-2 text-sm font-semibold text-cyan-100"
                      >
                        Restablecer contraseña
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {loginError && <p className="mt-3 text-sm text-rose-300">{loginError}</p>}
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 text-slate-100">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-start justify-between gap-4 px-4 py-4 md:flex-row md:items-center md:px-8">
          <div className="flex w-full items-center gap-3 md:w-auto">
            <img
              src={selectedLeague?.logoUrl || '/logo.png'}
              alt={selectedLeague?.name || 'FL League'}
              className="h-12 w-12 rounded-full border border-white/20 bg-white object-contain p-1"
            />
            <div>
              <h1 className="text-2xl font-bold text-white md:text-3xl">{selectedLeague?.name ?? leagueTitle}</h1>
              {selectedLeague ? (
                <>
                  <p className="text-sm text-primary-200">Temporada {selectedLeague.season}</p>
                  {selectedLeague.slogan && <p className="text-xs text-slate-300">{selectedLeague.slogan}</p>}
                </>
              ) : (
                <p className="text-sm text-primary-200">Plataforma multiliga parametrizable</p>
              )}
            </div>
          </div>

          <div className="flex w-full flex-col items-start gap-2 md:w-auto md:items-end">
            <nav className="flex w-full flex-wrap gap-2 md:w-auto">
              <button
                type="button"
                onClick={() => setAdminView('ligas')}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold md:text-sm ${
                  adminView === 'ligas'
                    ? 'border border-primary-300/40 bg-primary-500/20 text-primary-100'
                    : 'border border-white/20 bg-slate-900 text-slate-200'
                }`}
              >
                Ligas
              </button>
              <button
                type="button"
                onClick={() => setAdminView('configuracion')}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold md:text-sm ${
                  adminView === 'configuracion'
                    ? 'border border-primary-300/40 bg-primary-500/20 text-primary-100'
                    : 'border border-white/20 bg-slate-900 text-slate-200'
                }`}
              >
                Configuración
              </button>
              <button
                type="button"
                onClick={() => setAdminView('gestion')}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold md:text-sm ${
                  adminView === 'gestion'
                    ? 'border border-primary-300/40 bg-primary-500/20 text-primary-100'
                    : 'border border-white/20 bg-slate-900 text-slate-200'
                }`}
              >
                Gestión
              </button>
              <button
                type="button"
                onClick={() => setAdminView('partidos')}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold md:text-sm ${
                  adminView === 'partidos'
                    ? 'border border-primary-300/40 bg-primary-500/20 text-primary-100'
                    : 'border border-white/20 bg-slate-900 text-slate-200'
                }`}
              >
                Partidos
              </button>
              <button
                type="button"
                onClick={() => setAdminView('historial')}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold md:text-sm ${
                  adminView === 'historial'
                    ? 'border border-primary-300/40 bg-primary-500/20 text-primary-100'
                    : 'border border-white/20 bg-slate-900 text-slate-200'
                }`}
              >
                Historial
              </button>
              {authUser.role === 'super_admin' && (
                <button
                  type="button"
                  onClick={() => setAdminView('auditoria')}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold md:text-sm ${
                    adminView === 'auditoria'
                      ? 'border border-primary-300/40 bg-primary-500/20 text-primary-100'
                      : 'border border-white/20 bg-slate-900 text-slate-200'
                  }`}
                >
                  Auditoría
                </button>
              )}
            </nav>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full border border-white/20 bg-slate-900 px-3 py-1 text-slate-200">
                {authUser.name} · {authUser.role === 'super_admin' ? 'Super Admin' : 'Cliente'}
              </span>
              <button
                type="button"
                onClick={handleLogout}
                className="rounded border border-rose-300/40 bg-rose-600/20 px-2 py-1 font-semibold text-rose-100"
              >
                Salir
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
        {adminView === 'ligas' && (
          <>
            {authUser.role === 'super_admin' && (
              <section className="mb-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setSuperAdminLigasTab('ligas')}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold md:text-sm ${
                    superAdminLigasTab === 'ligas'
                      ? 'border border-primary-300/40 bg-primary-500/20 text-primary-100'
                      : 'border border-white/20 bg-slate-900 text-slate-200'
                  }`}
                >
                  Ligas
                </button>
                <button
                  type="button"
                  onClick={() => setSuperAdminLigasTab('clientes')}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold md:text-sm ${
                    superAdminLigasTab === 'clientes'
                      ? 'border border-primary-300/40 bg-primary-500/20 text-primary-100'
                      : 'border border-white/20 bg-slate-900 text-slate-200'
                  }`}
                >
                  Clientes registrados
                </button>
              </section>
            )}

            {(authUser.role !== 'super_admin' || superAdminLigasTab === 'ligas') && (
            <section className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <article className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-lg shadow-black/20">
            <h2 className="text-xl font-semibold text-white md:text-2xl">Ligas registradas</h2>
            <p className="mt-2 text-sm text-slate-300">
              Esta base ya permite múltiples ligas independientes, categorías por edad y reglas de juego por categoría.
            </p>

            {loading && <p className="mt-5 text-sm text-primary-200">Cargando ligas...</p>}
            {errorMessage && <p className="mt-5 text-sm text-red-300">{errorMessage}</p>}

            {!loading && !errorMessage && (
              <div className="mt-5 space-y-3">
                {leagues.length === 0 && (
                  <div className="rounded-xl border border-amber-300/30 bg-amber-500/10 p-3 text-sm text-amber-100">
                    No hay ligas registradas visibles para este usuario.
                  </div>
                )}
                {leagues.map((league) => {
                  const isSelected = league.id === selectedLeagueId
                  return (
                    <button
                      key={league.id}
                      type="button"
                      onClick={() => {
                        handleSelectLeague(league.id)
                        setAdminView('partidos')
                      }}
                      className={`w-full rounded-xl border px-4 py-3 text-left transition ${
                        isSelected
                          ? 'border-primary-300/60 bg-primary-400/20'
                          : 'border-white/10 bg-slate-900/50 hover:border-white/20 hover:bg-slate-900'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {league.logoUrl && <img src={league.logoUrl} alt={league.name} className="h-8 w-8 rounded border border-white/20 bg-white object-contain p-1" />}
                        <p className="font-semibold text-white">{league.name}</p>
                      </div>
                      <p className="text-xs text-slate-300">
                        {league.country} • Temporada {league.season} • {league.categories.length} categorías • {league.active ? 'Activa' : 'Inactiva'}
                      </p>
                      <p className="text-xs text-slate-400">
                        Dueño: {league.ownerUserId === 'super-admin' ? 'Super Admin' : league.ownerUserId}
                      </p>
                    </button>
                  )
                })}
              </div>
            )}
          </article>

          <article className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-lg shadow-black/20">
            <h2 className="text-xl font-semibold text-white">Configuración de liga</h2>
            {!selectedLeague && <p className="mt-3 text-sm text-slate-300">Selecciona una liga para ver sus reglas.</p>}

            {selectedLeague && (
              <div className="mt-4 space-y-4">
                <div className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
                  <p className="text-sm font-semibold text-primary-200">{selectedLeague.name}</p>
                  <p className="text-xs text-slate-400">Slug: {selectedLeague.slug}</p>
                </div>

                {selectedLeague.categories.map((category) => (
                  <div key={category.id} className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
                    <p className="font-semibold text-white">{category.name}</p>
                    <p className="text-xs text-slate-300">
                      Edad: {category.minAge}-{category.maxAge === null ? 'sin límite' : category.maxAge}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      En cancha: {category.rules.playersOnField} • Minutos: {category.rules.matchMinutes} • Descanso: {category.rules.breakMinutes}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </article>
            </section>
            )}

            {authUser.role === 'super_admin' && superAdminLigasTab === 'clientes' && (
              <section className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-5">
                <h3 className="text-lg font-semibold text-white">Usuarios registrados y sus ligas</h3>
                <div className="mt-4 rounded-xl border border-cyan-300/30 bg-cyan-500/10 p-3">
                  <p className="text-sm font-semibold text-cyan-100">Tokens de acceso para clientes admin</p>
                  <div className="mt-3 grid gap-2 rounded border border-white/10 bg-slate-900/50 p-2 md:grid-cols-4">
                    <input
                      value={newClientNameDraft}
                      onChange={(event) => setNewClientNameDraft(event.target.value)}
                      placeholder="Nombre cliente"
                      className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-xs text-white"
                    />
                    <input
                      value={newClientOrganizationDraft}
                      onChange={(event) => setNewClientOrganizationDraft(event.target.value)}
                      placeholder="Empresa o liga"
                      className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-xs text-white"
                    />
                    <input
                      value={newClientEmailDraft}
                      onChange={(event) => setNewClientEmailDraft(event.target.value)}
                      placeholder="Correo cliente"
                      className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-xs text-white"
                    />
                    <div className="flex gap-2">
                      <input
                        value={newClientPasswordDraft}
                        onChange={(event) => setNewClientPasswordDraft(event.target.value)}
                        placeholder="Password (opcional)"
                        className="w-full rounded border border-white/20 bg-slate-900 px-2 py-2 text-xs text-white"
                      />
                      <button
                        type="button"
                        onClick={() => void handleCreateClientAdmin()}
                        className="rounded border border-cyan-300/50 bg-cyan-500/20 px-3 py-2 text-xs font-semibold text-cyan-100"
                      >
                        Crear
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 md:grid-cols-3">
                    <select
                      value={tokenClientUserIdDraft}
                      onChange={(event) => setTokenClientUserIdDraft(event.target.value)}
                      className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-xs text-white"
                    >
                      <option value="">Selecciona cliente</option>
                      {usersOverview
                        .filter((user) => user.role === 'client_admin' && user.active)
                        .map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.name} · {user.email}
                          </option>
                        ))}
                    </select>
                    <input
                      type="datetime-local"
                      value={tokenExpiresAtDraft}
                      onChange={(event) => setTokenExpiresAtDraft(event.target.value)}
                      className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-xs text-white"
                    />
                    <button
                      type="button"
                      onClick={() => void handleGenerateClientAccessToken()}
                      className="rounded border border-cyan-300/50 bg-cyan-500/20 px-3 py-2 text-xs font-semibold text-cyan-100"
                    >
                      Generar token
                    </button>
                  </div>
                  {generatedTokenMessage && <p className="mt-2 text-xs text-cyan-100">{generatedTokenMessage}</p>}

                  <div className="mt-3 space-y-2">
                    <ListSectionControls
                      left={(
                        <>
                          <span className="text-[11px] text-slate-300">Filtro:</span>
                          <select
                            value={tokenStatusFilter}
                            onChange={(event) => {
                              setTokenStatusFilter(event.target.value as TokenStatusFilter)
                              setTokenPage(1)
                            }}
                            className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-[11px] text-white"
                          >
                            <option value="all">Todos</option>
                            <option value="active">Activos</option>
                            <option value="expired">Caducados</option>
                          </select>
                        </>
                      )}
                      summary={
                        filteredClientAccessTokens.length === 0
                          ? '0 resultados'
                          : `${tokenPageStartIndex}-${tokenPageEndIndex} de ${filteredClientAccessTokens.length}`
                      }
                    />

                    <div className="max-h-64 space-y-2 overflow-auto">
                      {filteredClientAccessTokens.length === 0 && <p className="text-xs text-slate-300">No hay tokens para este filtro.</p>}
                      {paginatedClientAccessTokens.map((token) => {
                      const expiresAtMs = new Date(token.expiresAt).getTime()
                      const tokenIsActive = token.active && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
                      const clientOwner = usersOverview.find((user) => user.id === token.clientUserId)
                      const displayClientName = clientOwner?.name || token.clientName || 'Cliente sin nombre'
                      const displayOrganizationName = clientOwner?.organizationName || token.organizationName || ''
                      const displayClientEmail = clientOwner?.email || token.clientEmail || 'Sin correo registrado'

                      return (
                        <div
                          key={token.id}
                          className={`rounded-lg border p-3 text-xs ${tokenIsActive ? 'border-emerald-400/20 bg-emerald-900/10' : 'border-rose-400/20 bg-rose-900/10'}`}
                        >
                          {/* Cabecera: cliente + badge */}
                          <div className="mb-2 flex items-start justify-between gap-2">
                            <div>
                              <p className="font-bold text-white leading-tight">{displayClientName}</p>
                              {displayOrganizationName && displayOrganizationName !== displayClientName && (
                                <p className="text-[11px] text-slate-400">{displayOrganizationName}</p>
                              )}
                              <p className="text-[11px] text-slate-400">{displayClientEmail}</p>
                            </div>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${tokenIsActive ? 'bg-emerald-500/25 text-emerald-300' : 'bg-rose-500/25 text-rose-300'}`}>
                              {tokenIsActive ? 'Activo' : 'Caducado'}
                            </span>
                          </div>

                          {/* Token + vencimiento */}
                          <div className="mb-2 rounded bg-black/30 px-2 py-1.5">
                            <p className="break-all font-mono text-[10px] text-slate-300">{token.token}</p>
                            <p className={`mt-0.5 text-[10px] ${tokenIsActive ? 'text-slate-400' : 'text-rose-300'}`}>
                              {tokenIsActive ? 'Vence:' : 'Venció:'} {new Date(token.expiresAt).toLocaleString()}
                            </p>
                          </div>

                          {/* Acciones */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              type="button"
                              onClick={() => void handleRenewClientAccessToken(token.id)}
                              className="rounded border border-cyan-300/40 bg-cyan-500/20 px-2.5 py-1 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-500/30 transition"
                            >
                              Renovar 30 días
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setRenewingTokenId((current) => (current === token.id ? '' : token.id))
                                setRenewTokenExpiresAtDraft(toDateTimeLocalValue(token.expiresAt))
                              }}
                              className="rounded border border-amber-300/40 bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-500/30 transition"
                            >
                              Renovar con fecha
                            </button>
                            {tokenIsActive && (
                              <button
                                type="button"
                                onClick={() => void handleRevokeClientAccessToken(token.id)}
                                className="rounded border border-rose-300/40 bg-rose-500/20 px-2.5 py-1 text-[11px] font-semibold text-rose-100 hover:bg-rose-500/30 transition"
                              >
                                Caducar
                              </button>
                            )}
                          </div>

                          {renewingTokenId === token.id && (
                            <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-white/10 bg-slate-950/40 p-2">
                              <input
                                type="datetime-local"
                                value={renewTokenExpiresAtDraft}
                                onChange={(event) => setRenewTokenExpiresAtDraft(event.target.value)}
                                className="rounded border border-white/20 bg-slate-900 px-2 py-1.5 text-[11px] text-white"
                              />
                              <button
                                type="button"
                                onClick={() => void handleRenewClientAccessToken(token.id, renewTokenExpiresAtDraft)}
                                className="rounded border border-cyan-300/40 bg-cyan-500/20 px-2.5 py-1 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-500/30 transition"
                              >
                                Aplicar fecha
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setRenewingTokenId('')
                                  setRenewTokenExpiresAtDraft('')
                                }}
                                className="rounded border border-white/20 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-slate-200 hover:bg-white/10 transition"
                              >
                                Cancelar
                              </button>
                            </div>
                          )}
                        </div>
                      )
                    })}

                    </div>

                    {filteredClientAccessTokens.length > TOKEN_PAGE_SIZE && (
                      <PaginationControls
                        className="mt-2"
                        currentPage={tokenPage}
                        totalPages={tokenTotalPages}
                        onPrev={() => setTokenPage((current) => Math.max(1, current - 1))}
                        onNext={() => setTokenPage((current) => Math.min(tokenTotalPages, current + 1))}
                      />
                    )}
                  </div>
                </div>

                <div className="mt-4 rounded-xl border border-amber-300/30 bg-amber-500/10 p-3">
                  <p className="text-sm font-semibold text-amber-100">Gestión de clientes admin</p>
                  <ListSectionControls
                    className="mt-2"
                    left={(
                      <>
                        <span className="text-[11px] text-slate-300">Filtro:</span>
                        <select
                          value={clientAdminStatusFilter}
                          onChange={(event) => {
                            setClientAdminStatusFilter(event.target.value as ClientAdminStatusFilter)
                            setClientAdminPage(1)
                          }}
                          className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-[11px] text-white"
                        >
                          <option value="all">Todos</option>
                          <option value="active">Activos</option>
                          <option value="inactive">Inactivos</option>
                        </select>
                      </>
                    )}
                    summary={
                      filteredClientAdminUsers.length === 0
                        ? '0 resultados'
                        : `${clientAdminPageStartIndex}-${clientAdminPageEndIndex} de ${filteredClientAdminUsers.length}`
                    }
                  />
                  <div className="mt-3 overflow-auto rounded border border-white/10">
                    <table className="min-w-full text-xs text-slate-200">
                      <thead className="bg-slate-900/70 text-slate-300">
                        <tr>
                          <th className="px-2 py-2 text-left">Nombre</th>
                          <th className="px-2 py-2 text-left">Empresa/Liga</th>
                          <th className="px-2 py-2 text-left">Correo</th>
                          <th className="px-2 py-2 text-left">Estado</th>
                          <th className="px-2 py-2 text-left">Acciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredClientAdminUsers.length === 0 && (
                          <tr className="border-t border-white/10 bg-slate-900/40">
                            <td colSpan={5} className="px-2 py-3 text-slate-400">Sin clientes para este filtro.</td>
                          </tr>
                        )}

                        {paginatedClientAdminUsers.map((client) => {
                            const isEditing = editingClientId === client.id

                            return (
                              <tr key={`client-admin-${client.id}`} className="border-t border-white/10 bg-slate-900/40">
                                <td className="px-2 py-2">
                                  {isEditing ? (
                                    <input
                                      value={editClientNameDraft}
                                      onChange={(event) => setEditClientNameDraft(event.target.value)}
                                      className="w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                                    />
                                  ) : (
                                    <span className="font-semibold text-white">{client.name}</span>
                                  )}
                                </td>
                                <td className="px-2 py-2">
                                  {isEditing ? (
                                    <input
                                      value={editClientOrganizationDraft}
                                      onChange={(event) => setEditClientOrganizationDraft(event.target.value)}
                                      className="w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                                    />
                                  ) : (
                                    <span>{client.organizationName ?? '-'}</span>
                                  )}
                                </td>
                                <td className="px-2 py-2">
                                  {isEditing ? (
                                    <input
                                      value={editClientEmailDraft}
                                      onChange={(event) => setEditClientEmailDraft(event.target.value)}
                                      className="w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                                    />
                                  ) : (
                                    <span>{client.email}</span>
                                  )}
                                </td>
                                <td className="px-2 py-2">
                                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${client.active ? 'bg-emerald-500/20 text-emerald-100' : 'bg-rose-500/20 text-rose-100'}`}>
                                    {client.active ? 'Activo' : 'Inactivo'}
                                  </span>
                                </td>
                                <td className="px-2 py-2">
                                  <div className="flex flex-wrap items-center gap-1">
                                    {isEditing ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => void saveEditClientAdmin()}
                                          className="rounded border border-cyan-300/40 bg-cyan-500/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-100"
                                        >
                                          Guardar
                                        </button>
                                        <button
                                          type="button"
                                          onClick={cancelEditClientAdmin}
                                          className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-200"
                                        >
                                          Cancelar
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => beginEditClientAdmin(client)}
                                        className="rounded border border-cyan-300/40 bg-cyan-500/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-100"
                                      >
                                        Editar
                                      </button>
                                    )}

                                    <button
                                      type="button"
                                      onClick={() => void toggleClientAdminActive(client)}
                                      className={`rounded border px-2 py-0.5 text-[10px] font-semibold ${
                                        client.active
                                          ? 'border-rose-300/40 bg-rose-500/20 text-rose-100'
                                          : 'border-emerald-300/40 bg-emerald-500/20 text-emerald-100'
                                      }`}
                                    >
                                      {client.active ? 'Desactivar' : 'Reactivar'}
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => void regenerateClientTemporaryPassword(client)}
                                      className="rounded border border-amber-300/40 bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-100"
                                    >
                                      Regenerar contraseña temporal
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                      </tbody>
                    </table>
                  </div>

                  {filteredClientAdminUsers.length > CLIENT_ADMIN_PAGE_SIZE && (
                    <PaginationControls
                      className="mt-2"
                      currentPage={clientAdminPage}
                      totalPages={clientAdminTotalPages}
                      onPrev={() => setClientAdminPage((current) => Math.max(1, current - 1))}
                      onNext={() => setClientAdminPage((current) => Math.min(clientAdminTotalPages, current + 1))}
                    />
                  )}
                </div>

                <div className="mt-3 rounded-xl border border-white/10 p-3">
                  <ListSectionControls
                    left={(
                      <>
                        <span className="text-[11px] text-slate-300">Buscar:</span>
                        <input
                          value={publicRowsQuery}
                          onChange={(event) => {
                            setPublicRowsQuery(event.target.value)
                            setPublicRowsPage(1)
                          }}
                          placeholder="Cliente, empresa, correo o liga"
                          className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-[11px] text-white placeholder:text-slate-500"
                        />
                      </>
                    )}
                    summary={
                      filteredSuperAdminPublicRows.length === 0
                        ? '0 resultados'
                        : `${publicRowsPageStartIndex}-${publicRowsPageEndIndex} de ${filteredSuperAdminPublicRows.length}`
                    }
                  />

                  <div className="mt-3 overflow-auto rounded border border-white/10">
                  <table className="min-w-full text-xs text-slate-200">
                    <thead className="bg-slate-900/80 text-slate-300">
                      <tr>
                        <th className="px-3 py-2 text-left">Cliente</th>
                        <th className="px-3 py-2 text-left">Empresa/Liga</th>
                        <th className="px-3 py-2 text-left">Correo</th>
                        <th className="px-3 py-2 text-left">Liga</th>
                        <th className="px-3 py-2 text-left">Link público cliente</th>
                        <th className="px-3 py-2 text-left">Link público liga</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSuperAdminPublicRows.length === 0 && (
                        <tr className="border-t border-white/10 bg-slate-900/40">
                          <td colSpan={6} className="px-3 py-3 text-slate-400">
                            Sin resultados para esta búsqueda.
                          </td>
                        </tr>
                      )}

                      {paginatedSuperAdminPublicRows.map((row) => (
                        <tr key={row.rowId} className="border-t border-white/10 bg-slate-900/40">
                          <td className="px-3 py-2 font-semibold text-white">{row.clientName}</td>
                          <td className="px-3 py-2">{row.companyOrLeague}</td>
                          <td className="px-3 py-2">{row.email}</td>
                          <td className="px-3 py-2">{row.leagueName}</td>
                          <td className="px-3 py-2">
                            {row.clientLink === '-' ? (
                              <span className="text-slate-500">-</span>
                            ) : (
                              <div className="flex flex-wrap items-center gap-2">
                                <a href={row.clientLink} target="_blank" rel="noreferrer" className="text-cyan-200 hover:underline">
                                  {row.clientLink}
                                </a>
                                <button
                                  type="button"
                                  onClick={() => void handleCopyPublicLink(row.clientLink)}
                                  className="rounded border border-cyan-300/40 bg-cyan-500/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-100"
                                >
                                  Copiar
                                </button>
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {row.leagueLink === '-' ? (
                              <span className="text-slate-500">-</span>
                            ) : (
                              <div className="flex flex-wrap items-center gap-2">
                                <a href={row.leagueLink} target="_blank" rel="noreferrer" className="text-cyan-200 hover:underline">
                                  {row.leagueLink}
                                </a>
                                <button
                                  type="button"
                                  onClick={() => void handleCopyPublicLink(row.leagueLink)}
                                  className="rounded border border-cyan-300/40 bg-cyan-500/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-100"
                                >
                                  Copiar
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>

                  {filteredSuperAdminPublicRows.length > PUBLIC_ROWS_PAGE_SIZE && (
                    <PaginationControls
                      className="mt-2"
                      currentPage={publicRowsPage}
                      totalPages={publicRowsTotalPages}
                      onPrev={() => setPublicRowsPage((current) => Math.max(1, current - 1))}
                      onNext={() => setPublicRowsPage((current) => Math.min(publicRowsTotalPages, current + 1))}
                    />
                  )}
                </div>
              </section>
            )}
          </>
        )}

        {adminView === 'gestion' && (
          <AdminTeamsPanel
            key={selectedLeague?.id ?? 'no-league'}
            leagues={leagues}
            selectedLeague={selectedLeague}
            onLeaguesReload={loadLeagues}
            onLeagueSelect={handleSelectLeague}
          />
        )}

        {adminView === 'configuracion' && (
          <section className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-white">Configuración del campeonato</h3>
              {selectedLeague && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-300">Categoría</span>
                  <select
                    value={matchCategoryId}
                    onChange={(event) => {
                      setMatchCategoryId(event.target.value)
                      resetMatchSelection()
                    }}
                    className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
                  >
                    <option value="" disabled>
                      Selecciona categoría
                    </option>
                    {selectedLeague.categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {!selectedLeague && <p className="mt-3 text-sm text-slate-300">Selecciona una liga para configurar el campeonato.</p>}

            {selectedLeague && !hasExplicitMatchCategory && (
              <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/60 p-4 text-sm text-slate-300">
                Selecciona primero una categoría para editar la configuración global del campeonato.
              </div>
            )}

            {selectedLeague && hasExplicitMatchCategory && (
              <div className="mt-4 rounded border border-white/10 bg-slate-900/60 p-4">
                <p className="text-xs font-semibold text-white">Esta configuración aplica para todo el campeonato de la categoría seleccionada.</p>

                <div className="mt-3 grid gap-2 md:grid-cols-3">
                  <label className="text-xs text-slate-300">
                    Jugadoras en cancha
                    <input
                      type="number"
                      min={5}
                      max={11}
                      value={settingsDraft.playersOnField}
                      onChange={(event) => setSettingsDraft((current) => ({ ...current, playersOnField: Number(event.target.value) || 5 }))}
                      className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white"
                    />
                  </label>
                  <label className="text-xs text-slate-300">
                    Minutos de juego
                    <input
                      type="number"
                      min={20}
                      max={120}
                      value={settingsDraft.matchMinutes}
                      onChange={(event) => setSettingsDraft((current) => ({ ...current, matchMinutes: Number(event.target.value) || 20 }))}
                      className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white"
                    />
                  </label>
                  <label className="text-xs text-slate-300">
                    Descanso (min)
                    <input
                      type="number"
                      min={0}
                      max={30}
                      value={settingsDraft.breakMinutes}
                      onChange={(event) => setSettingsDraft((current) => ({ ...current, breakMinutes: Number(event.target.value) || 0 }))}
                      className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white"
                    />
                  </label>
                </div>

                <div className="mt-3 grid gap-2 md:grid-cols-4">
                  <label className="text-xs text-slate-300">
                    Puntos ganar
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={competitionRulesDraft.pointsWin}
                      onChange={(event) =>
                        setCompetitionRulesDraft((current) => ({ ...current, pointsWin: Number(event.target.value) || 0 }))
                      }
                      className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white"
                    />
                  </label>
                  <label className="text-xs text-slate-300">
                    Puntos empate
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={competitionRulesDraft.pointsDraw}
                      onChange={(event) =>
                        setCompetitionRulesDraft((current) => ({ ...current, pointsDraw: Number(event.target.value) || 0 }))
                      }
                      className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white"
                    />
                  </label>
                  <label className="text-xs text-slate-300">
                    Puntos perder
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={competitionRulesDraft.pointsLoss}
                      onChange={(event) =>
                        setCompetitionRulesDraft((current) => ({ ...current, pointsLoss: Number(event.target.value) || 0 }))
                      }
                      className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white"
                    />
                  </label>
                  <label className="text-xs text-slate-300">
                    Clasifican a fase final
                    <input
                      type="number"
                      min={2}
                      max={32}
                      value={competitionRulesDraft.playoffQualifiedTeams}
                      onChange={(event) =>
                        setCompetitionRulesDraft((current) => ({
                          ...current,
                          playoffQualifiedTeams: Number(event.target.value) || 2,
                        }))
                      }
                      className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white"
                    />
                  </label>
                </div>

                <div className="mt-3 grid gap-2 md:grid-cols-3">
                  <label className="text-xs text-slate-300">
                    Fechas fase regular
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={competitionRulesDraft.regularSeasonRounds}
                      onChange={(event) =>
                        setCompetitionRulesDraft((current) => ({
                          ...current,
                          regularSeasonRounds: Number(event.target.value) || 1,
                        }))
                      }
                      className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white"
                    />
                  </label>

                  <label className="text-xs text-slate-300">
                    Número de canchas
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={competitionRulesDraft.courtsCount}
                      onChange={(event) =>
                        setCompetitionRulesDraft((current) => ({
                          ...current,
                          courtsCount: Math.max(1, Number(event.target.value) || 1),
                        }))
                      }
                      className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white"
                    />
                  </label>

                  <label className="text-xs text-slate-300">
                    Máximo jugadoras inscritas
                    <input
                      type="number"
                      min={5}
                      max={60}
                      value={competitionRulesDraft.maxRegisteredPlayers}
                      onChange={(event) =>
                        setCompetitionRulesDraft((current) => ({
                          ...current,
                          maxRegisteredPlayers: Math.max(5, Number(event.target.value) || 5),
                        }))
                      }
                      className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white"
                    />
                  </label>

                  <label className="flex items-center gap-2 rounded border border-white/10 px-2 py-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      checked={competitionRulesDraft.doubleRoundRobin}
                      onChange={(event) =>
                        setCompetitionRulesDraft((current) => ({ ...current, doubleRoundRobin: event.target.checked }))
                      }
                    />
                    Liga ida y vuelta
                  </label>

                </div>

                <div className="mt-3 rounded border border-white/10 bg-slate-900/40 p-3">
                  <p className="text-xs font-semibold text-white">Fase final (configurable durante el campeonato)</p>
                  <div className="mt-2 grid gap-2 md:grid-cols-3">
                    <label className="flex items-center gap-2 rounded border border-white/10 px-2 py-2 text-xs text-slate-200">
                      <input
                        type="checkbox"
                        checked={competitionRulesDraft.finalStageRoundOf16Enabled}
                        onChange={(event) =>
                          setCompetitionRulesDraft((current) => ({ ...current, finalStageRoundOf16Enabled: event.target.checked }))
                        }
                      />
                      16avos
                    </label>
                    <label className="flex items-center gap-2 rounded border border-white/10 px-2 py-2 text-xs text-slate-200">
                      <input
                        type="checkbox"
                        checked={competitionRulesDraft.finalStageRoundOf8Enabled}
                        onChange={(event) =>
                          setCompetitionRulesDraft((current) => ({ ...current, finalStageRoundOf8Enabled: event.target.checked }))
                        }
                      />
                      8vos
                    </label>
                    <label className="flex items-center gap-2 rounded border border-white/10 px-2 py-2 text-xs text-slate-200">
                      <input
                        type="checkbox"
                        checked={competitionRulesDraft.finalStageQuarterFinalsEnabled}
                        onChange={(event) =>
                          setCompetitionRulesDraft((current) => ({ ...current, finalStageQuarterFinalsEnabled: event.target.checked }))
                        }
                      />
                      4tos
                    </label>
                    <label className="flex items-center gap-2 rounded border border-white/10 px-2 py-2 text-xs text-slate-200">
                      <input
                        type="checkbox"
                        checked={competitionRulesDraft.finalStageSemiFinalsEnabled}
                        onChange={(event) =>
                          setCompetitionRulesDraft((current) => ({ ...current, finalStageSemiFinalsEnabled: event.target.checked }))
                        }
                      />
                      Semifinales
                    </label>
                    <label className="flex items-center gap-2 rounded border border-white/10 px-2 py-2 text-xs text-slate-200">
                      <input
                        type="checkbox"
                        checked={competitionRulesDraft.finalStageFinalEnabled}
                        onChange={(event) =>
                          setCompetitionRulesDraft((current) => ({ ...current, finalStageFinalEnabled: event.target.checked }))
                        }
                      />
                      Final
                    </label>
                  </div>

                  <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                    <label className="text-xs text-slate-300">
                      Modalidad 16avos
                      <select
                        value={competitionRulesDraft.finalStageRoundOf16TwoLegged ? 'home-away' : 'single'}
                        disabled={!competitionRulesDraft.finalStageRoundOf16Enabled}
                        onChange={(event) =>
                          setCompetitionRulesDraft((current) => ({
                            ...current,
                            finalStageRoundOf16TwoLegged: event.target.value === 'home-away',
                          }))
                        }
                        className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white disabled:opacity-50"
                      >
                        <option value="single">Única</option>
                        <option value="home-away">Ida y vuelta</option>
                      </select>
                    </label>

                    <label className="text-xs text-slate-300">
                      Modalidad 8vos
                      <select
                        value={competitionRulesDraft.finalStageRoundOf8TwoLegged ? 'home-away' : 'single'}
                        disabled={!competitionRulesDraft.finalStageRoundOf8Enabled}
                        onChange={(event) =>
                          setCompetitionRulesDraft((current) => ({
                            ...current,
                            finalStageRoundOf8TwoLegged: event.target.value === 'home-away',
                          }))
                        }
                        className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white disabled:opacity-50"
                      >
                        <option value="single">Única</option>
                        <option value="home-away">Ida y vuelta</option>
                      </select>
                    </label>

                    <label className="text-xs text-slate-300">
                      Modalidad 4tos
                      <select
                        value={competitionRulesDraft.finalStageQuarterFinalsTwoLegged ? 'home-away' : 'single'}
                        disabled={!competitionRulesDraft.finalStageQuarterFinalsEnabled}
                        onChange={(event) =>
                          setCompetitionRulesDraft((current) => ({
                            ...current,
                            finalStageQuarterFinalsTwoLegged: event.target.value === 'home-away',
                          }))
                        }
                        className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white disabled:opacity-50"
                      >
                        <option value="single">Única</option>
                        <option value="home-away">Ida y vuelta</option>
                      </select>
                    </label>

                    <label className="text-xs text-slate-300">
                      Modalidad semifinales
                      <select
                        value={competitionRulesDraft.finalStageSemiFinalsTwoLegged ? 'home-away' : 'single'}
                        disabled={!competitionRulesDraft.finalStageSemiFinalsEnabled}
                        onChange={(event) =>
                          setCompetitionRulesDraft((current) => ({
                            ...current,
                            finalStageSemiFinalsTwoLegged: event.target.value === 'home-away',
                          }))
                        }
                        className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white disabled:opacity-50"
                      >
                        <option value="single">Única</option>
                        <option value="home-away">Ida y vuelta</option>
                      </select>
                    </label>

                    <label className="text-xs text-slate-300">
                      Modalidad final
                      <select
                        value={competitionRulesDraft.finalStageFinalTwoLegged ? 'home-away' : 'single'}
                        disabled={!competitionRulesDraft.finalStageFinalEnabled}
                        onChange={(event) =>
                          setCompetitionRulesDraft((current) => ({
                            ...current,
                            finalStageFinalTwoLegged: event.target.value === 'home-away',
                          }))
                        }
                        className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-white disabled:opacity-50"
                      >
                        <option value="single">Única</option>
                        <option value="home-away">Ida y vuelta</option>
                      </select>
                    </label>
                  </div>

                  <p className="mt-2 text-[11px] text-slate-400">
                    Los fixtures de fase final (fecha/cancha) se editan en la pestaña Partidos y pueden modificarse durante el campeonato.
                  </p>
                </div>

                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <label className="flex items-center gap-2 rounded border border-white/10 px-2 py-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      checked={competitionRulesDraft.allowDraws}
                      onChange={(event) =>
                        setCompetitionRulesDraft((current) => ({ ...current, allowDraws: event.target.checked }))
                      }
                    />
                    Permitir empate en tiempo regular
                  </label>
                  <label className="flex items-center gap-2 rounded border border-white/10 px-2 py-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      checked={competitionRulesDraft.resolveDrawByPenalties}
                      onChange={(event) =>
                        setCompetitionRulesDraft((current) => ({
                          ...current,
                          resolveDrawByPenalties: event.target.checked,
                        }))
                      }
                    />
                    Resolver empate con penales en fase final
                  </label>
                </div>

                <div className="mt-3">
                  <button
                    type="button"
                    onClick={saveSettings}
                    disabled={savingSettings}
                    className="rounded-lg border border-primary-300/50 bg-primary-500/20 px-4 py-2 text-sm font-semibold text-primary-100 hover:bg-primary-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {savingSettings ? 'Guardando configuración...' : 'Modificar configuración del campeonato'}
                  </button>
                </div>

                {adminMessage && <p className="mt-3 text-sm text-primary-200">{adminMessage}</p>}
              </div>
            )}
          </section>
        )}

        {adminView === 'auditoria' && authUser.role === 'super_admin' && (
          <section className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-5">
            <h3 className="text-lg font-semibold text-white">Auditoría de accesos</h3>
            <p className="mt-1 text-xs text-slate-300">Registros de login, fallos de acceso y cierres de sesión.</p>

            {auditLogs.length === 0 ? (
              <p className="mt-4 text-sm text-slate-300">Sin eventos de auditoría registrados.</p>
            ) : (
              <div className="mt-4 overflow-auto">
                <table className="min-w-full text-xs text-slate-200">
                  <thead>
                    <tr className="border-b border-white/10 text-slate-400">
                      <th className="px-2 py-2 text-left">Fecha</th>
                      <th className="px-2 py-2 text-left">Usuario</th>
                      <th className="px-2 py-2 text-left">Acción</th>
                      <th className="px-2 py-2 text-left">IP</th>
                      <th className="px-2 py-2 text-left">Detalle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditPagination.pageItems.map((log) => (
                      <tr key={log.id} className="border-b border-white/5">
                        <td className="px-2 py-2">{new Date(log.timestamp).toLocaleString()}</td>
                        <td className="px-2 py-2">{log.userEmail}</td>
                        <td className="px-2 py-2">{log.action}</td>
                        <td className="px-2 py-2">{log.ip}</td>
                        <td className="px-2 py-2">{log.details ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {auditPagination.totalPages > 1 && (
                  <div className="mt-3 flex items-center justify-end gap-2 text-xs text-slate-300">
                    <button
                      type="button"
                      disabled={auditPagination.currentPage === 1}
                      onClick={() => setAuditPage((current) => Math.max(current - 1, 1))}
                      className="rounded border border-white/20 px-2 py-1 disabled:opacity-50"
                    >
                      Anterior
                    </button>
                    <span>Página {auditPagination.currentPage} / {auditPagination.totalPages}</span>
                    <button
                      type="button"
                      disabled={auditPagination.currentPage === auditPagination.totalPages}
                      onClick={() => setAuditPage((current) => Math.min(current + 1, auditPagination.totalPages))}
                      className="rounded border border-white/20 px-2 py-1 disabled:opacity-50"
                    >
                      Siguiente
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {adminView === 'partidos' && (
          <section className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-white">Partidos de la liga seleccionada</h3>
              {selectedLeague && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-300">Categoría</span>
                  <select
                    value={matchCategoryId}
                    onChange={(event) => {
                      setMatchCategoryId(event.target.value)
                      resetMatchSelection()
                    }}
                    className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
                  >
                    <option value="" disabled>
                      Selecciona categoría
                    </option>
                    {selectedLeague.categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {!selectedLeague && <p className="mt-3 text-sm text-slate-300">Selecciona una liga para gestionar partidos.</p>}

            {selectedLeague && !hasExplicitMatchCategory && (
              <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/60 p-4 text-sm text-slate-300">
                Selecciona primero una categoría para mostrar pendientes, jugados y el flujo de inicio de partido.
              </div>
            )}

            {selectedLeague && hasExplicitMatchCategory && (
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                {matchesTab === 'finales' && (
                  <div className="rounded-xl border border-primary-300/30 bg-primary-500/10 p-4 lg:col-span-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-primary-100">Cuadro de fase final</p>
                        <p className="text-xs text-slate-300">
                          Clasificados: {finalQualifiedTeams.length} · Primera ronda: {getRoundLabel(firstFinalRoundNumber)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void generateFinalBracketFirstRound()}
                        disabled={finalFirstRoundPairings.length === 0}
                        className="rounded border border-primary-300/40 bg-primary-500/30 px-3 py-1 text-xs font-semibold text-primary-50 hover:bg-primary-500/40 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Generar primera ronda
                      </button>
                    </div>

                    <div className="mt-3 grid gap-3 lg:grid-cols-3">
                      <div className="rounded border border-white/10 bg-slate-900/60 p-3">
                        <p className="text-xs font-semibold text-white">Lado A (arrastra para ordenar)</p>
                        <div className="mt-2 space-y-2">
                          {finalsLeftSeedTeamIds.map((teamId, index) => {
                            const team = teamsById.get(teamId)
                            return (
                              <div
                                key={`left-seed-${teamId}-${index}`}
                                draggable
                                onDragStart={(event) => onDragStartFinalSeed(event, teamId)}
                                onDragEnd={() => setDraggingFinalSeedTeamId('')}
                                onDragOver={onAllowFinalSeedDrop}
                                onDrop={(event) => onDropFinalSeed(event, 'left', index)}
                                className={`cursor-move rounded border px-2 py-2 text-xs ${
                                  draggingFinalSeedTeamId === teamId
                                    ? 'border-primary-300/60 bg-primary-500/20 text-primary-100'
                                    : 'border-white/10 bg-slate-800 text-slate-200'
                                }`}
                              >
                                {index + 1}. {team?.name ?? 'Equipo'}
                              </div>
                            )
                          })}
                        </div>
                      </div>

                      <div className="rounded border border-white/10 bg-slate-900/60 p-3">
                        <p className="text-xs font-semibold text-white">Emparejamientos</p>
                        <div className="mt-2 space-y-2">
                          {finalFirstRoundPairings.length === 0 && (
                            <p className="text-xs text-slate-400">No hay cruces disponibles.</p>
                          )}
                          {finalFirstRoundPairings.map((pairing) => {
                            const homeName = teamsById.get(pairing.homeTeamId)?.name ?? 'Equipo A'
                            const awayName = teamsById.get(pairing.awayTeamId)?.name ?? 'Equipo B'
                            return (
                              <div key={pairing.matchId} className="rounded border border-white/10 bg-slate-800 px-2 py-2 text-xs text-slate-200">
                                <p className="font-semibold text-white">Llave {pairing.order}</p>
                                <p>{homeName} vs {awayName}</p>
                              </div>
                            )
                          })}
                        </div>
                      </div>

                      <div className="rounded border border-white/10 bg-slate-900/60 p-3">
                        <p className="text-xs font-semibold text-white">Lado B (arrastra para ordenar)</p>
                        <div className="mt-2 space-y-2">
                          {finalsRightSeedTeamIds.map((teamId, index) => {
                            const team = teamsById.get(teamId)
                            return (
                              <div
                                key={`right-seed-${teamId}-${index}`}
                                draggable
                                onDragStart={(event) => onDragStartFinalSeed(event, teamId)}
                                onDragEnd={() => setDraggingFinalSeedTeamId('')}
                                onDragOver={onAllowFinalSeedDrop}
                                onDrop={(event) => onDropFinalSeed(event, 'right', index)}
                                className={`cursor-move rounded border px-2 py-2 text-xs ${
                                  draggingFinalSeedTeamId === teamId
                                    ? 'border-primary-300/60 bg-primary-500/20 text-primary-100'
                                    : 'border-white/10 bg-slate-800 text-slate-200'
                                }`}
                              >
                                {index + 1}. {team?.name ?? 'Equipo'}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 overflow-x-auto">
                      <div className="flex min-w-max gap-3">
                        {finalBracketStages.map((stage) => (
                          <div key={`stage-${stage.roundBase}`} className="w-64 rounded border border-white/10 bg-slate-900/60 p-3">
                            <p className="text-xs font-semibold text-white">{stage.title}</p>
                            <div className="mt-2 space-y-2">
                              {stage.matches.map((match, index) => (
                                <div key={match.key} className="rounded border border-white/10 bg-slate-800 p-2 text-xs text-slate-200">
                                  <p className="font-semibold text-white">Llave {index + 1}</p>
                                  <p>{match.homeLabel}</p>
                                  <p>{match.awayLabel}</p>
                                  <p className="mt-1 text-[11px] text-slate-300">Resultado: {match.resultLabel}</p>
                                  <p className="text-[11px] text-emerald-200">Avanza: {match.winnerLabel}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                <div className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-white">Pendientes por jugar</p>
                    {hasFinalRoundTabs && (
                      <div className="flex items-center gap-1 rounded border border-white/10 bg-slate-900/70 p-1">
                        <button
                          type="button"
                          onClick={() => setMatchesTab('regular')}
                          className={`rounded px-2 py-1 text-[10px] font-semibold ${matchesTab === 'regular' ? 'bg-primary-500/30 text-primary-100' : 'text-slate-300'}`}
                        >
                          Rondas regulares
                        </button>
                        <button
                          type="button"
                          onClick={() => setMatchesTab('finales')}
                          className={`rounded px-2 py-1 text-[10px] font-semibold ${matchesTab === 'finales' ? 'bg-primary-500/30 text-primary-100' : 'text-slate-300'}`}
                        >
                          Rondas finales
                        </button>
                      </div>
                    )}
                    {pendingRoundsScoped.length > 0 && (
                      <select
                        value={activePendingRoundScoped ? String(activePendingRoundScoped) : ''}
                        onChange={(event) => {
                          setSelectedPendingRound(event.target.value)
                          setSelectedPendingMatchId('')
                          setFixtureDateDraft('')
                        }}
                        className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                      >
                        {pendingRoundsScoped.map((round) => (
                          <option key={round} value={round}>
                            {getRoundLabel(round)}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Paso 1: selecciona fecha · Paso 2: selecciona partido · Paso 3: arma titulares e inicia live.
                  </p>
                  <div className="mt-2 max-h-52 space-y-2 overflow-auto pr-1 text-xs text-slate-200">
                    {pendingMatchesByRoundScoped.length === 0 && <p className="text-slate-400">No hay pendientes en esta fecha.</p>}
                    {pendingMatchesByRoundScoped.map((match) => {
                      const homeTeam = teamsById.get(match.homeTeamId)
                      const awayTeam = teamsById.get(match.awayTeamId)
                      const home = homeTeam?.name ?? 'Local'
                      const away = awayTeam?.name ?? 'Visitante'
                      const active = selectedPendingMatchId === match.id
                      const scheduledAt = fixtureDatesMap[match.id]
                      const venue = fixtureVenuesMap[match.id]

                      return (
                        <button
                          key={match.id}
                          type="button"
                          onClick={() => {
                            setSelectedPendingMatchId(match.id)
                            setSelectedPendingRound(String(match.round))
                            setSelectedPlayedMatchId('')
                            setFixtureDateDraft(fixtureDatesMap[match.id] ?? '')
                            setFixtureVenueDraft(fixtureVenuesMap[match.id] ?? '')
                          }}
                          className={`block w-full rounded border px-2 py-2 text-left ${
                            active
                              ? 'border-primary-300/60 bg-primary-500/20'
                              : 'border-white/10 bg-slate-800 hover:border-white/20'
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            {homeTeam?.logoUrl ? (
                              <img src={homeTeam.logoUrl} alt={home} className="h-5 w-5 rounded border border-white/20 bg-white object-contain p-0.5" />
                            ) : (
                              <span className="flex h-5 w-5 items-center justify-center rounded border border-white/20 text-[10px] text-slate-400">L</span>
                            )}
                            <span>{home}</span>
                            <span className="text-slate-400">vs</span>
                            {awayTeam?.logoUrl ? (
                              <img src={awayTeam.logoUrl} alt={away} className="h-5 w-5 rounded border border-white/20 bg-white object-contain p-0.5" />
                            ) : (
                              <span className="flex h-5 w-5 items-center justify-center rounded border border-white/20 text-[10px] text-slate-400">V</span>
                            )}
                            <span>{away}</span>
                          </span>
                          <span className="ml-1">· {getRoundLabel(match.round)}</span>
                          {scheduledAt && <span className="ml-1 text-[11px] text-slate-400">• {new Date(scheduledAt).toLocaleString()}</span>}
                          {venue && <span className="ml-1 text-[11px] text-slate-400">• {venue}</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
                  <p className="text-sm font-semibold text-white">Jugados</p>
                  <div className="mt-2 max-h-52 space-y-2 overflow-auto pr-1 text-xs text-slate-200">
                    {playedMatchesScoped.length === 0 && <p className="text-slate-400">No hay partidos jugados guardados.</p>}
                    {playedMatchesScoped.map((match) => {
                      const homeTeam = teamsById.get(match.homeTeamId)
                      const awayTeam = teamsById.get(match.awayTeamId)
                      const home = homeTeam?.name ?? 'Local'
                      const away = awayTeam?.name ?? 'Visitante'
                      const active = selectedPlayedMatchId === match.id
                      const record = playedMatchesMap[match.id]
                      const score = record ? `${record.homeStats.goals} - ${record.awayStats.goals}` : '-'
                      const penaltyLabel = record?.penaltyShootout
                        ? `Penales ${record.penaltyShootout.home}-${record.penaltyShootout.away}`
                        : ''
                      const scheduledAt = fixtureDatesMap[match.id]
                      const venue = fixtureVenuesMap[match.id]

                      return (
                        <button
                          key={match.id}
                          type="button"
                          onClick={() => {
                            setSelectedPlayedMatchId(match.id)
                            setSelectedPendingMatchId('')
                            setFixtureDateDraft('')
                            setFixtureVenueDraft('')
                          }}
                          className={`block w-full rounded border px-2 py-2 text-left ${
                            active
                              ? 'border-primary-300/60 bg-primary-500/20'
                              : 'border-white/10 bg-slate-800 hover:border-white/20'
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            {homeTeam?.logoUrl ? (
                              <img src={homeTeam.logoUrl} alt={home} className="h-5 w-5 rounded border border-white/20 bg-white object-contain p-0.5" />
                            ) : (
                              <span className="flex h-5 w-5 items-center justify-center rounded border border-white/20 text-[10px] text-slate-400">L</span>
                            )}
                            <span>{home}</span>
                            <span className="text-slate-400">vs</span>
                            {awayTeam?.logoUrl ? (
                              <img src={awayTeam.logoUrl} alt={away} className="h-5 w-5 rounded border border-white/20 bg-white object-contain p-0.5" />
                            ) : (
                              <span className="flex h-5 w-5 items-center justify-center rounded border border-white/20 text-[10px] text-slate-400">V</span>
                            )}
                            <span>{away}</span>
                          </span>
                          <span className="ml-1">· {getRoundLabel(match.round)}</span>
                          <div className="mt-1 text-[11px]">
                            <span className="font-semibold text-white">Marcador: {score}</span>
                            {penaltyLabel && <span className="ml-2 text-amber-200">{penaltyLabel}</span>}
                          </div>
                          {scheduledAt && <span className="ml-1 text-[11px] text-slate-400">• {new Date(scheduledAt).toLocaleString()}</span>}
                          {venue && <span className="ml-1 text-[11px] text-slate-400">• {venue}</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {selectedPendingMatchScoped && (
                  <div className="rounded-xl border border-emerald-300/30 bg-emerald-500/10 p-3 lg:col-span-2">
                    <p className="text-sm font-semibold text-emerald-200">Partido pendiente seleccionado</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-white">
                      {selectedPendingHomeTeamScoped?.logoUrl ? (
                        <img src={selectedPendingHomeTeamScoped.logoUrl} alt={selectedPendingHomeTeamScoped.name} className="h-6 w-6 rounded border border-white/20 bg-white object-contain p-0.5" />
                      ) : (
                        <span className="flex h-6 w-6 items-center justify-center rounded border border-white/20 text-[10px] text-slate-300">L</span>
                      )}
                      <span>{selectedPendingHomeTeamScoped?.name ?? 'Local'}</span>
                      <span className="text-slate-300">vs</span>
                      {selectedPendingAwayTeamScoped?.logoUrl ? (
                        <img src={selectedPendingAwayTeamScoped.logoUrl} alt={selectedPendingAwayTeamScoped.name} className="h-6 w-6 rounded border border-white/20 bg-white object-contain p-0.5" />
                      ) : (
                        <span className="flex h-6 w-6 items-center justify-center rounded border border-white/20 text-[10px] text-slate-300">V</span>
                      )}
                      <span>{selectedPendingAwayTeamScoped?.name ?? 'Visitante'}</span>
                      <span className="text-xs text-slate-300">· {getRoundLabel(selectedPendingMatchScoped.round)}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void startPendingMatchLive()}
                      disabled={liveLoadedForSelectedPendingScoped}
                      className="mt-2 rounded bg-emerald-600 px-3 py-1 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Iniciar y configurar en Live
                    </button>
                    {liveLoadedForSelectedPendingScoped && (
                      <p className="mt-1 text-[11px] text-emerald-100/80">
                        Este partido ya está cargado en Live. Finaliza y guarda para moverlo a historial.
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <input
                        type="datetime-local"
                        value={fixtureDateDraft || fixtureDatesMap[selectedPendingMatchScoped.id] || ''}
                        onChange={(event) => setFixtureDateDraft(event.target.value)}
                        className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                      />
                      {selectedCategoryCourtsCount > 1 && (
                        <input
                          type="text"
                          value={fixtureVenueDraft}
                          onChange={(event) => setFixtureVenueDraft(event.target.value)}
                          placeholder="Cancha"
                          className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                        />
                      )}
                      <button
                        type="button"
                        onClick={savePendingMatchDate}
                        className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-100"
                      >
                        Guardar fecha
                      </button>
                    </div>

                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      <div className="rounded border border-white/10 bg-slate-900/60 p-2">
                        <p className="text-xs font-semibold text-white">
                          {selectedPendingHomeTeam?.name ?? 'Local'} · jugadores ({selectedPendingHomeTeam?.players.length ?? 0})
                        </p>
                        <div className="mt-1 max-h-36 space-y-1 overflow-auto pr-1 text-xs text-slate-200">
                          {(selectedPendingHomeTeam?.players ?? []).map((player) => (
                            <p key={player.id} title={player.name} className="truncate">
                              #{player.number} {formatCompactPlayerName(player.name, 18)} ({player.position})
                            </p>
                          ))}
                          {(selectedPendingHomeTeam?.players.length ?? 0) === 0 && (
                            <p className="text-slate-400">Sin jugadores registrados.</p>
                          )}
                        </div>
                      </div>

                      <div className="rounded border border-white/10 bg-slate-900/60 p-2">
                        <p className="text-xs font-semibold text-white">
                          {selectedPendingAwayTeam?.name ?? 'Visitante'} · jugadores ({selectedPendingAwayTeam?.players.length ?? 0})
                        </p>
                        <div className="mt-1 max-h-36 space-y-1 overflow-auto pr-1 text-xs text-slate-200">
                          {(selectedPendingAwayTeam?.players ?? []).map((player) => (
                            <p key={player.id} title={player.name} className="truncate">
                              #{player.number} {formatCompactPlayerName(player.name, 18)} ({player.position})
                            </p>
                          ))}
                          {(selectedPendingAwayTeam?.players.length ?? 0) === 0 && (
                            <p className="text-slate-400">Sin jugadores registrados.</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {!selectedPendingMatchScoped && !selectedPlayedStatsScoped && (
                  <div className="rounded-xl border border-white/10 bg-slate-900/60 p-3 text-sm text-slate-300 lg:col-span-2">
                    Selecciona un partido pendiente para ver los jugadores de local y visitante.
                  </div>
                )}

                {selectedPlayedStatsScoped && (
                  <div className="rounded-xl border border-primary-300/30 bg-primary-500/10 p-3 lg:col-span-2">
                    <p className="text-sm font-semibold text-primary-100">Estadísticas del partido jugado</p>
                    <p className="mt-1 text-sm text-white">
                      {selectedPlayedStatsScoped.homeTeamName} {selectedPlayedStatsScoped.homeStats.goals} - {selectedPlayedStatsScoped.awayStats.goals}{' '}
                      {selectedPlayedStatsScoped.awayTeamName}
                    </p>
                    {selectedPlayedStatsScoped.penaltyShootout && (
                      <p className="text-xs text-amber-200">
                        Definición por penales: {selectedPlayedStatsScoped.homeTeamName} {selectedPlayedStatsScoped.penaltyShootout.home} - {selectedPlayedStatsScoped.penaltyShootout.away} {selectedPlayedStatsScoped.awayTeamName}
                      </p>
                    )}
                    <p className="text-xs text-slate-300">
                      Remates: {selectedPlayedStatsScoped.homeStats.shots} ({statPercent(selectedPlayedStatsScoped.homeStats.shots, selectedPlayedStatsScoped.homeStats.shots + selectedPlayedStatsScoped.awayStats.shots)}%) / {selectedPlayedStatsScoped.awayStats.shots} ({statPercent(selectedPlayedStatsScoped.awayStats.shots, selectedPlayedStatsScoped.homeStats.shots + selectedPlayedStatsScoped.awayStats.shots)}%) •
                      Goles: {selectedPlayedStatsScoped.homeStats.goals} ({statPercent(selectedPlayedStatsScoped.homeStats.goals, selectedPlayedStatsScoped.homeStats.goals + selectedPlayedStatsScoped.awayStats.goals)}%) / {selectedPlayedStatsScoped.awayStats.goals} ({statPercent(selectedPlayedStatsScoped.awayStats.goals, selectedPlayedStatsScoped.homeStats.goals + selectedPlayedStatsScoped.awayStats.goals)}%) •
                      Asistencias: {selectedPlayedStatsScoped.homeStats.assists} ({statPercent(selectedPlayedStatsScoped.homeStats.assists, selectedPlayedStatsScoped.homeStats.assists + selectedPlayedStatsScoped.awayStats.assists)}%) / {selectedPlayedStatsScoped.awayStats.assists} ({statPercent(selectedPlayedStatsScoped.awayStats.assists, selectedPlayedStatsScoped.homeStats.assists + selectedPlayedStatsScoped.awayStats.assists)}%) •
                      TA: {selectedPlayedStatsScoped.homeStats.yellows} ({statPercent(selectedPlayedStatsScoped.homeStats.yellows, selectedPlayedStatsScoped.homeStats.yellows + selectedPlayedStatsScoped.awayStats.yellows)}%) / {selectedPlayedStatsScoped.awayStats.yellows} ({statPercent(selectedPlayedStatsScoped.awayStats.yellows, selectedPlayedStatsScoped.homeStats.yellows + selectedPlayedStatsScoped.awayStats.yellows)}%) •
                      TR: {selectedPlayedStatsScoped.homeStats.reds} ({statPercent(selectedPlayedStatsScoped.homeStats.reds, selectedPlayedStatsScoped.homeStats.reds + selectedPlayedStatsScoped.awayStats.reds)}%) / {selectedPlayedStatsScoped.awayStats.reds} ({statPercent(selectedPlayedStatsScoped.awayStats.reds, selectedPlayedStatsScoped.homeStats.reds + selectedPlayedStatsScoped.awayStats.reds)}%)
                    </p>

                    {(selectedPlayedHomeLineupVisual.length > 0 || selectedPlayedAwayLineupVisual.length > 0) && (
                      <div className="mt-3 rounded border border-emerald-300/20 bg-emerald-900/20 p-3">
                        <p className="text-xs font-semibold text-emerald-100">Cancha · reconstrucción de eventos</p>
                        <p className="mt-1 text-[11px] text-emerald-100/80">Se muestran goles, TA/TR, penal fallado y cambios (↘ salió, ↗ entró) sobre titulares guardados.</p>

                        <div className="relative mt-3 overflow-hidden rounded-xl border border-white/20 bg-emerald-700/75 p-3">
                          <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(0deg,rgba(255,255,255,0.04)_0px,rgba(255,255,255,0.04)_30px,rgba(0,0,0,0.04)_30px,rgba(0,0,0,0.04)_60px)]" />
                          <div className="pointer-events-none absolute inset-0">
                            <div className="absolute left-2 right-2 top-2 bottom-2 rounded-md border border-white/35" />
                            <div className="absolute left-2 right-2 top-1/2 h-px -translate-y-1/2 bg-white/45" />
                            <div className="absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40" />
                          </div>

                          <div className="relative mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-white">
                            <span>{selectedPlayedStatsScoped.awayTeamName}</span>
                            <span>{selectedPlayedStatsScoped.homeTeamName}</span>
                          </div>

                          <div className="relative h-[320px] sm:h-[400px]">
                            <div className="absolute inset-x-2 top-4 bottom-1/2 flex flex-col justify-evenly">
                              {selectedPlayedAwayVisualLines.map((line, lineIndex) => (
                                <div key={`history-away-line-${lineIndex}`} className="px-1">
                                  <div className="grid items-start gap-2" style={{ gridTemplateColumns: `repeat(${line.length}, minmax(0, 1fr))` }}>
                                    {line.map((player) => {
                                      const indicator = selectedPlayedHistoryIndicators.get(player.id)
                                      const badges: string[] = []
                                      if (indicator?.goals) badges.push(`⚽${indicator.goals > 1 ? `x${indicator.goals}` : ''}`)
                                      if (indicator?.penaltyMisses) badges.push(`❌⚽${indicator.penaltyMisses > 1 ? `x${indicator.penaltyMisses}` : ''}`)
                                      if (indicator?.yellows) badges.push(`TA${indicator.yellows > 1 ? `x${indicator.yellows}` : ''}`)
                                      if (indicator?.reds) badges.push(`TR${indicator.reds > 1 ? `x${indicator.reds}` : ''}`)
                                      if (indicator?.substitutedOut) badges.push('↘')
                                      if (indicator?.substitutedIn) badges.push('↗')

                                      return (
                                        <div key={player.id} className="min-w-0 text-center">
                                          <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-full border border-white/80 bg-slate-900/70 text-xs font-bold text-white">
                                            {player.number}
                                          </div>
                                          <p title={player.name} className="mt-1 px-0.5 text-[9px] font-semibold leading-tight text-white sm:text-[10px]">
                                            {formatCompactPlayerName(player.name, 14)}
                                          </p>
                                          {badges.length > 0 && (
                                            <div className="mt-1 flex flex-wrap justify-center gap-1">
                                              {badges.map((badge) => (
                                                <span key={`${player.id}-away-${badge}`} className="rounded bg-slate-900/80 px-1 text-[9px] font-semibold text-white">{badge}</span>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              ))}
                            </div>

                            <div className="absolute inset-x-2 top-1/2 bottom-4 flex flex-col justify-evenly">
                              {selectedPlayedHomeVisualLines.map((line, lineIndex) => (
                                <div key={`history-home-line-${lineIndex}`} className="px-1">
                                  <div className="grid items-start gap-2" style={{ gridTemplateColumns: `repeat(${line.length}, minmax(0, 1fr))` }}>
                                    {line.map((player) => {
                                      const indicator = selectedPlayedHistoryIndicators.get(player.id)
                                      const badges: string[] = []
                                      if (indicator?.goals) badges.push(`⚽${indicator.goals > 1 ? `x${indicator.goals}` : ''}`)
                                      if (indicator?.penaltyMisses) badges.push(`❌⚽${indicator.penaltyMisses > 1 ? `x${indicator.penaltyMisses}` : ''}`)
                                      if (indicator?.yellows) badges.push(`TA${indicator.yellows > 1 ? `x${indicator.yellows}` : ''}`)
                                      if (indicator?.reds) badges.push(`TR${indicator.reds > 1 ? `x${indicator.reds}` : ''}`)
                                      if (indicator?.substitutedOut) badges.push('↘')
                                      if (indicator?.substitutedIn) badges.push('↗')

                                      return (
                                        <div key={player.id} className="min-w-0 text-center">
                                          <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-full border border-white/80 bg-slate-900/70 text-xs font-bold text-white">
                                            {player.number}
                                          </div>
                                          <p title={player.name} className="mt-1 px-0.5 text-[9px] font-semibold leading-tight text-white sm:text-[10px]">
                                            {formatCompactPlayerName(player.name, 14)}
                                          </p>
                                          {badges.length > 0 && (
                                            <div className="mt-1 flex flex-wrap justify-center gap-1">
                                              {badges.map((badge) => (
                                                <span key={`${player.id}-home-${badge}`} className="rounded bg-slate-900/80 px-1 text-[9px] font-semibold text-white">{badge}</span>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="mt-3 rounded border border-white/10 bg-slate-900/60 p-3">
                      <p className="text-xs font-semibold text-white">Goles del partido</p>
                      {selectedPlayedStatsScoped.goals.length === 0 ? (
                        <p className="mt-1 text-xs text-slate-300">Sin goles registrados (0-0).</p>
                      ) : (
                        <div className="mt-1 space-y-1 text-xs text-slate-200">
                          {selectedPlayedStatsScoped.goals.map((goal, index) => (
                            <p key={`${goal.minute}-${goal.playerName}-${index}`}>
                              {goal.clock} · {goal.teamName} · {goal.playerName}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="mt-3 rounded border border-white/10 bg-slate-900/60 p-3">
                      <p className="text-xs font-semibold text-white">Tabla de eventos del partido</p>
                      {selectedPlayedStatsScoped.events.length === 0 ? (
                        <p className="mt-1 text-xs text-slate-300">Sin eventos registrados.</p>
                      ) : (
                        <>
                          <div className="mt-2 space-y-2 md:hidden">
                            {selectedPlayedStatsScoped.events.map((event, index) => (
                              <div key={`${event.clock}-${event.type}-${index}`} className="rounded border border-white/10 bg-slate-800 px-2 py-2 text-xs text-slate-200">
                                <p><span className="text-slate-400">Tiempo:</span> {event.clock}</p>
                                <p><span className="text-slate-400">Equipo:</span> {event.teamName}</p>
                                <p><span className="text-slate-400">Jugador:</span> {event.playerName}</p>
                                <p><span className="text-slate-400">Evento:</span> {eventLabel(event.type)}</p>
                              </div>
                            ))}
                          </div>

                          <div className="mt-2 hidden overflow-auto md:block">
                            <table className="min-w-full text-xs text-slate-200">
                              <thead>
                                <tr className="text-slate-400">
                                  <th className="px-2 py-1 text-left">Tiempo</th>
                                  <th className="px-2 py-1 text-left">Equipo</th>
                                  <th className="px-2 py-1 text-left">Jugador</th>
                                  <th className="px-2 py-1 text-left">Evento</th>
                                </tr>
                              </thead>
                              <tbody>
                                {selectedPlayedStatsScoped.events.map((event, index) => (
                                  <tr key={`${event.clock}-${event.type}-${index}`} className="border-t border-white/10">
                                    <td className="px-2 py-1">{event.clock}</td>
                                    <td className="px-2 py-1">{event.teamName}</td>
                                    <td className="px-2 py-1">{event.playerName}</td>
                                    <td className="px-2 py-1">{eventLabel(event.type)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                    </div>

                    {
                      <div className="mt-3 rounded border border-white/10 bg-slate-900/60 p-3">
                        <p className="text-xs font-semibold text-white">Mejores jugadas (video)</p>
                        <p className="mt-1 text-[11px] text-slate-400">Recomendado: clips cortos (hasta 12MB) para ahorrar recursos.</p>
                        <label className="mt-2 inline-block rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-slate-200">
                          Subir video
                          <input
                            type="file"
                            accept="video/*"
                            className="mt-1 block text-[11px]"
                            onChange={(event) => {
                              const file = event.target.files?.[0]
                              if (!file || !selectedPlayedStatsScoped) return
                              void addHighlightVideo(selectedPlayedStatsScoped.matchId, file)
                              event.currentTarget.value = ''
                            }}
                          />
                        </label>

                        <div className="mt-2 grid gap-2 md:grid-cols-2">
                          {selectedPlayedStatsScoped.highlightVideos.map((video) => (
                            <div key={video.id} className="rounded border border-white/10 bg-slate-800 p-2">
                              <div className="mb-2 flex items-center justify-between gap-2">
                                <p className="text-[11px] text-slate-300">{video.name}</p>
                                <button
                                  type="button"
                                  onClick={() => void deleteHighlightVideo(selectedPlayedStatsScoped.matchId, video.id)}
                                  className="rounded border border-red-400/30 bg-red-500/10 px-2 py-1 text-[10px] font-semibold text-red-200 hover:bg-red-500/20"
                                >
                                  Eliminar
                                </button>
                              </div>
                              <video src={video.url} controls className="w-full rounded" />
                            </div>
                          ))}
                          {selectedPlayedStatsScoped.highlightVideos.length === 0 && (
                            <p className="text-xs text-slate-400">Todavía no hay videos cargados.</p>
                          )}
                        </div>
                      </div>
                    }
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {adminView === 'partidos' && liveMatch && selectedTeam && selectedPendingMatchScoped && liveLoadedForSelectedPendingScoped && (
          <section className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_1fr]">
            <article className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-white">Admin Live Partido</h3>
                <p className="text-sm text-primary-200">{liveMatch.leagueName} · {liveMatch.categoryName}</p>
              </div>

              {selectedPendingMatchScoped && (
                <div className="mb-3 rounded-lg border border-primary-300/30 bg-primary-500/10 p-3">
                  <p className="text-xs text-primary-100">
                    Partido activo: {teamsById.get(selectedPendingMatchScoped.homeTeamId)?.name ?? 'Local'} vs{' '}
                    {teamsById.get(selectedPendingMatchScoped.awayTeamId)?.name ?? 'Visitante'}
                  </p>

                  {competitionRulesDraft.resolveDrawByPenalties &&
                    selectedPendingMatchScoped.round > competitionRulesDraft.regularSeasonRounds &&
                    liveMatch.homeTeam.stats.goals === liveMatch.awayTeam.stats.goals && (
                      <div className="mt-3 rounded border border-amber-300/30 bg-amber-500/10 p-2">
                        <p className="text-xs font-semibold text-amber-100">Definir ganador por penales (fase final, empate en tiempo regular)</p>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <input
                            type="number"
                            min={0}
                            value={homePenaltiesDraft}
                            onChange={(event) => setHomePenaltiesDraft(event.target.value)}
                            placeholder={`Penales ${liveMatch.homeTeam.name}`}
                            className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                          />
                          <input
                            type="number"
                            min={0}
                            value={awayPenaltiesDraft}
                            onChange={(event) => setAwayPenaltiesDraft(event.target.value)}
                            placeholder={`Penales ${liveMatch.awayTeam.name}`}
                            className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                          />
                        </div>
                      </div>
                    )}
                </div>
              )}

              <div className="grid gap-3 md:grid-cols-5">
                <button
                  type="button"
                  onClick={() => setTimerAction('start')}
                  disabled={!canKickoff}
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Iniciar
                </button>
                <button
                  type="button"
                  onClick={() => setTimerAction('stop')}
                  disabled={!canEndFirstHalf}
                  className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  PT termina
                </button>
                <button
                  type="button"
                  onClick={() => setTimerAction('start')}
                  disabled={!canStartSecondHalf}
                  className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Inicia ST
                </button>
                <button
                  type="button"
                  onClick={() => setTimerAction('reset')}
                  disabled={!canResetTimer}
                  className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Reiniciar
                </button>
                <button
                  type="button"
                  onClick={() => setTimerAction('finish')}
                  disabled={!canFinalizeMatch}
                  className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Finalizar
                </button>
              </div>

              {!liveHasStarted && !liveIsFinished && (
                <p className="mt-2 rounded border border-cyan-300/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
                  Debes iniciar el partido para habilitar eventos, cambios y controles avanzados.
                </p>
              )}

              {liveIsFinished && (
                <p className="mt-2 rounded border border-amber-300/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  Partido finalizado: el registro de eventos y cambios está bloqueado.
                </p>
              )}

              <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/70 p-4 text-center">
                <p className="text-sm text-slate-300">Minutero en vivo</p>
                <p className="text-3xl font-bold text-white">{formatTimer(liveElapsedSeconds)}</p>
                <p className="text-xs text-primary-200">Minuto actual: {liveCurrentMinute}</p>
              </div>

              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm text-slate-300">Equipo para alineación</label>
                  <div className="grid grid-cols-2 gap-2">
                    {[liveMatch.homeTeam, liveMatch.awayTeam].map((team) => (
                      <button
                        key={team.id}
                        type="button"
                        onClick={() => syncTeamDraft(team)}
                        className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                          selectedTeam.id === team.id
                            ? 'border-primary-300/50 bg-primary-500/20 text-primary-100'
                            : 'border-white/20 bg-slate-900 text-slate-200'
                        }`}
                      >
                        {team.name}
                      </button>
                    ))}
                  </div>

                  <div className="mt-3 rounded-xl border border-white/10 bg-slate-900/60 p-3">
                    <p className="mb-2 text-sm font-semibold text-white">Inscritos (arrastra a cancha)</p>
                    <div className="grid max-h-56 grid-cols-2 gap-1.5 overflow-auto pr-1 sm:block sm:space-y-2">
                      {allRegisteredPlayers.map((player) => {
                        const isStarter = lineupStarters.includes(player.id)
                        const isSubstitute = lineupSubstitutes.includes(player.id)
                        const isRedCarded = selectedTeam.redCarded.includes(player.id)
                        const statusColor = isRedCarded ? 'text-rose-300' : isStarter ? 'text-emerald-300' : isSubstitute ? 'text-cyan-300' : 'text-slate-400'
                        const status = isRedCarded ? 'Expulsado' : isStarter ? 'Titular' : isSubstitute ? 'Suplente' : 'Disponible'
                        const badges = playerBadges(player.id)

                        return (
                        <div
                          key={player.id}
                          draggable={!isRedCarded}
                          onDragStart={(event) => onDragPlayer(event, player.id)}
                          className="cursor-grab rounded-lg border border-white/10 bg-slate-800 px-2 py-1.5 text-xs text-slate-100 sm:px-3 sm:py-2"
                        >
                          <div className="flex items-center gap-1.5 sm:gap-2">
                            {player.photoUrl ? (
                              <img src={player.photoUrl} alt={player.name} className="h-6 w-6 flex-shrink-0 rounded-full border border-white/20 object-cover sm:h-7 sm:w-7" />
                            ) : (
                              <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-white/20 text-[9px] text-slate-400 sm:h-7 sm:w-7 sm:text-[10px]">S/F</div>
                            )}
                            <div className="min-w-0">
                              <p title={player.name} className="truncate text-[10px] font-medium sm:text-xs">
                                <span className="text-slate-400">#{player.number}</span> {formatCompactPlayerName(player.name, 14)}
                              </p>
                              <p className={`text-[9px] sm:text-[10px] ${statusColor}`}>{player.position} · {status}</p>
                              {badges.length > 0 && (
                                <div className="mt-0.5 hidden flex-wrap gap-1 sm:flex">
                                  {badges.map((badge) => (
                                    <span key={`${player.id}-${badge}`} className="rounded bg-slate-700/90 px-1 py-0.5 text-[10px] text-slate-100">
                                      {badge}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )})}
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="rounded-xl border border-emerald-300/30 p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-emerald-100">Cancha · Titulares ({lineupStarters.length}/{formationSlotsCount})</p>
                      <select
                        value={selectedFormationKey}
                        onChange={(event) => {
                          void handleFormationChange(event.target.value)
                        }}
                        className="rounded border border-emerald-200/30 bg-slate-900 px-2 py-1 text-xs text-white"
                        disabled={liveIsFinished || savingFormation}
                      >
                        {formationOptions.map((formation) => (
                          <option key={formation.key} value={formation.key}>{formation.label}</option>
                        ))}
                      </select>
                    </div>

                    <div className="relative overflow-hidden rounded-xl border border-emerald-200/30 bg-emerald-600/70 p-3">
                      <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(0deg,rgba(255,255,255,0.04)_0px,rgba(255,255,255,0.04)_28px,rgba(0,0,0,0.04)_28px,rgba(0,0,0,0.04)_56px)]" />

                      <div className="pointer-events-none absolute inset-0">
                        <div className="absolute left-2 right-2 top-2 bottom-2 rounded-md border border-white/30" />
                        <div className="absolute left-2 right-2 top-1/2 h-px -translate-y-1/2 bg-white/40" />
                        <div className="absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40" />

                        <div className="absolute left-1/2 top-2 h-10 w-28 -translate-x-1/2 border border-white/35" />
                        <div className="absolute left-1/2 top-2 h-5 w-14 -translate-x-1/2 border border-white/35" />

                        <div className="absolute left-1/2 bottom-2 h-10 w-28 -translate-x-1/2 border border-white/35" />
                        <div className="absolute left-1/2 bottom-2 h-5 w-14 -translate-x-1/2 border border-white/35" />
                      </div>

                      <div className="relative mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-emerald-50/95">
                        <span>{selectedTeam.name}</span>
                        <span>{activeFormation?.label ?? '-'}</span>
                      </div>

                      <div className="relative h-[320px] sm:h-[360px]">
                        <div className="absolute inset-x-2 top-4 bottom-4 flex flex-col justify-between">
                          {formationRows.map((row) => (
                            <div
                              key={row.rowIndex}
                              className="grid items-start gap-1.5 sm:gap-2"
                              style={{ gridTemplateColumns: `repeat(${row.slotIndices.length}, minmax(0, 1fr))` }}
                            >
                              {row.slotIndices.map((slotIndex) => {
                                const playerId = starterSlots[slotIndex] ?? ''
                                const player = playerId ? playerMap.get(playerId) : null
                                const isRedCarded = playerId ? selectedTeam.redCarded.includes(playerId) : false
                                const badges = playerId ? playerBadges(playerId) : []
                                const hasBadge = badges.length > 0
                                return (
                                  <div key={`${row.rowIndex}-${slotIndex}`} className="min-w-0 text-center">
                                    {/* Círculo del jugador */}
                                    <div className="relative mx-auto w-fit">
                                      <div
                                        onDragOver={(event) => event.preventDefault()}
                                        onDrop={(event) => onDropToStarterSlot(event, slotIndex)}
                                        className={`flex h-8 w-8 items-center justify-center rounded-full border sm:h-11 sm:w-11 ${
                                          playerId
                                            ? 'border-white/80 bg-slate-900 text-white'
                                            : 'border-dashed border-white/70 bg-emerald-900/25 text-emerald-100'
                                        }`}
                                        style={isRedCarded ? { opacity: 0.45, filter: 'grayscale(100%)' } : undefined}
                                      >
                                        {playerId ? (
                                          <button
                                            type="button"
                                            draggable={!liveIsFinished && !isRedCarded}
                                            onDragStart={(event) => onDragPlayer(event, playerId)}
                                            onClick={() => removeFromLineup(playerId)}
                                            className="h-full w-full rounded-full text-[11px] font-bold sm:text-[12px]"
                                          >
                                            {player?.number ?? '•'}
                                          </button>
                                        ) : (
                                          <span className="text-[10px]">+</span>
                                        )}
                                      </div>
                                      {/* Punto indicador de eventos · visible solo en móvil */}
                                      {player && hasBadge && (
                                        <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-400 ring-1 ring-slate-900 sm:hidden" />
                                      )}
                                    </div>

                                    {/* Nombre abreviado: oculto en móvil, visible desde sm */}
                                    <p
                                      title={player?.name}
                                      className="mt-0.5 hidden truncate text-[9px] font-semibold text-white drop-shadow sm:block sm:text-[10px]"
                                    >
                                      {player ? formatCompactPlayerName(player.name, 11) : '·'}{isRedCarded ? ' TR' : ''}
                                    </p>

                                    {/* Badges: solo en sm+ */}
                                    {player && badges.length > 0 && (
                                      <div className="mt-0.5 hidden flex-wrap justify-center gap-0.5 sm:flex">
                                        {badges.map((badge) => (
                                          <span key={`${player.id}-field-${badge}`} className="rounded bg-black/45 px-1 py-0.5 text-[9px] text-white">
                                            {badge}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {lineupStarters.length === 0 && (
                      <p className="mt-2 text-xs text-emerald-100/80">Puedes iniciar con equipo incompleto y completar luego con arrastrar/soltar.</p>
                    )}
                  </div>

                  <div
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={onDropToBench}
                    className="min-h-28 rounded-xl border border-white/20 bg-slate-900/75 p-3"
                  >
                    <p className="mb-1 text-sm font-semibold text-white">Suplentes ({lineupSubstitutes.length})</p>
                    <p className="mb-2 text-[11px] text-slate-300">Arrastra desde cancha para sacar titular · se muestran también las que entraron</p>
                    <div className="space-y-2 text-xs">
                      {substituteVisualIds.map((id) => {
                        const isOnField = lineupStarters.includes(id)
                        const canDrag = !liveIsFinished && lineupSubstitutes.includes(id)
                        const badges = playerBadges(id)

                        return (
                          <button
                            key={id}
                            type="button"
                            draggable={canDrag}
                            onDragStart={(event) => onDragPlayer(event, id)}
                            className={`block w-full rounded border px-2 py-1 text-left ${isOnField ? 'border-primary-300/40 bg-primary-500/15 text-primary-100' : 'border-white/15 bg-slate-800/90 text-slate-100'}`}
                          >
                            <span className="flex items-center gap-2">
                              {playerMap.get(id)?.photoUrl ? (
                                <img src={playerMap.get(id)?.photoUrl} alt={playerMap.get(id)?.name} className="h-6 w-6 rounded-full border border-white/20 object-cover" />
                              ) : (
                                <span className="flex h-6 w-6 items-center justify-center rounded-full border border-white/20 text-[10px] text-slate-400">S/F</span>
                              )}
                              <span title={playerMap.get(id)?.name} className="min-w-0 flex-1 truncate">
                                {formatCompactPlayerName(playerMap.get(id)?.name ?? id, 20)}
                              </span>
                              {isOnField && <span className="rounded bg-primary-700/70 px-1 py-0.5 text-[10px] font-semibold">↗ En cancha</span>}
                            </span>
                            {badges.length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1 pl-8">
                                {badges.map((badge) => (
                                  <span key={`${id}-bench-${badge}`} className="rounded bg-slate-700/90 px-1 py-0.5 text-[10px] text-slate-100">
                                    {badge}
                                  </span>
                                ))}
                              </div>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
                    <p className="mb-2 text-sm font-semibold text-white">Titulares en cancha (acciones rápidas)</p>
                    <div className="space-y-2 text-xs">
                      {lineupStarters.map((id) => (
                        (() => {
                          const isRedCarded = selectedTeam.redCarded.includes(id)
                          const badges = playerBadges(id)
                          return (
                        <div
                          key={id}
                          onMouseEnter={() => setHoveredStarterId(id)}
                          onMouseLeave={() => setHoveredStarterId('')}
                          className={`rounded border px-2 py-1 text-left text-white ${isRedCarded ? 'border-rose-300/30 bg-rose-900/30 opacity-70' : 'border-emerald-300/20 bg-slate-900'}`}
                        >
                          <button type="button" onClick={() => removeFromLineup(id)} className="w-full text-left">
                            <span className="flex items-center gap-2">
                              {playerMap.get(id)?.photoUrl ? (
                                <img src={playerMap.get(id)?.photoUrl} alt={playerMap.get(id)?.name} className="h-6 w-6 rounded-full border border-white/20 object-cover" />
                              ) : (
                                <span className="flex h-6 w-6 items-center justify-center rounded-full border border-white/20 text-[10px] text-slate-400">S/F</span>
                              )}
                              <span title={playerMap.get(id)?.name} className="min-w-0 flex-1 truncate">
                                {formatCompactPlayerName(playerMap.get(id)?.name ?? id, 20)}
                              </span>
                              {isRedCarded && <span className="rounded bg-rose-700/90 px-1 py-0.5 text-[10px] font-bold">TR</span>}
                            </span>
                          </button>

                          {badges.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {badges.map((badge) => (
                                <span key={`${id}-quick-${badge}`} className="rounded bg-slate-700/90 px-1 py-0.5 text-[10px] text-slate-100">
                                  {badge}
                                </span>
                              ))}
                            </div>
                          )}

                          {hoveredStarterId === id && !isRedCarded && (
                            <div className="mt-1 grid grid-cols-3 gap-1 sm:grid-cols-6">
                              <button type="button" disabled={!canRegisterLiveEvents} onClick={() => void sendEventForStarter(selectedTeam.id, id, 'goal')} className="rounded bg-emerald-700 px-1 py-1 text-[10px] text-white disabled:opacity-50">Gol</button>
                              <button type="button" disabled={!canRegisterLiveEvents} onClick={() => void sendEventForStarter(selectedTeam.id, id, 'penalty_goal')} className="rounded bg-emerald-900 px-1 py-1 text-[10px] text-white disabled:opacity-50">Pen</button>
                              <button type="button" disabled={!canRegisterLiveEvents} onClick={() => void sendEventForStarter(selectedTeam.id, id, 'penalty_miss')} className="rounded bg-slate-700 px-1 py-1 text-[10px] text-white disabled:opacity-50">Pen F</button>
                              <button type="button" disabled={!canRegisterLiveEvents} onClick={() => void sendEventForStarter(selectedTeam.id, id, 'assist')} className="rounded bg-blue-700 px-1 py-1 text-[10px] text-white disabled:opacity-50">Asis</button>
                              <button type="button" disabled={!canRegisterLiveEvents} onClick={() => void sendEventForStarter(selectedTeam.id, id, 'yellow')} className="rounded bg-amber-500 px-1 py-1 text-[10px] text-black disabled:opacity-50">TA</button>
                              <button type="button" disabled={!canRegisterLiveEvents} onClick={() => void sendEventForStarter(selectedTeam.id, id, 'red')} className="rounded bg-rose-700 px-1 py-1 text-[10px] text-white disabled:opacity-50">TR</button>
                            </div>
                          )}
                        </div>
                          )
                        })()
                      ))}
                      {lineupStarters.length === 0 && <p className="text-slate-400">Sin titulares en cancha.</p>}
                    </div>
                  </div>

                  <div className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
                    <p className="mb-2 text-sm font-semibold text-white">Cambio de jugadores</p>
                    <div className="grid gap-2 md:grid-cols-2">
                      <select
                        value={substitutionOutPlayerId}
                        onChange={(event) => setSubstitutionOutPlayerId(event.target.value)}
                        className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                        disabled={!canRegisterLiveEvents}
                      >
                        <option value="">Sale (titular)</option>
                        {substitutionOutOptions.map((id) => (
                          <option key={id} value={id}>{formatCompactPlayerName(playerMap.get(id)?.name ?? id, 24)}</option>
                        ))}
                      </select>
                      <select
                        value={substitutionInPlayerId}
                        onChange={(event) => setSubstitutionInPlayerId(event.target.value)}
                        className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                        disabled={!canRegisterLiveEvents}
                      >
                        <option value="">Entra (suplente)</option>
                        {substitutionInOptions.map((id) => (
                          <option key={id} value={id}>{formatCompactPlayerName(playerMap.get(id)?.name ?? id, 24)}</option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      onClick={() => void registerSubstitution()}
                      disabled={!canRegisterLiveEvents}
                      className="mt-2 w-full rounded border border-primary-300/40 bg-primary-500/20 px-3 py-2 text-xs font-semibold text-primary-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Registrar cambio
                    </button>

                    <div className="mt-3 rounded border border-white/10 bg-slate-900/70 p-2">
                      <p className="text-[11px] font-semibold text-slate-200">Timeline de cambios</p>
                      <div className="mt-2 max-h-28 space-y-1 overflow-auto pr-1 text-[11px] text-slate-300">
                        {selectedTeamSubstitutionTimeline.length === 0 && (
                          <p className="text-slate-400">Sin cambios registrados para este equipo.</p>
                        )}
                        {selectedTeamSubstitutionTimeline
                          .slice()
                          .reverse()
                          .map((entry) => {
                            const outName = playerMap.get(entry.outPlayerId)?.name ?? entry.outPlayerId
                            const inName = playerMap.get(entry.inPlayerId)?.name ?? entry.inPlayerId

                            return (
                              <p key={entry.id} className="rounded border border-white/10 bg-slate-800/80 px-2 py-1">
                                {entry.minute}' · {entry.clock} · <span className="text-rose-300">↘ {outName}</span> · <span className="text-emerald-300">↗ {inName}</span>
                              </p>
                            )
                          })}
                      </div>
                    </div>
                  </div>

                  <button type="button" onClick={saveLineup} disabled={liveIsFinished} className="w-full rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-50">
                    Guardar alineación
                  </button>
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-white/10 bg-slate-900/70 p-3">
                <p className="mb-2 text-sm font-semibold text-white">Carga de estadísticas (en vivo)</p>
                <div className="mb-2 grid grid-cols-2 gap-2">
                  {[liveMatch.homeTeam, liveMatch.awayTeam].map((team) => (
                    <button
                      key={team.id}
                      type="button"
                      onClick={() => syncTeamDraft(team)}
                      className={`rounded border px-2 py-1 text-xs font-semibold ${
                        selectedTeam.id === team.id
                          ? 'border-primary-300/50 bg-primary-500/20 text-primary-100'
                          : 'border-white/20 bg-slate-900 text-slate-200'
                      }`}
                    >
                      {team.name}
                    </button>
                  ))}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <select
                    value={selectedPlayerId}
                    onChange={(event) => setSelectedPlayerId(event.target.value)}
                    className="rounded-lg border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
                    disabled={!canRegisterLiveEvents}
                  >
                    <option value="">Selecciona jugador</option>
                    {eventEligiblePlayerIds.map((playerId) => {
                      const player = selectedTeam.players.find((item) => item.id === playerId)
                      if (!player) return null
                      return (
                        <option key={player.id} value={player.id}>
                          #{player.number} {player.name}
                        </option>
                      )
                    })}
                    {selectedTeam.players
                      .filter((player) => selectedTeam.redCarded.includes(player.id))
                      .map((player) => (
                      <option key={player.id} value={player.id} disabled>
                        #{player.number} {player.name} · EXPULSADO
                      </option>
                    ))}
                  </select>

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                    <button type="button" disabled={!canRegisterLiveEvents} onClick={() => sendEvent('shot')} className="rounded bg-slate-700 px-2 py-2 text-xs text-white disabled:opacity-50">Remate</button>
                    <button type="button" disabled={!canRegisterLiveEvents} onClick={() => sendEvent('goal')} className="rounded bg-emerald-600 px-2 py-2 text-xs text-white disabled:opacity-50">Gol</button>
                    <button type="button" disabled={!canRegisterLiveEvents} onClick={() => sendEvent('penalty_goal')} className="rounded bg-emerald-900 px-2 py-2 text-xs text-white disabled:opacity-50">Penal</button>
                    <button type="button" disabled={!canRegisterLiveEvents} onClick={() => sendEvent('penalty_miss')} className="rounded bg-slate-600 px-2 py-2 text-xs text-white disabled:opacity-50">Pen F</button>
                    <button type="button" disabled={!canRegisterLiveEvents} onClick={() => sendEvent('assist')} className="rounded bg-blue-600 px-2 py-2 text-xs text-white disabled:opacity-50">Asis</button>
                    <button type="button" disabled={!canRegisterLiveEvents} onClick={() => sendEvent('yellow')} className="rounded bg-amber-500 px-2 py-2 text-xs text-black disabled:opacity-50">TA</button>
                    <button type="button" disabled={!canRegisterLiveEvents} onClick={() => sendEvent('red')} className="rounded bg-rose-600 px-2 py-2 text-xs text-white disabled:opacity-50">TR</button>
                  </div>
                </div>

                  <div className="mt-3 grid grid-cols-5 gap-2 text-center text-[11px]">
                  <div className="rounded border border-white/10 bg-slate-800 px-1 py-1 text-slate-200">
                    Remates: {selectedPlayerLiveStats.shots}
                  </div>
                  <div className="rounded border border-white/10 bg-slate-800 px-1 py-1 text-slate-200">
                    Goles: {selectedPlayerLiveStats.goals}
                  </div>
                  <div className="rounded border border-white/10 bg-slate-800 px-1 py-1 text-slate-200">
                    Asis: {selectedPlayerLiveStats.assists}
                  </div>
                  <div className="rounded border border-white/10 bg-slate-800 px-1 py-1 text-slate-200">
                    TA: {selectedPlayerLiveStats.yellows}
                  </div>
                  <div className="rounded border border-white/10 bg-slate-800 px-1 py-1 text-slate-200">
                    TR: {selectedPlayerLiveStats.reds}
                  </div>
                </div>

                  <div className="mt-3 rounded-xl border border-white/10 bg-slate-900/60 p-3">
                    <p className="mb-2 text-sm font-semibold text-white">Tarjetas cuerpo técnico</p>
                    <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                      <select
                        value={selectedStaffRole}
                        onChange={(event) => setSelectedStaffRole(event.target.value as LiveStaffRole)}
                        className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                        disabled={!canRegisterLiveEvents}
                      >
                        <option value="director" disabled={!selectedTeam.technicalStaff?.director?.name}>
                          DT {selectedTeam.technicalStaff?.director?.name ? `· ${selectedTeam.technicalStaff?.director?.name}` : '· Sin registrar'}
                        </option>
                        <option value="assistant" disabled={!selectedTeam.technicalStaff?.assistant?.name}>
                          AT {selectedTeam.technicalStaff?.assistant?.name ? `· ${selectedTeam.technicalStaff?.assistant?.name}` : '· Sin registrar'}
                        </option>
                      </select>
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="rounded bg-amber-500/90 px-2 py-1 font-bold text-amber-950">
                          TA: {selectedTeam.staffDiscipline?.[selectedStaffRole]?.yellows ?? 0}
                        </span>
                        <span className="rounded bg-rose-600/90 px-2 py-1 font-bold text-rose-50">
                          TR: {selectedTeam.staffDiscipline?.[selectedStaffRole]?.reds ?? 0}
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={!canRegisterLiveEvents || !selectedTeam.technicalStaff?.[selectedStaffRole]?.name || Boolean(selectedTeam.staffDiscipline?.[selectedStaffRole]?.sentOff)}
                        onClick={() => void sendStaffCardEvent(selectedStaffRole, 'staff_yellow')}
                        className="rounded bg-amber-500 px-2 py-2 text-xs font-semibold text-amber-950 disabled:opacity-50"
                      >
                        TA {staffRoleLabel(selectedStaffRole)}
                      </button>
                      <button
                        type="button"
                        disabled={!canRegisterLiveEvents || !selectedTeam.technicalStaff?.[selectedStaffRole]?.name || Boolean(selectedTeam.staffDiscipline?.[selectedStaffRole]?.sentOff)}
                        onClick={() => void sendStaffCardEvent(selectedStaffRole, 'staff_red')}
                        className="rounded bg-rose-600 px-2 py-2 text-xs font-semibold text-rose-50 disabled:opacity-50"
                      >
                        TR {staffRoleLabel(selectedStaffRole)}
                      </button>
                    </div>
                    {Boolean(selectedTeam.staffDiscipline?.[selectedStaffRole]?.sentOff) && (
                      <p className="mt-2 text-[11px] font-semibold text-rose-200">
                        {staffRoleLabel(selectedStaffRole)} expulsado en el partido.
                      </p>
                    )}
                  </div>
              </div>

              {adminMessage && <p className="mt-3 text-sm text-primary-200">{adminMessage}</p>}
            </article>

            <article className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <h3 className="text-lg font-semibold text-white">Dashboard público en vivo</h3>
              <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/70 p-4 text-center">
                <p className="text-xs text-slate-300">{liveMatch.status === 'live' ? 'EN VIVO' : 'PREVIO'}</p>
                <p className="mt-1 text-3xl font-bold text-white">{liveMatch.homeTeam.stats.goals} - {liveMatch.awayTeam.stats.goals}</p>
                <p className="text-sm text-slate-300">{liveMatch.homeTeam.name} vs {liveMatch.awayTeam.name}</p>
              </div>

              <div
                className="mt-4 rounded-xl border border-white/10 bg-slate-900/70 p-3"
                style={{
                  backgroundImage: "url('/cancha.svg')",
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }}
              >
                <p className="text-xs font-semibold text-white">Incidencias en vivo sobre cancha</p>
                <div className="mt-2 max-h-32 space-y-1 overflow-auto text-[11px] text-slate-100">
                  {liveMatch.events.slice(0, 8).map((event) => {
                    const team = event.teamId === liveMatch.homeTeam.id ? liveMatch.homeTeam : liveMatch.awayTeam
                    const actorLabel = resolveEventActorLabel(team, event)
                    return (
                      <p key={event.id} className="rounded bg-black/35 px-2 py-1">
                        {event.clock} · {team.name} · {eventLabel(event.type)} · {actorLabel}
                      </p>
                    )
                  })}
                  {liveMatch.events.length === 0 && <p className="rounded bg-black/35 px-2 py-1">Sin incidencias registradas.</p>}
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {[liveMatch.homeTeam, liveMatch.awayTeam].map((team) => (
                  <div key={team.id} className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
                    <p className="font-semibold text-white">{team.name}</p>
                    <p className="text-xs text-slate-300">
                      Remates: {team.stats.shots} ({statPercent(team.stats.shots, liveTotals.shots)}%) · Goles: {team.stats.goals} ({statPercent(team.stats.goals, liveTotals.goals)}%)
                    </p>
                    <p className="text-xs text-slate-300">
                      Asist: {team.stats.assists} ({statPercent(team.stats.assists, liveTotals.assists)}%) · TA: {team.stats.yellows} ({statPercent(team.stats.yellows, liveTotals.yellows)}%) · TR: {team.stats.reds} ({statPercent(team.stats.reds, liveTotals.reds)}%)
                    </p>
                    <p className="mt-2 text-xs text-rose-300">Expulsados: {team.redCarded.length}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/60 p-3">
                <p className="mb-2 text-sm font-semibold text-white">Últimos eventos</p>
                <div className="max-h-64 space-y-2 overflow-auto pr-1 text-xs">
                  {liveMatch.events.slice(0, 15).map((event) => {
                    const team = event.teamId === liveMatch.homeTeam.id ? liveMatch.homeTeam : liveMatch.awayTeam
                    const actorLabel = resolveEventActorLabel(team, event)
                    return (
                      <div key={event.id} className="rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-slate-200">
                        {event.clock} · {team.name} · {eventLabel(event.type)} · {actorLabel}
                      </div>
                    )
                  })}
                </div>
              </div>
            </article>
          </section>
        )}

        {adminView === 'historial' && (
          <section className="mt-6 space-y-4 rounded-2xl border border-white/10 bg-white/5 p-5">
            <h3 className="text-lg font-semibold text-white">Historial y acumulado de campeonato</h3>

            {!selectedLeague && <p className="text-sm text-slate-300">Selecciona una liga para ver el historial.</p>}

            {selectedLeague && (
              <>
                <div className="grid gap-2 md:grid-cols-2">
                  <select
                    value={activeHistorySeason}
                    onChange={(event) => {
                      const nextSeason = Number(event.target.value)
                      setHistorySeasonFilter(nextSeason)
                      const firstLeagueForSeason = leagues.find((league) => league.season === nextSeason)
                      if (firstLeagueForSeason) {
                        handleSelectLeague(firstLeagueForSeason.id)
                      }
                    }}
                    className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white"
                  >
                    {availableHistorySeasons.map((season) => (
                      <option key={season} value={season}>
                        Temporada {season}
                      </option>
                    ))}
                  </select>

                  <select
                    value={selectedLeague.id}
                    onChange={(event) => handleSelectLeague(event.target.value)}
                    className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white"
                  >
                    {leaguesByHistorySeason.map((league) => (
                      <option key={league.id} value={league.id}>
                        {league.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-3 rounded-xl border border-white/10 bg-slate-900/60 p-3">
                  <div className="flex flex-wrap gap-2">
                    {([
                      { key: 'standings', label: 'Tabla de posiciones' },
                      { key: 'scorers', label: 'Goleadores' },
                      { key: 'assists', label: 'Asistencias' },
                      { key: 'yellows', label: 'TA' },
                      { key: 'reds', label: 'TR' },
                    ] as Array<{ key: HistoryTabKey; label: string }>).map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        onClick={() => setActiveHistoryTab(tab.key)}
                        className={`rounded border px-3 py-1 text-xs font-semibold ${
                          activeHistoryTab === tab.key
                            ? 'border-primary-300/60 bg-primary-500/20 text-primary-100'
                            : 'border-white/20 bg-slate-800 text-slate-200 hover:border-white/35'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => void downloadHistoryTablePng(activeHistoryTab)}
                      className="rounded border border-cyan-300/40 bg-cyan-500/15 px-3 py-1 text-xs font-semibold text-cyan-100"
                    >
                      Exportar PNG
                    </button>
                    <button
                      type="button"
                      onClick={() => void shareHistoryTableToWhatsApp(activeHistoryTab)}
                      className="rounded border border-emerald-300/40 bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-100"
                    >
                      Compartir por WS
                    </button>
                  </div>

                  {activeHistoryTab === 'standings' && (
                    <div ref={(node) => { historyTableRefs.current.standings = node }} className="rounded border border-white/10 bg-slate-900/70 p-2">
                      <p className="mb-2 text-sm font-semibold text-white">Tabla de posiciones</p>
                      {standings.length === 0 ? (
                        <p className="text-xs text-slate-400">No hay equipos registrados para esta categoría.</p>
                      ) : (
                        <div className="overflow-auto">
                          <table className="min-w-[860px] text-xs text-slate-200">
                            <thead>
                              <tr className="text-slate-400">
                                <th className="px-2 py-1 text-left">#</th>
                                <th className="px-2 py-1 text-left">Equipo</th>
                                <th className="px-2 py-1">PJ</th>
                                <th className="px-2 py-1">PG</th>
                                <th className="px-2 py-1">PE</th>
                                <th className="px-2 py-1">PP</th>
                                <th className="px-2 py-1">GF</th>
                                <th className="px-2 py-1">GC</th>
                                <th className="px-2 py-1">DG</th>
                                <th className="px-2 py-1">PTS</th>
                              </tr>
                            </thead>
                            <tbody>
                              {standings.map((row, index) => (
                                <tr key={row.teamId} className="border-t border-white/10">
                                  <td className="px-2 py-1 text-center font-semibold text-slate-300">{index + 1}</td>
                                  <td className="px-2 py-1 text-left">
                                    <span className="flex items-center gap-2">
                                      {row.teamLogoUrl ? (
                                        <img src={row.teamLogoUrl} alt={row.teamName} className="h-5 w-5 rounded border border-white/20 bg-white object-contain p-0.5" />
                                      ) : (
                                        <span className="flex h-5 w-5 items-center justify-center rounded border border-white/20 text-[10px] text-slate-400">EQ</span>
                                      )}
                                      {row.teamName}
                                    </span>
                                  </td>
                                  <td className="px-2 py-1 text-center">{row.pj}</td>
                                  <td className="px-2 py-1 text-center">{row.pg}</td>
                                  <td className="px-2 py-1 text-center">{row.pe}</td>
                                  <td className="px-2 py-1 text-center">{row.pp}</td>
                                  <td className="px-2 py-1 text-center">{row.gf}</td>
                                  <td className="px-2 py-1 text-center">{row.gc}</td>
                                  <td className="px-2 py-1 text-center font-semibold text-cyan-100">{row.dg}</td>
                                  <td className="px-2 py-1 text-center font-semibold text-white">{row.pts}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {activeHistoryTab === 'scorers' && (
                    <div ref={(node) => { historyTableRefs.current.scorers = node }} className="rounded border border-white/10 bg-slate-900/70 p-2">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-white">Tabla de goleadores</p>
                        <input
                          value={scorersSearchTerm}
                          onChange={(event) => setScorersSearchTerm(event.target.value)}
                          placeholder="Buscar..."
                          className="w-36 rounded border border-white/20 bg-slate-800 px-2 py-1 text-[11px] text-white placeholder:text-slate-400"
                        />
                      </div>
                      <div className="max-h-64 space-y-1 overflow-auto text-xs text-slate-200">
                        {scorersPagination.totalItems === 0 && <p className="text-slate-400">Sin datos.</p>}
                        {scorersPagination.pageItems.map((item, index) => (
                          <div key={`scorer-${item.playerId}`} className="rounded border border-white/10 bg-slate-800 px-2 py-1">
                            <p className="font-semibold text-white">{(scorersPagination.currentPage - 1) * 10 + index + 1}. {item.teamName}</p>
                            <p className="flex items-center gap-2 text-slate-200">
                              {item.teamLogoUrl ? (
                                <img src={item.teamLogoUrl} alt={item.teamName} className="h-4 w-4 rounded border border-white/20 bg-white object-contain p-0.5" />
                              ) : (
                                <span className="flex h-4 w-4 items-center justify-center rounded border border-white/20 text-[9px] text-slate-400">EQ</span>
                              )}
                              {item.playerName} · #{item.playerNumber > 0 ? item.playerNumber : '--'} · {item.goals} gol{item.goals === 1 ? '' : 'es'}
                            </p>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-300">
                        <span>Página {scorersPagination.currentPage}/{scorersPagination.totalPages}</span>
                        <div className="flex gap-1">
                          <button type="button" onClick={() => setScorersPage((current) => Math.max(1, current - 1))} disabled={scorersPagination.currentPage <= 1} className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50">◀</button>
                          <button type="button" onClick={() => setScorersPage((current) => Math.min(scorersPagination.totalPages, current + 1))} disabled={scorersPagination.currentPage >= scorersPagination.totalPages} className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50">▶</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {activeHistoryTab === 'assists' && (
                    <div ref={(node) => { historyTableRefs.current.assists = node }} className="rounded border border-white/10 bg-slate-900/70 p-2">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-white">Tabla de asistencias</p>
                        <input
                          value={assistsSearchTerm}
                          onChange={(event) => setAssistsSearchTerm(event.target.value)}
                          placeholder="Buscar..."
                          className="w-36 rounded border border-white/20 bg-slate-800 px-2 py-1 text-[11px] text-white placeholder:text-slate-400"
                        />
                      </div>
                      <div className="max-h-64 space-y-1 overflow-auto text-xs text-slate-200">
                        {assistsPagination.totalItems === 0 && <p className="text-slate-400">Sin datos.</p>}
                        {assistsPagination.pageItems.map((item, index) => (
                          <div key={`assist-${item.playerId}`} className="rounded border border-white/10 bg-slate-800 px-2 py-1">
                            <p className="font-semibold text-white">{(assistsPagination.currentPage - 1) * 10 + index + 1}. {item.teamName}</p>
                            <p className="flex items-center gap-2 text-slate-200">
                              {item.teamLogoUrl ? (
                                <img src={item.teamLogoUrl} alt={item.teamName} className="h-4 w-4 rounded border border-white/20 bg-white object-contain p-0.5" />
                              ) : (
                                <span className="flex h-4 w-4 items-center justify-center rounded border border-white/20 text-[9px] text-slate-400">EQ</span>
                              )}
                              {item.playerName} · #{item.playerNumber > 0 ? item.playerNumber : '--'} · {item.assists} asist.{item.assists === 1 ? '' : 's'}
                            </p>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-300">
                        <span>Página {assistsPagination.currentPage}/{assistsPagination.totalPages}</span>
                        <div className="flex gap-1">
                          <button type="button" onClick={() => setAssistsPage((current) => Math.max(1, current - 1))} disabled={assistsPagination.currentPage <= 1} className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50">◀</button>
                          <button type="button" onClick={() => setAssistsPage((current) => Math.min(assistsPagination.totalPages, current + 1))} disabled={assistsPagination.currentPage >= assistsPagination.totalPages} className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50">▶</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {activeHistoryTab === 'yellows' && (
                    <div ref={(node) => { historyTableRefs.current.yellows = node }} className="rounded border border-white/10 bg-slate-900/70 p-2">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-white">Tabla TA</p>
                        <input
                          value={yellowsSearchTerm}
                          onChange={(event) => setYellowsSearchTerm(event.target.value)}
                          placeholder="Buscar..."
                          className="w-36 rounded border border-white/20 bg-slate-800 px-2 py-1 text-[11px] text-white placeholder:text-slate-400"
                        />
                      </div>
                      <div className="max-h-64 space-y-1 overflow-auto text-xs text-slate-200">
                        {yellowsPagination.totalItems === 0 && <p className="text-slate-400">Sin datos.</p>}
                        {yellowsPagination.pageItems.map((item, index) => (
                          <div key={`yellow-${item.playerId}`} className="rounded border border-white/10 bg-slate-800 px-2 py-1">
                            <p className="font-semibold text-white">{(yellowsPagination.currentPage - 1) * 10 + index + 1}. {item.teamName}</p>
                            <p className="flex items-center gap-2 text-slate-200">
                              {item.teamLogoUrl ? (
                                <img src={item.teamLogoUrl} alt={item.teamName} className="h-4 w-4 rounded border border-white/20 bg-white object-contain p-0.5" />
                              ) : (
                                <span className="flex h-4 w-4 items-center justify-center rounded border border-white/20 text-[9px] text-slate-400">EQ</span>
                              )}
                              {item.playerName} · #{item.playerNumber > 0 ? item.playerNumber : '--'} · {item.yellows} TA
                            </p>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-300">
                        <span>Página {yellowsPagination.currentPage}/{yellowsPagination.totalPages}</span>
                        <div className="flex gap-1">
                          <button type="button" onClick={() => setYellowsPage((current) => Math.max(1, current - 1))} disabled={yellowsPagination.currentPage <= 1} className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50">◀</button>
                          <button type="button" onClick={() => setYellowsPage((current) => Math.min(yellowsPagination.totalPages, current + 1))} disabled={yellowsPagination.currentPage >= yellowsPagination.totalPages} className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50">▶</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {activeHistoryTab === 'reds' && (
                    <div ref={(node) => { historyTableRefs.current.reds = node }} className="rounded border border-white/10 bg-slate-900/70 p-2">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-white">Tabla TR</p>
                        <input
                          value={redsSearchTerm}
                          onChange={(event) => setRedsSearchTerm(event.target.value)}
                          placeholder="Buscar..."
                          className="w-36 rounded border border-white/20 bg-slate-800 px-2 py-1 text-[11px] text-white placeholder:text-slate-400"
                        />
                      </div>
                      <div className="max-h-64 space-y-1 overflow-auto text-xs text-slate-200">
                        {redsPagination.totalItems === 0 && <p className="text-slate-400">Sin datos.</p>}
                        {redsPagination.pageItems.map((item, index) => (
                          <div key={`red-${item.playerId}`} className="rounded border border-white/10 bg-slate-800 px-2 py-1">
                            <p className="font-semibold text-white">{(redsPagination.currentPage - 1) * 10 + index + 1}. {item.teamName}</p>
                            <p className="flex items-center gap-2 text-slate-200">
                              {item.teamLogoUrl ? (
                                <img src={item.teamLogoUrl} alt={item.teamName} className="h-4 w-4 rounded border border-white/20 bg-white object-contain p-0.5" />
                              ) : (
                                <span className="flex h-4 w-4 items-center justify-center rounded border border-white/20 text-[9px] text-slate-400">EQ</span>
                              )}
                              {item.playerName} · #{item.playerNumber > 0 ? item.playerNumber : '--'} · {item.reds} TR
                            </p>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-300">
                        <span>Página {redsPagination.currentPage}/{redsPagination.totalPages}</span>
                        <div className="flex gap-1">
                          <button type="button" onClick={() => setRedsPage((current) => Math.max(1, current - 1))} disabled={redsPagination.currentPage <= 1} className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50">◀</button>
                          <button type="button" onClick={() => setRedsPage((current) => Math.min(redsPagination.totalPages, current + 1))} disabled={redsPagination.currentPage >= redsPagination.totalPages} className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50">▶</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-fuchsia-300/20 bg-fuchsia-900/10 p-3">
                  <div className="mb-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => void downloadHistoryTop5Png()}
                      className="rounded border border-fuchsia-300/40 bg-fuchsia-500/20 px-3 py-1 text-xs font-semibold text-fuchsia-100"
                    >
                      Descargar Top 5 PNG
                    </button>
                  </div>
                  <div ref={historyTop5CardRef} className="rounded border border-fuchsia-200/40 bg-slate-900/70 p-3">
                  <p className="text-sm font-semibold text-white">Top 5 · Jugadora de la fecha (acumulado temporada)</p>
                  <div className="mt-2 space-y-2 text-xs text-slate-200">
                    {roundAwardsRanking.length === 0 && (
                      <p className="text-slate-400">Aún no hay votos acumulados de jugadora de la fecha.</p>
                    )}
                    {roundAwardsRanking.slice(0, 5).map((item, index) => (
                      <p key={item.playerId} className="rounded border border-white/10 bg-slate-800 px-2 py-1">
                        {index + 1}. {item.playerName} ({item.teamName}) · {item.votes} voto{item.votes === 1 ? '' : 's'}
                      </p>
                    ))}
                    {roundAwardsRanking[0] && (
                      <p className="rounded border border-emerald-300/40 bg-emerald-500/10 px-2 py-1 text-emerald-100">
                        Lidera la temporada: {roundAwardsRanking[0].playerName} ({roundAwardsRanking[0].teamName})
                      </p>
                    )}
                  </div>
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
                  <p className="mb-2 text-sm font-semibold text-white">Partidos jugados</p>
                  <div className="max-h-64 space-y-2 overflow-auto pr-1 text-xs text-slate-200">
                    {historyRecords.length === 0 && <p className="text-slate-400">No hay partidos jugados en esta categoría.</p>}
                    {historyRecords
                      .slice()
                      .sort((a, b) => (a.playedAt < b.playedAt ? 1 : -1))
                      .map((record) => (
                        <div key={record.matchId} className="rounded border border-white/10 bg-slate-800 px-3 py-2">
                          <p className="text-white">
                            {getRoundLabel(record.round)}: {record.homeTeamName} {record.homeStats.goals} - {record.awayStats.goals}{' '}
                            {record.awayTeamName}
                            {record.penaltyShootout ? ` (Pen ${record.penaltyShootout.home}-${record.penaltyShootout.away})` : ''}
                          </p>
                          <p className="text-slate-300">
                            Jugador del partido: {record.playerOfMatchName ?? 'No definido'} • Minuto final: {record.finalMinute}
                          </p>
                        </div>
                      ))}
                  </div>
                </div>
              </>
            )}
          </section>
        )}

        {showMvpModal && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/75 px-4 backdrop-blur-[2px]">
            <div
              className="w-full max-w-3xl rounded-2xl border border-white/15 bg-slate-900 p-4 shadow-2xl shadow-black/40"
              style={{ animation: 'mvpModalPop 180ms ease-out' }}
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-white">Selecciona MVP para cerrar el partido</h3>
                  <p className="text-xs text-slate-300">
                    Se guardará historial completo, estadísticas y tabla de posiciones al confirmar.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowMvpModal(false)}
                  disabled={finishingMatch}
                  className="rounded border border-white/20 bg-slate-800 px-2 py-1 text-xs text-slate-200 disabled:opacity-50"
                >
                  Cerrar
                </button>
              </div>

              <div className="mb-3 flex flex-wrap items-center gap-2">
                <input
                  value={mvpSearchTerm}
                  onChange={(event) => setMvpSearchTerm(event.target.value)}
                  placeholder="Buscar jugadora o equipo..."
                  className="w-full rounded border border-white/20 bg-slate-800 px-3 py-2 text-xs text-white placeholder:text-slate-400 sm:flex-1"
                />
                <span className="rounded border border-white/15 bg-slate-800 px-2 py-1 text-[11px] text-slate-300">
                  {filteredMvpCandidates.length} candidatas
                </span>
              </div>

              <div className="grid max-h-[55vh] gap-2 overflow-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
                {filteredMvpCandidates.map((candidate) => {
                  const active = selectedMvpPlayerId === candidate.id
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => setSelectedMvpPlayerId(candidate.id)}
                      className={`rounded-xl border p-2 text-left transition ${
                        active
                          ? 'border-primary-300/60 bg-primary-500/20'
                          : 'border-white/10 bg-slate-800 hover:border-white/25 hover:bg-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {candidate.photoUrl ? (
                          <img
                            src={candidate.photoUrl}
                            alt={candidate.name}
                            className="h-10 w-10 rounded-full border border-white/20 object-cover"
                          />
                        ) : (
                          <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 text-xs text-slate-300">
                            #{candidate.number}
                          </span>
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold text-white">{candidate.name}</p>
                          <p className="truncate text-[11px] text-slate-300">{candidate.teamName}</p>
                          <p className="text-[10px] text-slate-400">#{candidate.number}</p>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>

              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowMvpModal(false)}
                  disabled={finishingMatch}
                  className="rounded border border-white/20 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void finalizeMatchWithMvp()}
                  disabled={finishingMatch || !selectedMvpPlayerId}
                  className="rounded border border-primary-300/50 bg-primary-600/25 px-3 py-2 text-xs font-semibold text-primary-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {finishingMatch ? 'Cerrando y guardando...' : 'Confirmar cierre y guardar'}
                </button>
              </div>
            </div>
          </div>
        )}

        <style>{`
          @keyframes mvpModalPop {
            0% {
              opacity: 0;
              transform: translateY(10px) scale(0.98);
            }
            100% {
              opacity: 1;
              transform: translateY(0) scale(1);
            }
          }
        `}</style>

      </main>

      <StoreFooter />
    </div>
  )
}

export default App
