import { toPng } from 'html-to-image'
import JSZip from 'jszip'
import jsQR from 'jsqr'
import QRCode from 'qrcode'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiService } from '../services/api'
import type { FixtureResponse, FixtureScheduleEntry, PlayedMatchRecord, RegisteredTeam, RoundAwardsRankingEntry } from '../types/admin.ts'
import type { League } from '../types/league.ts'

interface AdminTeamsPanelProps {
  leagues: League[]
  selectedLeague: League | null
  onLeaguesReload: () => Promise<void>
  onLeagueSelect: (leagueId: string) => void
}

interface PlayerDraft {
  name: string
  nickname: string
  age: number
  number: number
  position: string
  registrationStatus: 'pending' | 'registered'
  photoUrl: string
}

interface LeagueEditDraft {
  name: string
  country: string
  season: number
  slogan: string
  themeColor: string
  backgroundImageUrl: string
  logoUrl: string
}

interface TechnicalPersonDraft {
  name: string
  photoUrl: string
}

interface FixtureDraftMatch {
  id: string
  homeTeamId: string
  awayTeamId: string
  scheduledAt: string
  venue?: string
  sourceMatchId?: string
}

interface RoundMatchBestPlayerDraft {
  matchKey: string
  homeTeamId: string
  awayTeamId: string
  playerId: string
  playerName: string
  teamId: string
  teamName: string
}

interface RoundAwardsDraft {
  matchBestPlayers: RoundMatchBestPlayerDraft[]
  roundBestPlayerId: string
}

type AdminTab = 'ligas' | 'equipos' | 'jugadores' | 'carnet' | 'fixture' | 'mvp'
type ConfirmAction =
  | { type: 'delete-league'; leagueId: string; label: string }
  | { type: 'delete-team'; teamId: string; label: string }
  | { type: 'delete-player'; teamId: string; playerId: string; label: string }
  | null

const defaultPlayerDraft: PlayerDraft = {
  name: '',
  nickname: '',
  age: 18,
  number: 1,
  position: 'POR',
  registrationStatus: 'pending',
  photoUrl: '',
}

const playerPositionOptions = ['POR', 'DEF', 'MED', 'DEL'] as const

const normalizePosition = (value: string) => {
  const normalized = value.trim().toUpperCase()
  return playerPositionOptions.includes(normalized as (typeof playerPositionOptions)[number]) ? normalized : 'POR'
}

const categoryTemplates = [
  { key: 'libre', name: 'Libre', minAge: 16, maxAge: null, matchMinutes: 90 },
  { key: 'senior', name: 'Senior', minAge: 30, maxAge: 39, matchMinutes: 80 },
  { key: 'master', name: 'Master', minAge: 40, maxAge: 49, matchMinutes: 70 },
  { key: 'super-master', name: 'Super Master', minAge: 50, maxAge: null, matchMinutes: 60 },
]

const toDataUrl = async (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'))
    reader.readAsDataURL(file)
  })
}

const createDraftId = () => {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const normalizeScheduledAt = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.includes('T')) return trimmed

  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) return trimmed

  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  const hours = String(parsed.getHours()).padStart(2, '0')
  const minutes = String(parsed.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

const abbreviateTeamName = (name: string) => {
  const normalized = name.trim().replace(/\s+/g, ' ')
  if (!normalized) return 'Equipo'
  if (normalized.length <= 16) return normalized

  const parts = normalized.split(' ')
  if (parts.length === 1) return `${normalized.slice(0, 13)}…`

  const first = parts[0]
  const rest = parts.slice(1).join(' ')
  const compact = `${first[0]?.toUpperCase() ?? ''}. ${rest}`
  if (compact.length <= 16) return compact
  return `${compact.slice(0, 13)}…`
}

const normalizeLabel = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

const loadImageAsDataUrl = async (src?: string) => {
  if (!src) return ''
  if (src.startsWith('data:')) return src

  try {
    const response = await fetch(src)
    if (!response.ok) return ''
    const blob = await response.blob()

    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
      reader.onerror = () => reject(new Error('No se pudo convertir imagen'))
      reader.readAsDataURL(blob)
    })
  } catch {
    return ''
  }
}

const normalizeHexColor = (value?: string) => {
  if (!value) return '#0f172a'
  const raw = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
  }
  return '#0f172a'
}

const hexToRgb = (hex: string) => {
  const normalized = normalizeHexColor(hex)
  const parsed = Number.parseInt(normalized.slice(1), 16)
  return {
    r: (parsed >> 16) & 255,
    g: (parsed >> 8) & 255,
    b: parsed & 255,
  }
}

const toRgba = (hex: string, alpha: number) => {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const getContrastTextColor = (hex: string) => {
  const { r, g, b } = hexToRgb(hex)
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return luminance > 0.58 ? '#0f172a' : '#f8fafc'
}

const createManualMatchId = (round: number, homeTeamId: string, awayTeamId: string) =>
  `manual__${round}__${homeTeamId}__${awayTeamId}`

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

const getMatchKeyFromSchedule = (match: { homeTeamId: string; awayTeamId: string }) =>
  makeRoundMatchKey(match.homeTeamId, match.awayTeamId)

const makeRoundMatchKey = (homeTeamId: string, awayTeamId: string) => `${homeTeamId}:${awayTeamId}`

const managementFlowSteps = [
  { id: 1, label: 'Crear liga', hint: 'Pestaña Ligas' },
  { id: 2, label: 'Configuración', hint: 'Menú superior > Configuración' },
  { id: 3, label: 'Equipos', hint: 'Pestaña Equipos' },
  { id: 4, label: 'Jugadores', hint: 'Pestaña Jugadores' },
  { id: 5, label: 'Fixture', hint: 'Pestaña Fixture' },
] as const

const TeamLogo = ({
  logoUrl,
  name,
  sizeClass,
}: {
  logoUrl?: string
  name: string
  sizeClass: string
}) => {
  const [broken, setBroken] = useState(false)
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <div className={`relative flex ${sizeClass} items-center justify-center overflow-hidden rounded border border-slate-300 bg-slate-100 text-[10px] font-semibold text-slate-700`}>
      <span>{initials || 'EQ'}</span>
      {logoUrl && !broken && (
        <img
          src={logoUrl}
          alt={name}
          crossOrigin="anonymous"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full bg-white object-contain p-0.5"
          onError={() => setBroken(true)}
        />
      )}
    </div>
  )
}

export const AdminTeamsPanel = ({ leagues, selectedLeague, onLeaguesReload, onLeagueSelect }: AdminTeamsPanelProps) => {
  const socialCardRef = useRef<HTMLDivElement | null>(null)
  const roundAwardsCardRef = useRef<HTMLDivElement | null>(null)
  const digitalCardRef = useRef<HTMLDivElement | null>(null)
  const qrVideoRef = useRef<HTMLVideoElement | null>(null)
  const qrScanIntervalRef = useRef<number | null>(null)
  const qrVideoStreamRef = useRef<MediaStream | null>(null)
  const [tab, setTab] = useState<AdminTab>('ligas')
  const [teams, setTeams] = useState<RegisteredTeam[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState('')
  const [selectedTeamId, setSelectedTeamId] = useState('')
  const [teamName, setTeamName] = useState('')
  const [teamLogoUrl, setTeamLogoUrl] = useState('')
  const [teamPrimaryColor, setTeamPrimaryColor] = useState('#3b82f6')
  const [teamSecondaryColor, setTeamSecondaryColor] = useState('')

  const [newLeagueName, setNewLeagueName] = useState('')
  const [newLeagueCountry, setNewLeagueCountry] = useState('Ecuador')
  const [newLeagueSeason, setNewLeagueSeason] = useState(2026)
  const [newLeagueSlogan, setNewLeagueSlogan] = useState('')
  const [newLeagueThemeColor, setNewLeagueThemeColor] = useState('')
  const [newLeagueBackgroundImageUrl, setNewLeagueBackgroundImageUrl] = useState('')
  const [newLeagueLogoUrl, setNewLeagueLogoUrl] = useState('')
  const [newLeagueCategoryKey, setNewLeagueCategoryKey] = useState(categoryTemplates[0]?.key ?? 'libre')
  const [teamDirectorDraft, setTeamDirectorDraft] = useState<TechnicalPersonDraft>({ name: '', photoUrl: '' })
  const [teamAssistantDraft, setTeamAssistantDraft] = useState<TechnicalPersonDraft>({ name: '', photoUrl: '' })

  const [playerDraftByTeam, setPlayerDraftByTeam] = useState<Record<string, PlayerDraft>>({})
  const [leagueEditById, setLeagueEditById] = useState<Record<string, LeagueEditDraft>>({})
  const [teamEditById, setTeamEditById] = useState<Record<string, {
    name: string
    logoUrl: string
    primaryColor: string
    secondaryColor: string
    directorName: string
    directorPhotoUrl: string
    assistantName: string
    assistantPhotoUrl: string
  }>>({})
  const [playerEditById, setPlayerEditById] = useState<Record<string, PlayerDraft>>({})
  const [playerReplacementByTeam, setPlayerReplacementByTeam] = useState<Record<string, { enabled: boolean; replacePlayerId: string }>>({})

  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null)
  const [fixture, setFixture] = useState<FixtureResponse | null>(null)
  const [fixtureScheduleEntries, setFixtureScheduleEntries] = useState<FixtureScheduleEntry[]>([])
  const [selectedFixtureRound, setSelectedFixtureRound] = useState('')
  const [fixtureDraftMatchesByRound, setFixtureDraftMatchesByRound] = useState<Record<number, FixtureDraftMatch[]>>({})
  const [draftMatchHomeTeamId, setDraftMatchHomeTeamId] = useState('')
  const [draftMatchAwayTeamId, setDraftMatchAwayTeamId] = useState('')
  const [draftMatchScheduledAt, setDraftMatchScheduledAt] = useState('')
  const [draftMatchVenue, setDraftMatchVenue] = useState('')
  const [roundAwardsByRound, setRoundAwardsByRound] = useState<Record<number, RoundAwardsDraft>>({})
  const [roundAwardsRanking, setRoundAwardsRanking] = useState<RoundAwardsRankingEntry[]>([])
  const [playedMatchesCountByRound, setPlayedMatchesCountByRound] = useState<Record<number, number>>({})
  const [playedMatchesRecords, setPlayedMatchesRecords] = useState<PlayedMatchRecord[]>([])
  const [isSavingFixtureRound, setIsSavingFixtureRound] = useState(false)
  const [isRefreshingFixture, setIsRefreshingFixture] = useState(false)
  const [mobileLogoOnlyMode, setMobileLogoOnlyMode] = useState(true)
  const [mvpMobileLogoOnlyMode, setMvpMobileLogoOnlyMode] = useState(true)

  const [leagueSearch, setLeagueSearch] = useState('')
  const [leaguePage, setLeaguePage] = useState(1)

  const [teamSearch, setTeamSearch] = useState('')
  const [teamPage, setTeamPage] = useState(1)

  const [playerSearch, setPlayerSearch] = useState('')
  const [playerPositionFilter, setPlayerPositionFilter] = useState<'TODAS' | 'POR' | 'DEF' | 'MED' | 'DEL'>('TODAS')
  const [playerPage, setPlayerPage] = useState(1)
  const [digitalCardTeamId, setDigitalCardTeamId] = useState('')
  const [digitalCardPlayerId, setDigitalCardPlayerId] = useState('')
  const [isGeneratingBulkCards, setIsGeneratingBulkCards] = useState(false)
  const [digitalCardLeagueLogoDataUrl, setDigitalCardLeagueLogoDataUrl] = useState('')
  const [digitalCardLeagueLogoOverrideDataUrl, setDigitalCardLeagueLogoOverrideDataUrl] = useState('')
  const [digitalCardTeamLogoDataUrl, setDigitalCardTeamLogoDataUrl] = useState('')
  const [digitalCardPlayerPhotoDataUrl, setDigitalCardPlayerPhotoDataUrl] = useState('')
  const [digitalCardQrDataUrl, setDigitalCardQrDataUrl] = useState('')
  const [qrManualInput, setQrManualInput] = useState('')
  const [qrValidationState, setQrValidationState] = useState<{ ok: boolean; title: string; details: string[] } | null>(null)
  const [isQrScanning, setIsQrScanning] = useState(false)
  const [qrScanError, setQrScanError] = useState('')

  const [videoFormByMatch, setVideoFormByMatch] = useState<Record<string, { file: File | null; name: string; url: string; mode: 'file' | 'url' }>>({})
  const [videoUploadingByMatch, setVideoUploadingByMatch] = useState<Record<string, boolean>>({})


  const categoryOptions = useMemo(() => selectedLeague?.categories ?? [], [selectedLeague])
  const activeCategoryId =
    selectedCategoryId && categoryOptions.some((category) => category.id === selectedCategoryId)
      ? selectedCategoryId
      : (categoryOptions[0]?.id ?? '')

  const activeCategoryRules = categoryOptions.find((category) => category.id === activeCategoryId)?.rules
  const activeCategoryCourtsCount = Math.max(1, activeCategoryRules?.courtsCount ?? 1)
  const activeCategoryMaxRegisteredPlayers = Math.max(5, activeCategoryRules?.maxRegisteredPlayers ?? 25)

  const selectedTeam = useMemo(() => {
    if (selectedTeamId) {
      return teams.find((team) => team.id === selectedTeamId) ?? teams[0] ?? null
    }

    return teams[0] ?? null
  }, [selectedTeamId, teams])

  const showMessage = (value: string) => {
    setMessage(value)
    window.setTimeout(() => setMessage(''), 3000)
  }

  const latestSeason = useMemo(() => {
    if (leagues.length === 0) return 2026
    return Math.max(...leagues.map((league) => league.season))
  }, [leagues])

  const isReadOnlySeason = Boolean(selectedLeague && selectedLeague.season < latestSeason)

  const buildSlug = (value: string) =>
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')

  const loadTeams = useCallback(async () => {
    if (!selectedLeague || !activeCategoryId) {
      setTeams([])
      return
    }

    const response = await apiService.getLeagueTeams(selectedLeague.id, activeCategoryId)
    if (response.ok) {
      setTeams(response.data)
    } else {
      showMessage(response.message)
    }
  }, [activeCategoryId, selectedLeague])

  useEffect(() => {
    queueMicrotask(() => {
      void loadTeams()
    })
  }, [loadTeams])

  const loadFixture = useCallback(async () => {
    if (!selectedLeague || !activeCategoryId) {
      setFixture(null)
      setFixtureScheduleEntries([])
      setSelectedFixtureRound('')
      setRoundAwardsByRound({})
      setRoundAwardsRanking([])
      setPlayedMatchesCountByRound({})
      setPlayedMatchesRecords([])
      return
    }

    const [fixtureResponse, scheduleResponse, roundAwardsResponse, rankingResponse, playedResponse] = await Promise.all([
      apiService.getLeagueFixture(selectedLeague.id, activeCategoryId),
      apiService.getFixtureSchedule(selectedLeague.id, activeCategoryId),
      apiService.getRoundAwards(selectedLeague.id, activeCategoryId),
      apiService.getRoundAwardsRanking(selectedLeague.id, activeCategoryId),
      apiService.getPlayedMatches(selectedLeague.id, activeCategoryId),
    ])

    if (fixtureResponse.ok) {
      setFixture(fixtureResponse.data)
      const availableRounds = fixtureResponse.data.rounds.map((round) => round.round).sort((a, b) => a - b)
      if (availableRounds.length > 0) {
        setSelectedFixtureRound((current) =>
          current && availableRounds.includes(Number(current)) ? current : String(availableRounds[0]),
        )
      } else {
        setSelectedFixtureRound('')
      }
    } else {
      setFixture(null)
      showMessage(fixtureResponse.message)
    }

    if (scheduleResponse.ok) {
      setFixtureScheduleEntries(scheduleResponse.data)
    } else {
      setFixtureScheduleEntries([])
    }

    if (roundAwardsResponse.ok) {
      const nextAwardsByRound: Record<number, RoundAwardsDraft> = {}
      roundAwardsResponse.data.forEach((entry) => {
        nextAwardsByRound[entry.round] = {
          matchBestPlayers: entry.matchBestPlayers.map((item) => ({ ...item })),
          roundBestPlayerId: entry.roundBestPlayerId ?? '',
        }
      })
      setRoundAwardsByRound(nextAwardsByRound)
    } else {
      setRoundAwardsByRound({})
    }

    if (rankingResponse.ok) {
      setRoundAwardsRanking(rankingResponse.data)
    } else {
      setRoundAwardsRanking([])
    }

    if (playedResponse.ok) {
      const nextCounts: Record<number, number> = {}
      playedResponse.data.forEach((record) => {
        nextCounts[record.round] = (nextCounts[record.round] ?? 0) + 1
      })
      setPlayedMatchesCountByRound(nextCounts)
      setPlayedMatchesRecords(playedResponse.data)
    } else {
      setPlayedMatchesCountByRound({})
      setPlayedMatchesRecords([])
    }
  }, [activeCategoryId, selectedLeague])

  useEffect(() => {
    queueMicrotask(() => {
      void loadFixture()
    })
  }, [loadFixture])

  const handleCreateLeague = async () => {
    const name = newLeagueName.trim()
    const categoryTemplate = categoryTemplates.find((item) => item.key === newLeagueCategoryKey)
    if (!name || !categoryTemplate) return

    const slug = buildSlug(name)

    const response = await apiService.createLeague({
      name,
      slug,
      country: newLeagueCountry.trim() || 'Ecuador',
      season: newLeagueSeason,
      slogan: newLeagueSlogan.trim() || undefined,
      themeColor: newLeagueThemeColor.trim() || undefined,
      backgroundImageUrl: newLeagueBackgroundImageUrl || undefined,
      logoUrl: newLeagueLogoUrl || undefined,
      categories: [
        {
          name: categoryTemplate.name,
          minAge: categoryTemplate.minAge,
          maxAge: categoryTemplate.maxAge,
          rules: {
            playersOnField: 11,
            maxRegisteredPlayers: 25,
            matchMinutes: categoryTemplate.matchMinutes,
            breakMinutes: 15,
            allowDraws: true,
            pointsWin: 3,
            pointsDraw: 1,
            pointsLoss: 0,
            courtsCount: 1,
          },
        },
      ],
    })

    if (!response.ok) {
      showMessage(response.message)
      return
    }

    setNewLeagueName('')
    setNewLeagueBackgroundImageUrl('')
    setNewLeagueLogoUrl('')
    setNewLeagueSeason(2026)
    setNewLeagueSlogan('')
    setNewLeagueThemeColor('')
    showMessage('Liga creada correctamente')
    await onLeaguesReload()
    onLeagueSelect(response.data.id)
    setTab('equipos')
  }

  const handleCreateTeam = async () => {
    if (isReadOnlySeason) {
      showMessage('Temporada histórica: solo lectura')
      return
    }

    if (loading) return
    if (!selectedLeague) {
      showMessage('Selecciona una liga antes de crear equipo')
      return
    }
    if (!activeCategoryId) {
      showMessage('Selecciona una categoría para crear equipo')
      return
    }
    if (!teamName.trim()) {
      showMessage('Ingresa el nombre del equipo')
      return
    }

    if (!teamPrimaryColor.trim()) {
      showMessage('Selecciona el color principal del equipo')
      return
    }

    if (!teamDirectorDraft.name.trim() || !teamAssistantDraft.name.trim()) {
      showMessage('Ingresa Director Técnico y Asistente Técnico')
      return
    }

    setLoading(true)
    const response = await apiService.createTeamWithLogo(selectedLeague.id, activeCategoryId, teamName, teamLogoUrl, {
      primaryColor: teamPrimaryColor,
      secondaryColor: teamSecondaryColor || undefined,
      director: {
        name: teamDirectorDraft.name.trim(),
        ...(teamDirectorDraft.photoUrl ? { photoUrl: teamDirectorDraft.photoUrl } : {}),
      },
      assistant: {
        name: teamAssistantDraft.name.trim(),
        ...(teamAssistantDraft.photoUrl ? { photoUrl: teamAssistantDraft.photoUrl } : {}),
      },
    })
    if (!response.ok) {
      showMessage(response.message)
      setLoading(false)
      return
    }

    setTeamName('')
    setTeamLogoUrl('')
    setTeamPrimaryColor('#3b82f6')
    setTeamSecondaryColor('')
    setTeamDirectorDraft({ name: '', photoUrl: '' })
    setTeamAssistantDraft({ name: '', photoUrl: '' })
    showMessage('Equipo creado')
    await loadTeams()
    setLoading(false)
  }

  const fixtureMatches = useMemo(() => {
    if (!fixture || !Array.isArray(fixture.rounds)) return [] as Array<{ id: string; round: number; homeTeamId: string; awayTeamId: string }>

    const result: Array<{ id: string; round: number; homeTeamId: string; awayTeamId: string }> = []
    fixture.rounds.forEach((round) => {
      if (!round || !Array.isArray(round.matches)) return
      round.matches.forEach((match, index) => {
        if (!match || match.hasBye || !match.awayTeamId) return
        result.push({
          id: `${round.round}-${index}-${match.homeTeamId}-${match.awayTeamId}`,
          round: round.round,
          homeTeamId: match.homeTeamId,
          awayTeamId: match.awayTeamId,
        })
      })
    })

    return result
  }, [fixture])

  const teamMap = useMemo(() => new Map(teams.map((team) => [team.id, team])), [teams])

  const sortedTeams = useMemo(() => {
    return [...teams]
      .filter((team) => team.active !== false)
      .sort((left, right) => left.name.localeCompare(right.name, 'es', { sensitivity: 'base' }))
  }, [teams])

  const fixtureRounds = useMemo(() => {
    return Array.from(new Set(fixtureMatches.map((match) => match.round))).sort((a, b) => a - b)
  }, [fixtureMatches])

  const activeFixtureRound =
    selectedFixtureRound && fixtureRounds.includes(Number(selectedFixtureRound))
      ? Number(selectedFixtureRound)
      : (fixtureRounds[0] ?? 0)

  const fixtureMatchesByRound = useMemo(() => {
    return fixtureMatches.filter((match) => match.round === activeFixtureRound)
  }, [activeFixtureRound, fixtureMatches])

  const scheduledRoundMatches = useMemo(() => {
    if (!activeFixtureRound) return [] as Array<{ matchId: string; homeTeamId: string; awayTeamId: string; scheduledAt: string; venue?: string }>

    return fixtureScheduleEntries
      .filter((entry) => entry.round === activeFixtureRound)
      .map((entry) => {
        const fixtureMatch = fixtureMatchesByRound.find((match) => match.id === entry.matchId)
        if (fixtureMatch) {
          return {
            matchId: entry.matchId,
            homeTeamId: fixtureMatch.homeTeamId,
            awayTeamId: fixtureMatch.awayTeamId,
            scheduledAt: entry.scheduledAt,
            ...(entry.venue ? { venue: entry.venue } : {}),
          }
        }

        const manualMatch = parseManualMatchId(entry.matchId, activeFixtureRound)
        if (!manualMatch) return null
        if (!teamMap.has(manualMatch.homeTeamId) || !teamMap.has(manualMatch.awayTeamId)) return null

        return {
          matchId: entry.matchId,
          homeTeamId: manualMatch.homeTeamId,
          awayTeamId: manualMatch.awayTeamId,
          scheduledAt: entry.scheduledAt,
          ...(entry.venue ? { venue: entry.venue } : {}),
        }
      })
      .filter((item): item is { matchId: string; homeTeamId: string; awayTeamId: string; scheduledAt: string; venue?: string } => Boolean(item))
      .sort((left, right) => {
        const leftTime = left.scheduledAt ? new Date(left.scheduledAt).getTime() : Number.POSITIVE_INFINITY
        const rightTime = right.scheduledAt ? new Date(right.scheduledAt).getTime() : Number.POSITIVE_INFINITY
        return leftTime - rightTime
      })
  }, [activeFixtureRound, fixtureMatchesByRound, fixtureScheduleEntries, teamMap])

  const hasPublishedRoundMatches = scheduledRoundMatches.length > 0

  const activeRoundDraftMatches = useMemo(
    () => fixtureDraftMatchesByRound[activeFixtureRound] ?? [],
    [activeFixtureRound, fixtureDraftMatchesByRound],
  )

  const usedTeamIdsInDraftRound = useMemo(() => {
    const used = new Set<string>()
    activeRoundDraftMatches.forEach((match) => {
      used.add(match.homeTeamId)
      used.add(match.awayTeamId)
    })
    return used
  }, [activeRoundDraftMatches])

  const availableHomeTeamsForDraft = useMemo(() => {
    return sortedTeams.filter(
      (team) => !usedTeamIdsInDraftRound.has(team.id) || team.id === draftMatchHomeTeamId || team.id === draftMatchAwayTeamId,
    )
  }, [draftMatchAwayTeamId, draftMatchHomeTeamId, sortedTeams, usedTeamIdsInDraftRound])

  const availableAwayTeamsForDraft = useMemo(() => {
    return sortedTeams.filter((team) => {
      if (team.id === draftMatchHomeTeamId) return false

      return !usedTeamIdsInDraftRound.has(team.id) || team.id === draftMatchAwayTeamId
    })
  }, [draftMatchAwayTeamId, draftMatchHomeTeamId, sortedTeams, usedTeamIdsInDraftRound])

  const filteredLeagues = useMemo(() => {
    const needle = leagueSearch.trim().toLowerCase()
    if (!needle) return leagues
    return leagues.filter((league) => {
      const text = `${league.name} ${league.country} ${league.season}`.toLowerCase()
      return text.includes(needle)
    })
  }, [leagueSearch, leagues])

  const filteredTeams = useMemo(() => {
    const needle = teamSearch.trim().toLowerCase()
    if (!needle) return teams
    return teams.filter((team) => team.name.toLowerCase().includes(needle))
  }, [teamSearch, teams])

  const filteredPlayers = useMemo(() => {
    if (!selectedTeam) return []

    const needle = playerSearch.trim().toLowerCase()
    return selectedTeam.players.filter((player) => {
      const position = normalizePosition(player.position)
      const byPosition = playerPositionFilter === 'TODAS' || position === playerPositionFilter
      if (!byPosition) return false
      if (!needle) return true
      return `${player.name} ${player.nickname}`.toLowerCase().includes(needle)
    })
  }, [playerPositionFilter, playerSearch, selectedTeam])

  const paginate = <T,>(items: T[], page: number, size: number) => {
    const totalPages = Math.max(1, Math.ceil(items.length / size))
    const currentPage = Math.min(Math.max(page, 1), totalPages)
    const offset = (currentPage - 1) * size
    return {
      currentPage,
      totalPages,
      pageItems: items.slice(offset, offset + size),
    }
  }

  const leaguePagination = paginate(filteredLeagues, leaguePage, 6)
  const teamPagination = paginate(filteredTeams, teamPage, 6)
  const playerPagination = paginate(filteredPlayers, playerPage, 8)

  const digitalCardTeam = useMemo(() => {
    if (digitalCardTeamId) {
      return teams.find((team) => team.id === digitalCardTeamId) ?? selectedTeam ?? null
    }

    return selectedTeam ?? teams[0] ?? null
  }, [digitalCardTeamId, selectedTeam, teams])

  const digitalCardPlayer = useMemo(() => {
    if (!digitalCardTeam) return null

    if (digitalCardPlayerId) {
      return digitalCardTeam.players.find((player) => player.id === digitalCardPlayerId) ?? digitalCardTeam.players[0] ?? null
    }

    return digitalCardTeam.players[0] ?? null
  }, [digitalCardPlayerId, digitalCardTeam])

  const activeCategoryName =
    categoryOptions.find((category) => category.id === activeCategoryId)?.name ?? 'Categoría'

  const digitalCardThemeColor = normalizeHexColor(selectedLeague?.themeColor)
  const digitalCardTextColor = getContrastTextColor(digitalCardThemeColor)
  const digitalCardLeagueInitials = (selectedLeague?.name ?? 'FL')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
  const digitalCardLeagueLogoSrc =
    digitalCardLeagueLogoOverrideDataUrl || digitalCardLeagueLogoDataUrl || selectedLeague?.logoUrl || ''
  const digitalCardTeamLogoSrc = digitalCardTeamLogoDataUrl || digitalCardTeam?.logoUrl || ''
  const digitalCardPlayerPhotoSrc = digitalCardPlayerPhotoDataUrl || digitalCardPlayer?.photoUrl || ''

  const validationPayload = useMemo(() => {
    if (!selectedLeague || !digitalCardTeam || !digitalCardPlayer) return ''

    return JSON.stringify({
      type: 'FL_LIGA_PLAYER_CARD',
      leagueId: selectedLeague.id,
      leagueName: selectedLeague.name,
      season: selectedLeague.season,
      categoryId: activeCategoryId,
      categoryName: activeCategoryName,
      teamId: digitalCardTeam.id,
      teamName: digitalCardTeam.name,
      playerId: digitalCardPlayer.id,
      playerName: digitalCardPlayer.name,
      number: digitalCardPlayer.number,
    })
  }, [activeCategoryId, activeCategoryName, digitalCardPlayer, digitalCardTeam, selectedLeague])

  useEffect(() => {
    let mounted = true

    const buildQr = async () => {
      if (!validationPayload) {
        if (mounted) setDigitalCardQrDataUrl('')
        return
      }

      try {
        const qr = await QRCode.toDataURL(validationPayload, {
          margin: 1,
          width: 256,
          color: {
            dark: '#0f172a',
            light: '#ffffff',
          },
        })
        if (mounted) setDigitalCardQrDataUrl(qr)
      } catch {
        if (mounted) setDigitalCardQrDataUrl('')
      }
    }

    void buildQr()

    return () => {
      mounted = false
    }
  }, [validationPayload])

  useEffect(() => {
    let mounted = true

    const loadAssets = async () => {
      const [leagueLogo, teamLogo, playerPhoto] = await Promise.all([
        loadImageAsDataUrl(selectedLeague?.logoUrl),
        loadImageAsDataUrl(digitalCardTeam?.logoUrl),
        loadImageAsDataUrl(digitalCardPlayer?.photoUrl),
      ])

      if (!mounted) return
      setDigitalCardLeagueLogoDataUrl(leagueLogo)
      setDigitalCardTeamLogoDataUrl(teamLogo)
      setDigitalCardPlayerPhotoDataUrl(playerPhoto)
    }

    void loadAssets()

    return () => {
      mounted = false
    }
  }, [digitalCardPlayer?.photoUrl, digitalCardTeam?.logoUrl, selectedLeague?.logoUrl])

  const stopQrScanner = useCallback(() => {
    if (qrScanIntervalRef.current !== null) {
      window.clearInterval(qrScanIntervalRef.current)
      qrScanIntervalRef.current = null
    }

    if (qrVideoStreamRef.current) {
      qrVideoStreamRef.current.getTracks().forEach((track) => track.stop())
      qrVideoStreamRef.current = null
    }

    if (qrVideoRef.current) {
      qrVideoRef.current.srcObject = null
    }

    setIsQrScanning(false)
  }, [])

  useEffect(() => {
    return () => {
      stopQrScanner()
    }
  }, [stopQrScanner])

  const validateQrPayload = useCallback((raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) {
      setQrValidationState({ ok: false, title: 'QR inválido', details: ['No se recibió contenido para validar.'] })
      return
    }

    let payload: {
      leagueId?: string
      leagueName?: string
      season?: number
      categoryId?: string
      categoryName?: string
      teamId?: string
      teamName?: string
      playerId?: string
      playerName?: string
      number?: number
      type?: string
    }

    try {
      payload = JSON.parse(trimmed)
    } catch {
      setQrValidationState({ ok: false, title: 'QR inválido', details: ['El contenido no tiene formato JSON válido.'] })
      return
    }

    const issues: string[] = []

    if (payload.type !== 'FL_LIGA_PLAYER_CARD') {
      issues.push('Tipo de carnet no reconocido.')
    }

    if (!selectedLeague) {
      issues.push('No hay liga seleccionada en la gestión para comparar.')
    } else {
      if (payload.leagueId !== selectedLeague.id) {
        issues.push(`Liga distinta: QR ${payload.leagueName ?? payload.leagueId ?? 'N/D'} vs panel ${selectedLeague.name}.`)
      }

      if (payload.season !== selectedLeague.season) {
        issues.push(`Temporada distinta: QR ${payload.season ?? 'N/D'} vs panel ${selectedLeague.season}.`)
      }
    }

    const categoryMatch = categoryOptions.find((category) => category.id === payload.categoryId)
    if (!categoryMatch) {
      issues.push('Categoría del QR no coincide con la categoría activa en el panel.')
    }

    const team = payload.teamId ? teamMap.get(payload.teamId) : undefined
    if (!team) {
      issues.push('Equipo del QR no está registrado en la categoría activa.')
    }

    const player = team?.players.find((item) => item.id === payload.playerId)
    if (!player) {
      issues.push('Jugadora del QR no pertenece al equipo/categoría activa.')
    } else {
      if (payload.playerName && normalizeLabel(payload.playerName) !== normalizeLabel(player.name)) {
        issues.push('Nombre de jugadora no coincide con el registro actual.')
      }

      if (typeof payload.number === 'number' && payload.number !== player.number) {
        issues.push(`Dorsal no coincide: QR #${payload.number} vs registro #${player.number}.`)
      }
    }

    if (issues.length > 0) {
      setQrValidationState({
        ok: false,
        title: 'Registro observado',
        details: issues,
      })
      return
    }

    setQrValidationState({
      ok: true,
      title: 'Registro OK',
      details: [
        `${player?.name ?? payload.playerName ?? 'Jugadora'} validada en ${team?.name ?? payload.teamName ?? 'equipo'}.`,
        `Categoría: ${categoryMatch?.name ?? payload.categoryName ?? 'N/D'}.`,
      ],
    })
  }, [categoryOptions, selectedLeague, teamMap])

  const startQrScanner = async () => {
    setQrScanError('')
    setQrValidationState(null)

    if (!navigator.mediaDevices?.getUserMedia) {
      setQrScanError('Este navegador no permite acceso a cámara. Usa validación por imagen o texto QR.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      })

      qrVideoStreamRef.current = stream
      if (qrVideoRef.current) {
        qrVideoRef.current.srcObject = stream
        await qrVideoRef.current.play()
      }

      setIsQrScanning(true)

      qrScanIntervalRef.current = window.setInterval(async () => {
        const video = qrVideoRef.current
        if (!video) return
        if (video.readyState < 2) return

        try {
          const canvas = document.createElement('canvas')
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          const context = canvas.getContext('2d', { willReadFrequently: true })
          if (!context) return

          context.drawImage(video, 0, 0, canvas.width, canvas.height)
          const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
          const code = jsQR(imageData.data, imageData.width, imageData.height)
          const rawValue = code?.data
          if (rawValue) {
            setQrManualInput(rawValue)
            validateQrPayload(rawValue)
            stopQrScanner()
          }
        } catch {
          // Ignorar detecciones intermedias fallidas
        }
      }, 450)
    } catch {
      setQrScanError('No se pudo iniciar la cámara para escanear QR.')
      stopQrScanner()
    }
  }

  const validateQrFromImageFile = async (file: File) => {
    setQrScanError('')

    try {
      const bitmap = await createImageBitmap(file)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) {
        bitmap.close()
        setQrScanError('No se pudo preparar la imagen para validar QR.')
        return
      }

      context.drawImage(bitmap, 0, 0)
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
      const code = jsQR(imageData.data, imageData.width, imageData.height)
      const rawValue = code?.data
      bitmap.close()

      if (!rawValue) {
        setQrValidationState({ ok: false, title: 'QR no detectado', details: ['No se detectó un código QR en la imagen cargada.'] })
        return
      }

      setQrManualInput(rawValue)
      validateQrPayload(rawValue)
    } catch {
      setQrScanError('No se pudo procesar la imagen para validar QR.')
    }
  }

  useEffect(() => {
    if (!selectedTeam) return

    setDigitalCardTeamId((current) => {
      if (current) return current
      return selectedTeam.id
    })
  }, [selectedTeam])

  useEffect(() => {
    if (!digitalCardTeam) {
      setDigitalCardPlayerId('')
      return
    }

    setDigitalCardPlayerId((current) => {
      if (current && digitalCardTeam.players.some((player) => player.id === current)) {
        return current
      }
      return digitalCardTeam.players[0]?.id ?? ''
    })
  }, [digitalCardTeam])

  const addDraftMatchToRound = () => {
    if (!activeFixtureRound) return
    if (!draftMatchHomeTeamId || !draftMatchAwayTeamId) {
      showMessage('Selecciona local y visitante para agregar el partido')
      return
    }
    if (draftMatchHomeTeamId === draftMatchAwayTeamId) {
      showMessage('Local y visitante no pueden ser el mismo equipo')
      return
    }
    if (!draftMatchScheduledAt) {
      showMessage('Selecciona fecha y hora de inicio para el partido')
      return
    }

    if (activeCategoryCourtsCount > 1 && !draftMatchVenue.trim()) {
      showMessage('Indica la cancha para este partido')
      return
    }

    const existingPair = activeRoundDraftMatches.some(
      (match) =>
        (match.homeTeamId === draftMatchHomeTeamId && match.awayTeamId === draftMatchAwayTeamId) ||
        (match.homeTeamId === draftMatchAwayTeamId && match.awayTeamId === draftMatchHomeTeamId),
    )
    if (existingPair) {
      showMessage('Este cruce ya está agregado en la fecha')
      return
    }

    const next: FixtureDraftMatch = {
      id: createDraftId(),
      homeTeamId: draftMatchHomeTeamId,
      awayTeamId: draftMatchAwayTeamId,
      scheduledAt: draftMatchScheduledAt,
      ...(draftMatchVenue.trim() ? { venue: draftMatchVenue.trim() } : {}),
    }

    setFixtureDraftMatchesByRound((current) => ({
      ...current,
      [activeFixtureRound]: [...(current[activeFixtureRound] ?? []), next],
    }))

    setDraftMatchHomeTeamId('')
    setDraftMatchAwayTeamId('')
    setDraftMatchScheduledAt('')
    setDraftMatchVenue('')
    showMessage(`Partido agregado al borrador de Fecha ${activeFixtureRound}`)
  }

  const updateDraftMatchInRound = (draftId: string, patch: Partial<FixtureDraftMatch>) => {
    if (!activeFixtureRound) return
    setFixtureDraftMatchesByRound((current) => ({
      ...current,
      [activeFixtureRound]: (current[activeFixtureRound] ?? []).map((item) =>
        item.id === draftId ? { ...item, ...patch } : item,
      ),
    }))
  }

  const deleteDraftMatchInRound = (draftId: string) => {
    if (!activeFixtureRound) return
    setFixtureDraftMatchesByRound((current) => ({
      ...current,
      [activeFixtureRound]: (current[activeFixtureRound] ?? []).filter((item) => item.id !== draftId),
    }))
  }

  const publishDraftRoundMatches = async () => {
    if (isSavingFixtureRound) return
    if (isReadOnlySeason) {
      showMessage('Temporada histórica: solo lectura')
      return
    }
    if (!selectedLeague || !activeCategoryId || !activeFixtureRound) return
    if (activeRoundDraftMatches.length === 0) {
      showMessage('No hay partidos en borrador para guardar')
      return
    }
    const fixtureMatchByPair = new Map<string, { id: string }>()
    fixtureMatchesByRound.forEach((match) => {
      fixtureMatchByPair.set(`${match.homeTeamId}:${match.awayTeamId}`, { id: match.id })
      fixtureMatchByPair.set(`${match.awayTeamId}:${match.homeTeamId}`, { id: match.id })
    })

    setIsSavingFixtureRound(true)
    try {
      const savedMatchIds = new Set<string>()
      for (const draft of activeRoundDraftMatches) {
        const fixtureMatch = fixtureMatchByPair.get(`${draft.homeTeamId}:${draft.awayTeamId}`)
        const matchId =
          draft.sourceMatchId ??
          fixtureMatch?.id ??
          createManualMatchId(activeFixtureRound, draft.homeTeamId, draft.awayTeamId)
        const scheduledAt = normalizeScheduledAt(draft.scheduledAt)

        if (!scheduledAt) {
          const homeName = teamMap.get(draft.homeTeamId)?.name ?? 'Local'
          const awayName = teamMap.get(draft.awayTeamId)?.name ?? 'Visitante'
          showMessage(`Falta fecha/hora en ${homeName} vs ${awayName}`)
          return
        }

        const response = await apiService.saveFixtureSchedule(selectedLeague.id, matchId, {
          categoryId: activeCategoryId,
          round: activeFixtureRound,
          scheduledAt,
          ...(draft.venue?.trim() ? { venue: draft.venue.trim() } : {}),
        })

        if (!response.ok) {
          showMessage(response.message)
          return
        }

        savedMatchIds.add(matchId)
      }

      const existingRoundEntries = fixtureScheduleEntries.filter(
        (entry) => entry.round === activeFixtureRound && entry.categoryId === activeCategoryId,
      )
      const playedRoundMatchIds = new Set(
        playedMatchesRecords
          .filter((record) => record.round === activeFixtureRound && record.categoryId === activeCategoryId)
          .map((record) => record.matchId),
      )

      for (const entry of existingRoundEntries) {
        if (savedMatchIds.has(entry.matchId)) continue
        if (playedRoundMatchIds.has(entry.matchId)) continue

        const deleteResponse = await apiService.deleteFixtureSchedule(selectedLeague.id, entry.matchId, activeCategoryId)
        if (!deleteResponse.ok) {
          showMessage(deleteResponse.message)
          return
        }
      }

      setFixtureDraftMatchesByRound((current) => ({
        ...current,
        [activeFixtureRound]: [],
      }))

      await loadFixture()
      showMessage(`Fecha ${activeFixtureRound} guardada correctamente`)
    } finally {
      setIsSavingFixtureRound(false)
    }
  }

  const editPublishedRoundMatches = () => {
    if (!activeFixtureRound) return
    if (scheduledRoundMatches.length === 0) {
      showMessage('No hay partidos guardados para editar en esta fecha')
      return
    }

    const draftItems: FixtureDraftMatch[] = scheduledRoundMatches.map((item) => ({
      id: createDraftId(),
      homeTeamId: item.homeTeamId,
      awayTeamId: item.awayTeamId,
      scheduledAt: normalizeScheduledAt(item.scheduledAt),
      ...(item.venue ? { venue: item.venue } : {}),
      sourceMatchId: item.matchId,
    }))

    setFixtureDraftMatchesByRound((current) => ({
      ...current,
      [activeFixtureRound]: draftItems,
    }))
    showMessage(`Fixture de Fecha ${activeFixtureRound} cargado para edición`)
  }

  const projectedFreeTeam = useMemo(() => {
    const used = new Set<string>()
    const baseMatches = hasPublishedRoundMatches ? scheduledRoundMatches : activeRoundDraftMatches
    baseMatches.forEach((match) => {
      used.add(match.homeTeamId)
      used.add(match.awayTeamId)
    })

    const remaining = sortedTeams.filter((team) => !used.has(team.id))
    if (remaining.length !== 1) return null
    return remaining[0] ?? null
  }, [activeRoundDraftMatches, hasPublishedRoundMatches, scheduledRoundMatches, sortedTeams])

  const socialDraftRoundMatches = useMemo(() => {
    return [...activeRoundDraftMatches].sort(
      (left, right) => new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime(),
    )
  }, [activeRoundDraftMatches])

  const socialMatches = hasPublishedRoundMatches
    ? scheduledRoundMatches.map((match) => ({
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        scheduledAt: match.scheduledAt,
        venue: match.venue,
      }))
    : socialDraftRoundMatches.map((match) => ({
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        scheduledAt: match.scheduledAt,
        venue: match.venue,
      }))

  const refreshFixture = async (notify = false) => {
    if (isRefreshingFixture) return
    setIsRefreshingFixture(true)
    try {
      await loadFixture()
      if (notify) {
        showMessage('Fixture actualizado desde el servidor')
      }
    } finally {
      setIsRefreshingFixture(false)
    }
  }

  const downloadSocialCardPng = async () => {
    if (!socialCardRef.current) {
      showMessage('No hay tarjeta disponible para descargar')
      return
    }

    try {
      const dataUrl = await toPng(socialCardRef.current, {
        cacheBust: true,
        pixelRatio: 2,
      })

      const fileName = `${(selectedLeague?.name ?? 'liga').replace(/\s+/g, '-').toLowerCase()}-temporada-${selectedLeague?.season ?? 'actual'}-fecha-${activeFixtureRound}.png`
      const link = document.createElement('a')
      link.download = fileName
      link.href = dataUrl
      link.click()
    } catch {
      showMessage('No se pudo generar la imagen de la fecha')
    }
  }

  const shareFixtureByWhatsapp = () => {
    if (!selectedLeague || !activeFixtureRound) {
      showMessage('Selecciona una fecha para compartir')
      return
    }

    if (socialMatches.length === 0) {
      showMessage('No hay emparejamientos para compartir')
      return
    }

    const lines: string[] = []
    lines.push(`${selectedLeague.name} · Temporada ${selectedLeague.season}`)
    lines.push(`Fecha ${activeFixtureRound}`)
    lines.push('')

    socialMatches.forEach((match) => {
      const homeName = teamMap.get(match.homeTeamId)?.name ?? 'Local'
      const awayName = teamMap.get(match.awayTeamId)?.name ?? 'Visitante'
      const startLabel = match.scheduledAt ? new Date(match.scheduledAt).toLocaleString() : 'Hora por definir'
      lines.push(`• ${homeName} vs ${awayName} · ${startLabel}`)
    })

    if (projectedFreeTeam) {
      lines.push('')
      lines.push(`Equipo libre: ${projectedFreeTeam.name}`)
    }

    const text = encodeURIComponent(lines.join('\n'))
    window.open(`https://wa.me/?text=${text}`, '_blank', 'noopener,noreferrer')
  }

  const activeRoundAwards = roundAwardsByRound[activeFixtureRound] ?? {
    matchBestPlayers: [],
    roundBestPlayerId: '',
  }

  const activeRoundMatchKeys = useMemo(
    () => new Set(scheduledRoundMatches.map((match) => getMatchKeyFromSchedule(match))),
    [scheduledRoundMatches],
  )

  const activeRoundMatchBestPlayers = useMemo(
    () => activeRoundAwards.matchBestPlayers.filter((item) => activeRoundMatchKeys.has(item.matchKey)),
    [activeRoundAwards.matchBestPlayers, activeRoundMatchKeys],
  )

  const activeRoundMatchMvpOptions = useMemo(() => {
    return scheduledRoundMatches.map((match) => {
      const homeTeam = teamMap.get(match.homeTeamId)
      const awayTeam = teamMap.get(match.awayTeamId)
      const matchKey = makeRoundMatchKey(match.homeTeamId, match.awayTeamId)
      const players = [
        ...(homeTeam?.players.map((player) => ({
          playerId: player.id,
          playerName: player.name,
          teamId: homeTeam.id,
          teamName: homeTeam.name,
        })) ?? []),
        ...(awayTeam?.players.map((player) => ({
          playerId: player.id,
          playerName: player.name,
          teamId: awayTeam.id,
          teamName: awayTeam.name,
        })) ?? []),
      ]

      return {
        match,
        matchKey,
        homeTeamName: homeTeam?.name ?? 'Local',
        awayTeamName: awayTeam?.name ?? 'Visitante',
        players,
      }
    })
  }, [scheduledRoundMatches, teamMap])

  const playersById = useMemo(() => {
    const map = new Map<string, { id: string; name: string; teamId: string; teamName: string; photoUrl?: string }>()
    teams.forEach((team) => {
      team.players.forEach((player) => {
        map.set(player.id, {
          id: player.id,
          name: player.name,
          teamId: team.id,
          teamName: team.name,
          photoUrl: player.photoUrl,
        })
      })
    })
    return map
  }, [teams])

  const teamIdByNormalizedName = useMemo(() => {
    const map = new Map<string, string>()
    teams.forEach((team) => {
      map.set(normalizeLabel(team.name), team.id)
    })
    return map
  }, [teams])

  const playedRoundBestPlayers = useMemo(() => {
    if (!activeFixtureRound) return [] as RoundMatchBestPlayerDraft[]

    const optionsByKey = new Map(activeRoundMatchMvpOptions.map((item) => [item.matchKey, item]))

    return playedMatchesRecords
      .filter((record) => record.round === activeFixtureRound)
      .map((record) => {
        if (!record.playerOfMatchId || !record.playerOfMatchName) return null

        const homeTeamId = teamIdByNormalizedName.get(normalizeLabel(record.homeTeamName))
        const awayTeamId = teamIdByNormalizedName.get(normalizeLabel(record.awayTeamName))
        if (!homeTeamId || !awayTeamId) return null

        const matchKey = makeRoundMatchKey(homeTeamId, awayTeamId)
        if (!optionsByKey.has(matchKey)) return null

        const playerFromRoster = playersById.get(record.playerOfMatchId)
        const playerFromSnapshot = record.players.find((player) => player.playerId === record.playerOfMatchId)

        const teamId = playerFromRoster?.teamId ?? playerFromSnapshot?.teamId
        const teamName = playerFromRoster?.teamName ?? playerFromSnapshot?.teamName

        if (!teamId || !teamName) return null

        return {
          matchKey,
          homeTeamId,
          awayTeamId,
          playerId: record.playerOfMatchId,
          playerName: record.playerOfMatchName,
          teamId,
          teamName,
        }
      })
      .filter((item): item is RoundMatchBestPlayerDraft => Boolean(item))
  }, [activeFixtureRound, activeRoundMatchMvpOptions, playedMatchesRecords, playersById, teamIdByNormalizedName])

  const mergedActiveRoundMatchBestPlayers = useMemo(() => {
    const map = new Map<string, RoundMatchBestPlayerDraft>()
    playedRoundBestPlayers.forEach((item) => map.set(item.matchKey, item))
    activeRoundMatchBestPlayers.forEach((item) => map.set(item.matchKey, item))
    return Array.from(map.values())
  }, [activeRoundMatchBestPlayers, playedRoundBestPlayers])

  const activeRoundBestPlayerByMatch = useMemo(() => {
    const map = new Map<string, RoundMatchBestPlayerDraft>()
    mergedActiveRoundMatchBestPlayers.forEach((item) => {
      map.set(item.matchKey, item)
    })
    return map
  }, [mergedActiveRoundMatchBestPlayers])

  const mergedActiveRoundBestPlayerId = useMemo(() => {
    const exists = mergedActiveRoundMatchBestPlayers.some((item) => item.playerId === activeRoundAwards.roundBestPlayerId)
    return exists ? activeRoundAwards.roundBestPlayerId : ''
  }, [activeRoundAwards.roundBestPlayerId, mergedActiveRoundMatchBestPlayers])

  const mergedRoundBestPlayerOptions = useMemo(() => {
    const unique = new Map<string, RoundMatchBestPlayerDraft>()
    mergedActiveRoundMatchBestPlayers.forEach((item) => {
      if (!unique.has(item.playerId)) {
        unique.set(item.playerId, item)
      }
    })
    return Array.from(unique.values())
  }, [mergedActiveRoundMatchBestPlayers])

  const activeRoundMvpCountByPlayerId = useMemo(() => {
    const map = new Map<string, number>()
    mergedActiveRoundMatchBestPlayers.forEach((item) => {
      map.set(item.playerId, (map.get(item.playerId) ?? 0) + 1)
    })
    return map
  }, [mergedActiveRoundMatchBestPlayers])

  const seasonMatchMvpRanking = useMemo(() => {
    const map = new Map<string, { playerId: string; playerName: string; teamName: string; teamId: string; photoUrl?: string; votes: number }>()

    playedMatchesRecords.forEach((record) => {
      if (!record.playerOfMatchId || !record.playerOfMatchName) return
      const rosterPlayer = playersById.get(record.playerOfMatchId)
      const snapshotPlayer = record.players.find((player) => player.playerId === record.playerOfMatchId)

      const teamId = rosterPlayer?.teamId ?? snapshotPlayer?.teamId
      const teamName = rosterPlayer?.teamName ?? snapshotPlayer?.teamName
      if (!teamId || !teamName) return

      const current = map.get(record.playerOfMatchId)
      if (!current) {
        map.set(record.playerOfMatchId, {
          playerId: record.playerOfMatchId,
          playerName: record.playerOfMatchName,
          teamName,
          teamId,
          photoUrl: rosterPlayer?.photoUrl,
          votes: 1,
        })
        return
      }

      current.votes += 1
    })

    return Array.from(map.values()).sort((left, right) => {
      if (right.votes !== left.votes) return right.votes - left.votes
      return left.playerName.localeCompare(right.playerName, 'es', { sensitivity: 'base' })
    })
  }, [playedMatchesRecords, playersById])

  const roundCompletedMatchesCount = playedMatchesCountByRound[activeFixtureRound] ?? 0
  const totalRoundMatches = fixtureMatchesByRound.length
  const isActiveRoundCompleted = totalRoundMatches > 0 && roundCompletedMatchesCount >= totalRoundMatches
  const top5RoundAwardsRanking = roundAwardsRanking.slice(0, 5)

  const setMatchBestPlayer = (
    matchKey: string,
    homeTeamId: string,
    awayTeamId: string,
    payload: { playerId: string; playerName: string; teamId: string; teamName: string },
  ) => {
    if (!activeFixtureRound) return

    setRoundAwardsByRound((current) => {
      const currentRound = current[activeFixtureRound] ?? { matchBestPlayers: [], roundBestPlayerId: '' }
      const nextItem: RoundMatchBestPlayerDraft = {
        matchKey,
        homeTeamId,
        awayTeamId,
        playerId: payload.playerId,
        playerName: payload.playerName,
        teamId: payload.teamId,
        teamName: payload.teamName,
      }

      const nextMatchBestPlayers = currentRound.matchBestPlayers.some((item) => item.matchKey === matchKey)
        ? currentRound.matchBestPlayers.map((item) => (item.matchKey === matchKey ? nextItem : item))
        : [...currentRound.matchBestPlayers, nextItem]

      return {
        ...current,
        [activeFixtureRound]: {
          ...currentRound,
          matchBestPlayers: nextMatchBestPlayers,
        },
      }
    })
  }

  const saveRoundAwards = async () => {
    if (isReadOnlySeason) {
      showMessage('Temporada histórica: solo lectura')
      return
    }

    if (!selectedLeague || !activeCategoryId || !activeFixtureRound) return
    if (!isActiveRoundCompleted) {
      showMessage(`Aún no se puede publicar MVP: partidos culminados ${roundCompletedMatchesCount}/${totalRoundMatches} en la fecha`)
      return
    }
    if (mergedActiveRoundMatchBestPlayers.length === 0) {
      showMessage('Selecciona al menos una mejor jugadora por partido para guardar')
      return
    }

    const roundBestPlayer = mergedRoundBestPlayerOptions.find((item) => item.playerId === mergedActiveRoundBestPlayerId)

    const response = await apiService.saveRoundAwards(selectedLeague.id, {
      categoryId: activeCategoryId,
      round: activeFixtureRound,
      matchBestPlayers: mergedActiveRoundMatchBestPlayers,
      ...(roundBestPlayer
        ? {
            roundBestPlayerId: roundBestPlayer.playerId,
            roundBestPlayerName: roundBestPlayer.playerName,
            roundBestPlayerTeamId: roundBestPlayer.teamId,
            roundBestPlayerTeamName: roundBestPlayer.teamName,
          }
        : {}),
    })

    if (!response.ok) {
      showMessage(response.message)
      return
    }

    setRoundAwardsByRound((current) => ({
      ...current,
      [activeFixtureRound]: {
        matchBestPlayers: response.data.matchBestPlayers.map((item) => ({ ...item })),
        roundBestPlayerId: response.data.roundBestPlayerId ?? '',
      },
    }))

    const rankingResponse = await apiService.getRoundAwardsRanking(selectedLeague.id, activeCategoryId)
    if (rankingResponse.ok) {
      setRoundAwardsRanking(rankingResponse.data)
    }

    showMessage(`Mejores jugadoras de Fecha ${activeFixtureRound} guardadas`)
  }

  const downloadRoundAwardsCardPng = async () => {
    if (!roundAwardsCardRef.current) {
      showMessage('No hay tarjeta de mejores jugadoras para descargar')
      return
    }

    try {
      const dataUrl = await toPng(roundAwardsCardRef.current, {
        cacheBust: true,
        pixelRatio: 2,
      })

      const fileName = `${(selectedLeague?.name ?? 'liga').replace(/\s+/g, '-').toLowerCase()}-mejores-jugadoras-fecha-${activeFixtureRound}.png`
      const link = document.createElement('a')
      link.download = fileName
      link.href = dataUrl
      link.click()
    } catch {
      showMessage('No se pudo generar la imagen de mejores jugadoras')
    }
  }

  const shareRoundAwardsByWhatsapp = () => {
    if (!selectedLeague || !activeFixtureRound) {
      showMessage('Selecciona una fecha para compartir')
      return
    }

    if (mergedActiveRoundMatchBestPlayers.length === 0) {
      showMessage('Primero registra las mejores jugadoras por partido')
      return
    }

    const lines: string[] = []
    lines.push(`${selectedLeague.name} · Temporada ${selectedLeague.season}`)
    lines.push(`Mejores jugadoras · Fecha ${activeFixtureRound}`)
    lines.push('')

    mergedActiveRoundMatchBestPlayers.forEach((entry) => {
      const homeName = teamMap.get(entry.homeTeamId)?.name ?? 'Local'
      const awayName = teamMap.get(entry.awayTeamId)?.name ?? 'Visitante'
      lines.push(`• ${homeName} vs ${awayName}: ${entry.playerName} (${entry.teamName})`)
    })

    const roundBestPlayer = mergedRoundBestPlayerOptions.find((item) => item.playerId === mergedActiveRoundBestPlayerId)
    if (roundBestPlayer) {
      lines.push('')
      lines.push(`⭐ Jugadora de la fecha: ${roundBestPlayer.playerName} (${roundBestPlayer.teamName})`)
    }

    const text = encodeURIComponent(lines.join('\n'))
    window.open(`https://wa.me/?text=${text}`, '_blank', 'noopener,noreferrer')
  }

  const buildDigitalCardFileName = () => {
    const leagueSlug = (selectedLeague?.name ?? 'liga').replace(/\s+/g, '-').toLowerCase()
    const teamSlug = (digitalCardTeam?.name ?? 'equipo').replace(/\s+/g, '-').toLowerCase()
    const playerSlug = (digitalCardPlayer?.name ?? 'jugador').replace(/\s+/g, '-').toLowerCase()
    return `${leagueSlug}-${teamSlug}-${playerSlug}-carnet.png`
  }

  const waitForCardRender = async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
  }

  const waitForCardAssets = async () => {
    if (!digitalCardRef.current) return
    const images = Array.from(digitalCardRef.current.querySelectorAll('img'))
    await Promise.all(
      images.map(
        (image) =>
          new Promise<void>((resolve) => {
            if (image.complete) {
              resolve()
              return
            }

            const handleDone = () => {
              image.removeEventListener('load', handleDone)
              image.removeEventListener('error', handleDone)
              resolve()
            }

            image.addEventListener('load', handleDone)
            image.addEventListener('error', handleDone)
          }),
      ),
    )
  }

  const generateCurrentCardDataUrl = async () => {
    if (!digitalCardRef.current) {
      throw new Error('no-card-ref')
    }

    await waitForCardRender()
    await waitForCardAssets()

    const node = digitalCardRef.current

    return toPng(node, {
      cacheBust: true,
      pixelRatio: 3,
      width: node.scrollWidth,
      height: node.scrollHeight,
    })
  }

  const downloadDigitalCardPng = async () => {
    if (!digitalCardRef.current || !digitalCardPlayer || !digitalCardTeam || !selectedLeague) {
      showMessage('Selecciona equipo y jugador para generar el carnet')
      return
    }

    try {
      const dataUrl = await generateCurrentCardDataUrl()

      const link = document.createElement('a')
      link.download = buildDigitalCardFileName()
      link.href = dataUrl
      link.click()
    } catch {
      showMessage('No se pudo descargar el carnet digital')
    }
  }

  const shareDigitalCardByWhatsapp = async () => {
    if (!digitalCardRef.current || !digitalCardPlayer || !digitalCardTeam || !selectedLeague) {
      showMessage('Selecciona equipo y jugador para compartir el carnet')
      return
    }

    try {
      const dataUrl = await generateCurrentCardDataUrl()

      const response = await fetch(dataUrl)
      const blob = await response.blob()
      const fileName = buildDigitalCardFileName()
      const file = new File([blob], fileName, { type: 'image/png' })

      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: `Carnet digital · ${digitalCardPlayer.name}`,
            text: `${selectedLeague.name} · ${digitalCardTeam.name}`,
          })
          return
        }
      }

      const shareText = encodeURIComponent(
        `Carnet digital: ${digitalCardPlayer.name} · #${digitalCardPlayer.number} · ${digitalCardTeam.name}`,
      )
      window.open(`https://wa.me/?text=${shareText}`, '_blank', 'noopener,noreferrer')
      showMessage('WhatsApp Web no admite adjuntar imagen directo en este navegador. Usa Descargar imagen y luego adjúntala en WhatsApp.')
    } catch {
      showMessage('No se pudo compartir el carnet digital')
    }
  }

  const downloadTeamCardsZip = async () => {
    if (!selectedLeague || !digitalCardTeam || digitalCardTeam.players.length === 0) {
      showMessage('Selecciona un equipo con jugadoras para exportar carnets')
      return
    }

    if (!digitalCardRef.current) {
      showMessage('No se pudo preparar la vista del carnet para exportación masiva')
      return
    }

    const previousTeamId = digitalCardTeamId
    const previousPlayerId = digitalCardPlayerId
    const targetTeam = digitalCardTeam

    setIsGeneratingBulkCards(true)

    try {
      setDigitalCardTeamId(targetTeam.id)
      await waitForCardRender()

      const zip = new JSZip()
      const teamFolder = zip.folder(targetTeam.name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'equipo')
      if (!teamFolder) {
        showMessage('No se pudo crear carpeta para el ZIP')
        return
      }

      for (const player of targetTeam.players) {
        setDigitalCardPlayerId(player.id)
        const dataUrl = await generateCurrentCardDataUrl()
        const base64Data = dataUrl.split(',')[1]
        const safePlayerName = player.name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'jugadora'
        const fileName = `${safePlayerName}-#${player.number}.png`
        teamFolder.file(fileName, base64Data, { base64: true })
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' })
      const leagueSlug = (selectedLeague.name || 'liga').replace(/\s+/g, '-').toLowerCase()
      const teamSlug = (targetTeam.name || 'equipo').replace(/\s+/g, '-').toLowerCase()
      const fileName = `${leagueSlug}-${teamSlug}-carnets.zip`
      const downloadUrl = URL.createObjectURL(zipBlob)

      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = fileName
      link.click()
      URL.revokeObjectURL(downloadUrl)

      showMessage(`Carnets masivos generados: ${targetTeam.players.length} jugadoras`) 
    } catch {
      showMessage('No se pudo generar el ZIP masivo de carnets')
    } finally {
      setDigitalCardTeamId(previousTeamId)
      setDigitalCardPlayerId(previousPlayerId)
      setIsGeneratingBulkCards(false)
    }
  }

  const downloadCategoryCardsZip = async () => {
    if (!selectedLeague || teams.length === 0) {
      showMessage('No hay equipos para exportar en esta categoría')
      return
    }

    if (!digitalCardRef.current) {
      showMessage('No se pudo preparar la vista del carnet para exportación masiva')
      return
    }

    const teamsWithPlayers = teams.filter((team) => team.players.length > 0)
    if (teamsWithPlayers.length === 0) {
      showMessage('No hay jugadoras registradas para generar carnets masivos')
      return
    }

    const previousTeamId = digitalCardTeamId
    const previousPlayerId = digitalCardPlayerId

    setIsGeneratingBulkCards(true)

    try {
      const zip = new JSZip()
      let exportedCards = 0

      for (const team of teamsWithPlayers) {
        setDigitalCardTeamId(team.id)
        await waitForCardRender()
        const teamFolder = zip.folder(team.name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'equipo')
        if (!teamFolder) continue

        for (const player of team.players) {
          setDigitalCardPlayerId(player.id)
          const dataUrl = await generateCurrentCardDataUrl()
          const base64Data = dataUrl.split(',')[1]
          const safePlayerName = player.name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'jugadora'
          const fileName = `${safePlayerName}-#${player.number}.png`
          teamFolder.file(fileName, base64Data, { base64: true })
          exportedCards += 1
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' })
      const leagueSlug = (selectedLeague.name || 'liga').replace(/\s+/g, '-').toLowerCase()
      const categorySlug = (activeCategoryName || 'categoria').replace(/\s+/g, '-').toLowerCase()
      const fileName = `${leagueSlug}-${categorySlug}-carnets.zip`
      const downloadUrl = URL.createObjectURL(zipBlob)

      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = fileName
      link.click()
      URL.revokeObjectURL(downloadUrl)

      showMessage(`Carnets masivos generados: ${exportedCards} jugadoras`) 
    } catch {
      showMessage('No se pudo generar el ZIP masivo por categoría')
    } finally {
      setDigitalCardTeamId(previousTeamId)
      setDigitalCardPlayerId(previousPlayerId)
      setIsGeneratingBulkCards(false)
    }
  }

  const handleAddPlayer = async (teamId: string) => {
    if (isReadOnlySeason) {
      showMessage('Temporada histórica: solo lectura')
      return
    }

    const draft = playerDraftByTeam[teamId] ?? defaultPlayerDraft
    const replacementConfig = playerReplacementByTeam[teamId] ?? { enabled: false, replacePlayerId: '' }
    const targetTeam = teams.find((item) => item.id === teamId)

    if (!targetTeam) {
      showMessage('Equipo no encontrado para registrar jugadora')
      return
    }

    const atCapacity = targetTeam.players.length >= activeCategoryMaxRegisteredPlayers
    if (atCapacity && !replacementConfig.enabled) {
      showMessage(`Cupo completo (${activeCategoryMaxRegisteredPlayers}). Activa reemplazo por lesión o elimina una jugadora.`)
      return
    }

    if (replacementConfig.enabled && !replacementConfig.replacePlayerId) {
      showMessage('Selecciona la jugadora lesionada que será reemplazada')
      return
    }

    if (!draft.name.trim() || !draft.nickname.trim()) {
      showMessage('Nombre y apodo son obligatorios')
      return
    }

    const response = await apiService.addPlayerToTeam(teamId, {
      name: draft.name,
      nickname: draft.nickname,
      age: draft.age,
      number: draft.number,
      position: normalizePosition(draft.position),
      registrationStatus: draft.registrationStatus,
      photoUrl: draft.photoUrl || undefined,
      replacePlayerId: replacementConfig.enabled ? replacementConfig.replacePlayerId : undefined,
      replacementReason: replacementConfig.enabled ? 'injury' : undefined,
    })

    if (!response.ok) {
      showMessage(response.message)
      return
    }

    setPlayerDraftByTeam((current) => ({
      ...current,
      [teamId]: { ...defaultPlayerDraft, number: (current[teamId]?.number ?? 1) + 1 },
    }))
    setPlayerReplacementByTeam((current) => ({
      ...current,
      [teamId]: { enabled: false, replacePlayerId: '' },
    }))
    showMessage(replacementConfig.enabled ? 'Reemplazo por lesión registrado' : 'Jugador agregado')
    await loadTeams()
  }

  const updateTeamEdit = (
    team: RegisteredTeam,
    field: 'name' | 'logoUrl' | 'primaryColor' | 'secondaryColor' | 'directorName' | 'directorPhotoUrl' | 'assistantName' | 'assistantPhotoUrl',
    value: string,
  ) => {
    setTeamEditById((current) => ({
      ...current,
      [team.id]: {
        name: current[team.id]?.name ?? team.name,
        logoUrl: current[team.id]?.logoUrl ?? team.logoUrl ?? '',
        primaryColor: current[team.id]?.primaryColor ?? team.primaryColor ?? '#3b82f6',
        secondaryColor: current[team.id]?.secondaryColor ?? team.secondaryColor ?? '',
        directorName: current[team.id]?.directorName ?? team.technicalStaff?.director?.name ?? '',
        directorPhotoUrl: current[team.id]?.directorPhotoUrl ?? team.technicalStaff?.director?.photoUrl ?? '',
        assistantName: current[team.id]?.assistantName ?? team.technicalStaff?.assistant?.name ?? '',
        assistantPhotoUrl: current[team.id]?.assistantPhotoUrl ?? team.technicalStaff?.assistant?.photoUrl ?? '',
        [field]: value,
      },
    }))
  }

  const saveTeamEdit = async (team: RegisteredTeam) => {
    if (isReadOnlySeason) {
      showMessage('Temporada histórica: solo lectura')
      return
    }

    const edit = teamEditById[team.id]
    if (!edit) return

    if (!edit.directorName.trim() || !edit.assistantName.trim()) {
      showMessage('Cada equipo debe tener 1 DT y 1 AT')
      return
    }

    const response = await apiService.updateTeam(team.id, {
      name: edit.name.trim(),
      logoUrl: edit.logoUrl || undefined,
      primaryColor: edit.primaryColor || undefined,
      secondaryColor: edit.secondaryColor || undefined,
      technicalStaff: {
        director: {
          name: edit.directorName.trim(),
          ...(edit.directorPhotoUrl ? { photoUrl: edit.directorPhotoUrl } : {}),
        },
        assistant: {
          name: edit.assistantName.trim(),
          ...(edit.assistantPhotoUrl ? { photoUrl: edit.assistantPhotoUrl } : {}),
        },
      },
    })

    if (!response.ok) {
      showMessage(response.message)
      return
    }

    showMessage('Equipo actualizado')
    await loadTeams()
  }

  const toggleTeamActive = async (team: RegisteredTeam, nextActive: boolean) => {
    if (isReadOnlySeason) {
      showMessage('Temporada histórica: solo lectura')
      return
    }

    const response = await apiService.updateTeam(team.id, { active: nextActive })
    if (!response.ok) {
      showMessage(response.message)
      return
    }

    showMessage(nextActive ? 'Equipo reactivado' : 'Equipo desactivado y excluido de historial/tabla')
    await loadTeams()
  }

  const handleUploadMatchVideo = async (matchId: string, categoryId: string) => {
    if (!selectedLeague) return
    const form = videoFormByMatch[matchId] ?? { file: null, name: '', url: '', mode: 'file' as const }
    const hasFile = form.mode !== 'url' && form.file
    const hasUrl = form.mode === 'url' && form.url.trim()
    if (!hasFile && !hasUrl) {
      showMessage('Selecciona un archivo o ingresa una URL')
      return
    }
    setVideoUploadingByMatch((prev) => ({ ...prev, [matchId]: true }))
    try {
      let response
      if (hasFile && form.file) {
        response = await apiService.uploadPlayedMatchVideo(selectedLeague.id, matchId, {
          categoryId,
          file: form.file,
          name: form.name.trim() || undefined,
        })
      } else {
        response = await apiService.addPlayedMatchVideo(selectedLeague.id, matchId, {
          categoryId,
          name: form.name.trim() || 'Video',
          url: form.url.trim(),
        })
      }
      if (!response.ok) {
        showMessage(response.message)
        return
      }
      showMessage('Video agregado')
      setVideoFormByMatch((prev) => ({ ...prev, [matchId]: { file: null, name: '', url: '', mode: 'file' } }))
      await refreshFixture(false)
    } finally {
      setVideoUploadingByMatch((prev) => ({ ...prev, [matchId]: false }))
    }
  }

  const handleDeleteMatchVideo = async (matchId: string, videoId: string, categoryId: string) => {
    if (!selectedLeague) return
    const response = await apiService.deletePlayedMatchVideo(selectedLeague.id, matchId, videoId, categoryId)
    if (!response.ok) {
      showMessage(response.message)
      return
    }
    showMessage('Video eliminado')
    await refreshFixture(false)
  }

  const updatePlayerEdit = (teamId: string, playerId: string, payload: PlayerDraft) => {
    setPlayerEditById((current) => ({
      ...current,
      [`${teamId}:${playerId}`]: payload,
    }))
  }

  const savePlayerEdit = async (teamId: string, playerId: string, currentPlayer: PlayerDraft) => {
    if (isReadOnlySeason) {
      showMessage('Temporada histórica: solo lectura')
      return
    }

    const payload = playerEditById[`${teamId}:${playerId}`] ?? currentPlayer

    const response = await apiService.updatePlayer(teamId, playerId, {
      name: payload.name,
      nickname: payload.nickname,
      age: payload.age,
      number: payload.number,
      position: normalizePosition(payload.position),
      registrationStatus: payload.registrationStatus,
      photoUrl: payload.photoUrl || undefined,
    })

    if (!response.ok) {
      showMessage(response.message)
      return
    }

    showMessage('Jugador actualizado')
    await loadTeams()
  }

  const requestDeleteLeague = () => {
    if (!selectedLeague) return
    setConfirmAction({ type: 'delete-league', leagueId: selectedLeague.id, label: selectedLeague.name })
  }

  const requestDeleteTeam = (team: RegisteredTeam) => {
    if (isReadOnlySeason) {
      showMessage('Temporada histórica: solo lectura')
      return
    }

    setConfirmAction({ type: 'delete-team', teamId: team.id, label: team.name })
  }

  const requestDeletePlayer = (teamId: string, playerId: string, label: string) => {
    if (isReadOnlySeason) {
      showMessage('Temporada histórica: solo lectura')
      return
    }

    setConfirmAction({ type: 'delete-player', teamId, playerId, label })
  }

  const updateLeagueEdit = (league: League, patch: Partial<LeagueEditDraft>) => {
    setLeagueEditById((current) => ({
      ...current,
      [league.id]: {
        name: current[league.id]?.name ?? league.name,
        country: current[league.id]?.country ?? league.country,
        season: current[league.id]?.season ?? league.season,
        slogan: current[league.id]?.slogan ?? league.slogan ?? '',
        themeColor: current[league.id]?.themeColor ?? league.themeColor ?? '',
        backgroundImageUrl: current[league.id]?.backgroundImageUrl ?? league.backgroundImageUrl ?? '',
        logoUrl: current[league.id]?.logoUrl ?? league.logoUrl ?? '',
        ...patch,
      },
    }))
  }

  const saveLeagueEdit = async (league: League) => {
    const draft = leagueEditById[league.id]
    if (!draft) return

    const response = await apiService.updateLeague(league.id, {
      name: draft.name.trim(),
      slug: buildSlug(draft.name.trim()),
      country: draft.country.trim(),
      season: draft.season,
      slogan: draft.slogan.trim() || '',
      themeColor: draft.themeColor.trim() || undefined,
      backgroundImageUrl: draft.backgroundImageUrl || undefined,
      logoUrl: draft.logoUrl || undefined,
    })

    if (!response.ok) {
      showMessage(response.message)
      return
    }

    showMessage('Liga actualizada')
    await onLeaguesReload()
    onLeagueSelect(response.data.id)
  }

  const executeConfirm = async () => {
    if (!confirmAction) return

    if (confirmAction.type === 'delete-league') {
      const response = await apiService.deleteLeague(confirmAction.leagueId)
      if (!response.ok) {
        showMessage(response.message)
        setConfirmAction(null)
        return
      }

      showMessage('Liga eliminada')
      await onLeaguesReload()
      setConfirmAction(null)
      return
    }

    if (confirmAction.type === 'delete-team') {
      const response = await apiService.deleteTeam(confirmAction.teamId)
      if (!response.ok) {
        showMessage(response.message)
        setConfirmAction(null)
        return
      }

      showMessage('Equipo eliminado')
      await loadTeams()
      setConfirmAction(null)
      return
    }

    const response = await apiService.deletePlayer(confirmAction.teamId, confirmAction.playerId)
    if (!response.ok) {
      showMessage(response.message)
      setConfirmAction(null)
      return
    }

    showMessage('Jugador eliminado')
    await loadTeams()
    setConfirmAction(null)
  }

  const confirmTitle =
    confirmAction?.type === 'delete-league'
      ? 'Eliminar liga'
      : confirmAction?.type === 'delete-team'
        ? 'Eliminar equipo'
        : confirmAction?.type === 'delete-player'
          ? 'Eliminar jugador'
          : ''

  const activeFlowStep =
    tab === 'ligas'
      ? 1
      : tab === 'equipos'
        ? 3
        : tab === 'jugadores' || tab === 'carnet'
          ? 4
          : tab === 'fixture' || tab === 'mvp'
            ? 5
            : 1

  return (
    <section className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-3 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-white">Administración</h3>
      </div>

      <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
        {([
          { id: 'ligas', label: 'Ligas' },
          { id: 'equipos', label: 'Equipos' },
          { id: 'jugadores', label: 'Jugadores' },
          { id: 'carnet', label: 'Carnet' },
          { id: 'fixture', label: 'Fixture' },
          { id: 'mvp', label: 'MVP' },
        ] as Array<{ id: AdminTab; label: string }>).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-semibold ${
              tab === item.id
                ? 'border border-primary-300/40 bg-primary-500/20 text-primary-100'
                : 'border border-white/20 bg-slate-900 text-slate-200'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-3 rounded border border-cyan-300/25 bg-cyan-500/10 px-3 py-2">
        <p className="text-[11px] font-semibold text-cyan-100">Flujo recomendado para cliente</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {managementFlowSteps.map((step) => {
            const isActive = step.id === activeFlowStep
            const isCompleted = step.id < activeFlowStep
            return (
              <span
                key={step.id}
                className={`rounded-full border px-2 py-1 text-[11px] ${
                  isActive
                    ? 'border-cyan-200/80 bg-cyan-300/20 text-cyan-50'
                    : isCompleted
                      ? 'border-emerald-200/50 bg-emerald-500/15 text-emerald-100'
                      : 'border-white/20 bg-slate-900/60 text-slate-300'
                }`}
              >
                {step.id}. {step.label}
              </span>
            )
          })}
        </div>
        <p className="mt-2 text-[11px] text-cyan-50/90">
          Paso actual: {managementFlowSteps.find((step) => step.id === activeFlowStep)?.label} · {managementFlowSteps.find((step) => step.id === activeFlowStep)?.hint}
        </p>
      </div>

      {message && <p className="mt-3 rounded border border-primary-300/30 bg-primary-500/10 px-3 py-2 text-sm text-primary-100">{message}</p>}

      {tab === 'ligas' && (
        <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/60 p-4">
          <p className="text-sm font-semibold text-white">Crear liga</p>
          <p className="mt-1 text-xs text-slate-400">La nueva liga se crea con dueño Super Admin.</p>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-9">
            <input value={newLeagueName} onChange={(event) => setNewLeagueName(event.target.value)} placeholder="Nombre de la liga" className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white" />
            <input value={newLeagueCountry} onChange={(event) => setNewLeagueCountry(event.target.value)} placeholder="País" className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white" />
            <input type="number" min={2020} max={2100} value={newLeagueSeason} onChange={(event) => setNewLeagueSeason(Number(event.target.value) || 2026)} placeholder="Temporada" className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white" />
            <input value={newLeagueSlogan} onChange={(event) => setNewLeagueSlogan(event.target.value)} placeholder="Slogan (opcional)" className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white" />
            <label className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-slate-200">Color fondo (opcional)
              <input type="color" value={newLeagueThemeColor || '#020617'} onChange={(event) => setNewLeagueThemeColor(event.target.value)} className="mt-1 block h-8 w-full" />
            </label>
            <label className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-slate-200">
              Imagen de fondo (opcional)
              <input type="file" accept="image/*" className="mt-1 block w-full text-xs" onChange={async (event) => {
                const file = event.target.files?.[0]
                if (!file) return
                setNewLeagueBackgroundImageUrl(await toDataUrl(file))
              }} />
            </label>
            <select value={newLeagueCategoryKey} onChange={(event) => setNewLeagueCategoryKey(event.target.value)} className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white">
              {categoryTemplates.map((category) => (
                <option key={category.key} value={category.key}>{category.name}</option>
              ))}
            </select>
            <label className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-slate-200">
              Logo liga
              <input type="file" accept="image/*" className="mt-1 block w-full text-xs" onChange={async (event) => {
                const file = event.target.files?.[0]
                if (!file) return
                setNewLeagueLogoUrl(await toDataUrl(file))
              }} />
            </label>
            <button type="button" onClick={handleCreateLeague} className="rounded bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-500">Crear liga</button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {selectedLeague && (
              <button type="button" disabled={isReadOnlySeason} onClick={requestDeleteLeague} className="rounded border border-rose-300/50 bg-rose-600/20 px-3 py-1 text-xs font-semibold text-rose-100 disabled:cursor-not-allowed disabled:opacity-60">
                Eliminar liga seleccionada
              </button>
            )}
            {newLeagueBackgroundImageUrl && <img src={newLeagueBackgroundImageUrl} alt="Fondo liga" className="h-12 w-20 rounded border border-white/20 object-cover" />}
            {newLeagueLogoUrl && <img src={newLeagueLogoUrl} alt="Logo liga" className="h-12 w-12 rounded border border-white/20 bg-white object-contain p-1" />}
          </div>

          {selectedLeague && (
            <div className="mt-4 rounded border border-primary-300/20 bg-slate-900/70 p-3">
              <p className="mb-2 text-xs font-semibold text-primary-200">Edición rápida · liga seleccionada</p>
              {isReadOnlySeason && (
                <p className="mb-2 text-[11px] text-amber-200">Temporada histórica: solo lectura.</p>
              )}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-7">
                <input disabled={isReadOnlySeason} value={leagueEditById[selectedLeague.id]?.name ?? selectedLeague.name} onChange={(event) => updateLeagueEdit(selectedLeague, { name: event.target.value })} className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-60" />
                <input disabled={isReadOnlySeason} value={leagueEditById[selectedLeague.id]?.country ?? selectedLeague.country} onChange={(event) => updateLeagueEdit(selectedLeague, { country: event.target.value })} className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-60" />
                <input disabled={isReadOnlySeason} type="number" min={2020} max={2100} value={leagueEditById[selectedLeague.id]?.season ?? selectedLeague.season} onChange={(event) => updateLeagueEdit(selectedLeague, { season: Number(event.target.value) || selectedLeague.season })} className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-60" />
                <input disabled={isReadOnlySeason} value={leagueEditById[selectedLeague.id]?.slogan ?? selectedLeague.slogan ?? ''} onChange={(event) => updateLeagueEdit(selectedLeague, { slogan: event.target.value })} placeholder="Slogan" className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-60" />
                <label className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-slate-200">Color fondo
                  <input disabled={isReadOnlySeason} type="color" value={leagueEditById[selectedLeague.id]?.themeColor ?? selectedLeague.themeColor ?? '#020617'} onChange={(event) => updateLeagueEdit(selectedLeague, { themeColor: event.target.value })} className="mt-1 block h-7 w-full disabled:opacity-60" />
                </label>
                <label className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-slate-200">Imagen fondo
                  <input disabled={isReadOnlySeason} type="file" accept="image/*" className="mt-1 block w-full disabled:opacity-60" onChange={async (event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    updateLeagueEdit(selectedLeague, { backgroundImageUrl: await toDataUrl(file) })
                  }} />
                </label>
                <label className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-slate-200">Logo
                  <input disabled={isReadOnlySeason} type="file" accept="image/*" className="mt-1 block w-full disabled:opacity-60" onChange={async (event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    updateLeagueEdit(selectedLeague, { logoUrl: await toDataUrl(file) })
                  }} />
                </label>
              </div>
              {(leagueEditById[selectedLeague.id]?.backgroundImageUrl ?? selectedLeague.backgroundImageUrl) && (
                <img
                  src={leagueEditById[selectedLeague.id]?.backgroundImageUrl ?? selectedLeague.backgroundImageUrl}
                  alt="Fondo actual"
                  className="mt-2 h-16 w-full rounded border border-white/10 object-cover"
                />
              )}
              <button type="button" disabled={isReadOnlySeason} onClick={() => void saveLeagueEdit(selectedLeague)} className="mt-2 rounded border border-primary-300/40 bg-primary-500/20 px-2 py-1 text-xs font-semibold text-primary-100 disabled:cursor-not-allowed disabled:opacity-60">
                Guardar cambios rápidos
              </button>
            </div>
          )}

          <div className="mt-4 rounded border border-white/10 bg-slate-800/70 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-200">Ligas creadas</p>
              <input
                value={leagueSearch}
                onChange={(event) => {
                  setLeagueSearch(event.target.value)
                  setLeaguePage(1)
                }}
                placeholder="Buscar liga o país"
                className="w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white sm:w-56"
              />
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {leaguePagination.pageItems.length === 0 && <p className="text-xs text-slate-400">No hay ligas registradas.</p>}
              {leaguePagination.pageItems.map((league) => (
                <div
                  key={league.id}
                  className={`rounded border px-2 py-2 text-left text-xs ${
                    selectedLeague?.id === league.id
                      ? 'border-primary-300/60 bg-primary-500/20 text-primary-100'
                      : 'border-white/10 bg-slate-900 text-slate-200'
                  }`}
                >
                  {league.season < latestSeason && (
                    <p className="mb-1 text-[10px] text-amber-200">Temporada histórica · solo lectura</p>
                  )}
                  <p className="font-semibold">{league.name}</p>
                  <p className="text-[11px] text-slate-400">{league.country} · Temporada {league.season}</p>
                  {league.slogan && <p className="text-[11px] text-primary-200">{league.slogan}</p>}
                  <button
                    type="button"
                    onClick={() => onLeagueSelect(league.id)}
                    className="mt-2 rounded border border-primary-300/40 bg-primary-500/20 px-2 py-1 text-[11px] font-semibold text-primary-100"
                  >
                    Seleccionar liga
                  </button>
                </div>
              ))}
            </div>
            {leaguePagination.totalPages > 1 && (
              <div className="mt-2 flex items-center justify-end gap-2 text-xs text-slate-300">
                <button type="button" disabled={leaguePagination.currentPage === 1} onClick={() => setLeaguePage((current) => Math.max(current - 1, 1))} className="rounded border border-white/20 px-2 py-1 disabled:opacity-50">Anterior</button>
                <span>Página {leaguePagination.currentPage} / {leaguePagination.totalPages}</span>
                <button type="button" disabled={leaguePagination.currentPage === leaguePagination.totalPages} onClick={() => setLeaguePage((current) => Math.min(current + 1, leaguePagination.totalPages))} className="rounded border border-white/20 px-2 py-1 disabled:opacity-50">Siguiente</button>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'equipos' && (
        <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/60 p-4">
          {!selectedLeague ? (
            <p className="text-sm text-slate-300">Selecciona una liga para gestionar equipos.</p>
          ) : (
            <>
              {isReadOnlySeason && (
                <p className="mb-2 rounded border border-amber-300/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">
                  Temporada {selectedLeague.season} en modo lectura.
                </p>
              )}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-8">
                <select value={activeCategoryId} onChange={(event) => {
                  setSelectedCategoryId(event.target.value)
                  setSelectedTeamId('')
                  setTeamSearch('')
                  setTeamPage(1)
                }} className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white">
                  {categoryOptions.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
                <input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="Nombre del equipo" className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white" />
                <label className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-slate-200">Logo equipo
                  <input type="file" accept="image/*" className="mt-1 block w-full text-xs" onChange={async (event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    setTeamLogoUrl(await toDataUrl(file))
                  }} />
                </label>
                <label className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-slate-200">Color principal *
                  <input type="color" value={teamPrimaryColor} onChange={(event) => setTeamPrimaryColor(event.target.value)} className="mt-1 block h-8 w-full" />
                </label>
                <label className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-slate-200">Color alterno (opcional)
                  <input type="color" value={teamSecondaryColor} onChange={(event) => setTeamSecondaryColor(event.target.value)} className="mt-1 block h-8 w-full" />
                </label>
                <input value={teamDirectorDraft.name} onChange={(event) => setTeamDirectorDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Director Técnico" className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white" />
                <label className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-xs text-slate-200">Foto DT
                  <input type="file" accept="image/*" className="mt-1 block w-full text-xs" onChange={async (event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    const photoUrl = await toDataUrl(file)
                    setTeamDirectorDraft((current) => ({ ...current, photoUrl }))
                  }} />
                </label>
                <input value={teamAssistantDraft.name} onChange={(event) => setTeamAssistantDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Asistente Técnico" className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white" />
                <label className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-xs text-slate-200">Foto AT
                  <input type="file" accept="image/*" className="mt-1 block w-full text-xs" onChange={async (event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    const photoUrl = await toDataUrl(file)
                    setTeamAssistantDraft((current) => ({ ...current, photoUrl }))
                  }} />
                </label>
                <button type="button" onClick={handleCreateTeam} disabled={loading || isReadOnlySeason} className="rounded bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-60">Crear equipo</button>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <input
                  value={teamSearch}
                  onChange={(event) => {
                    setTeamSearch(event.target.value)
                    setTeamPage(1)
                  }}
                  placeholder="Buscar equipo"
                  className="w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white sm:w-56"
                />
                <p className="text-[11px] text-slate-400">{filteredTeams.length} equipos</p>
              </div>

              <div className="mt-4 space-y-3">
                {loading && <p className="text-sm text-slate-300">Cargando equipos...</p>}
                {!loading && teamPagination.pageItems.length === 0 && <p className="text-sm text-slate-300">No hay equipos en esta categoría.</p>}
                {teamPagination.pageItems.map((team) => (
                  <div key={team.id} className={`rounded border p-3 ${team.active === false ? 'border-amber-300/40 bg-amber-950/20' : 'border-white/10 bg-slate-800'}`}>
                    <div className="flex items-center gap-2">
                      {team.logoUrl && <img src={team.logoUrl} alt={team.name} className="h-10 w-10 rounded border border-white/20 bg-white object-contain p-1" />}
                      <p className="font-semibold text-white">{team.name}</p>
                      {team.active === false && (
                        <span className="rounded-full border border-amber-300/50 bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold text-amber-100">Desactivado</span>
                      )}
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-[1.2fr_1fr_1fr_1fr_auto_auto]">
                      <input value={teamEditById[team.id]?.name ?? team.name} onChange={(event) => updateTeamEdit(team, 'name', event.target.value)} className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white" />
                      <label className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-slate-200">Logo
                        <input type="file" accept="image/*" className="mt-1 block w-full" onChange={async (event) => {
                          const file = event.target.files?.[0]
                          if (!file) return
                          updateTeamEdit(team, 'logoUrl', await toDataUrl(file))
                        }} />
                      </label>
                      <input value={teamEditById[team.id]?.directorName ?? team.technicalStaff?.director?.name ?? ''} onChange={(event) => updateTeamEdit(team, 'directorName', event.target.value)} placeholder="DT" className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white" />
                      <input value={teamEditById[team.id]?.assistantName ?? team.technicalStaff?.assistant?.name ?? ''} onChange={(event) => updateTeamEdit(team, 'assistantName', event.target.value)} placeholder="AT" className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white" />
                      <button type="button" disabled={isReadOnlySeason} onClick={() => void saveTeamEdit(team)} className="rounded border border-primary-300/40 bg-primary-500/20 px-2 py-1 text-xs font-semibold text-primary-100 disabled:cursor-not-allowed disabled:opacity-60">Guardar</button>
                      <button
                        type="button"
                        disabled={isReadOnlySeason}
                        onClick={() => void toggleTeamActive(team, team.active === false)}
                        className={`rounded border px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${team.active === false ? 'border-emerald-300/40 bg-emerald-500/20 text-emerald-100' : 'border-amber-300/50 bg-amber-500/20 text-amber-100'}`}
                      >
                        {team.active === false ? 'Reactivar' : 'Desactivar'}
                      </button>
                      <button type="button" disabled={isReadOnlySeason} onClick={() => requestDeleteTeam(team)} className="rounded border border-rose-300/50 bg-rose-600/20 px-2 py-1 text-xs font-semibold text-rose-100 disabled:cursor-not-allowed disabled:opacity-60">Eliminar</button>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
                      <label className="flex items-center gap-2 rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-slate-200">
                        Color principal
                        <input
                          type="color"
                          value={teamEditById[team.id]?.primaryColor ?? team.primaryColor ?? '#3b82f6'}
                          onChange={(event) => updateTeamEdit(team, 'primaryColor', event.target.value)}
                          className="h-8 w-16 rounded border border-white/20 cursor-pointer"
                        />
                      </label>
                      <label className="flex items-center gap-2 rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-slate-200">
                        Color alterno
                        <input
                          type="color"
                          value={teamEditById[team.id]?.secondaryColor ?? team.secondaryColor ?? '#ffffff'}
                          onChange={(event) => updateTeamEdit(team, 'secondaryColor', event.target.value)}
                          className="h-8 w-16 rounded border border-white/20 cursor-pointer"
                        />
                      </label>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
                      <label className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-slate-200">Foto DT
                        <input type="file" accept="image/*" className="mt-1 block w-full" onChange={async (event) => {
                          const file = event.target.files?.[0]
                          if (!file) return
                          updateTeamEdit(team, 'directorPhotoUrl', await toDataUrl(file))
                        }} />
                      </label>
                      <label className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-slate-200">Foto AT
                        <input type="file" accept="image/*" className="mt-1 block w-full" onChange={async (event) => {
                          const file = event.target.files?.[0]
                          if (!file) return
                          updateTeamEdit(team, 'assistantPhotoUrl', await toDataUrl(file))
                        }} />
                      </label>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-slate-300">
                      {teamEditById[team.id]?.directorPhotoUrl || team.technicalStaff?.director?.photoUrl ? (
                        <img src={teamEditById[team.id]?.directorPhotoUrl ?? team.technicalStaff?.director?.photoUrl} alt="DT" className="h-8 w-8 rounded-full border border-white/20 object-cover" />
                      ) : null}
                      <span>DT: {teamEditById[team.id]?.directorName ?? team.technicalStaff?.director?.name ?? 'Sin registrar'}</span>
                      {teamEditById[team.id]?.assistantPhotoUrl || team.technicalStaff?.assistant?.photoUrl ? (
                        <img src={teamEditById[team.id]?.assistantPhotoUrl ?? team.technicalStaff?.assistant?.photoUrl} alt="AT" className="h-8 w-8 rounded-full border border-white/20 object-cover" />
                      ) : null}
                      <span>AT: {teamEditById[team.id]?.assistantName ?? team.technicalStaff?.assistant?.name ?? 'Sin registrar'}</span>
                    </div>
                  </div>
                ))}
                {teamPagination.totalPages > 1 && (
                  <div className="mt-2 flex items-center justify-end gap-2 text-xs text-slate-300">
                    <button type="button" disabled={teamPagination.currentPage === 1} onClick={() => setTeamPage((current) => Math.max(current - 1, 1))} className="rounded border border-white/20 px-2 py-1 disabled:opacity-50">Anterior</button>
                    <span>Página {teamPagination.currentPage} / {teamPagination.totalPages}</span>
                    <button type="button" disabled={teamPagination.currentPage === teamPagination.totalPages} onClick={() => setTeamPage((current) => Math.min(current + 1, teamPagination.totalPages))} className="rounded border border-white/20 px-2 py-1 disabled:opacity-50">Siguiente</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'jugadores' && (
        <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/60 p-4">
          {!selectedLeague ? (
            <p className="text-sm text-slate-300">Selecciona una liga para gestionar jugadores.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr]">
                <select value={activeCategoryId} onChange={(event) => {
                  setSelectedCategoryId(event.target.value)
                  setSelectedTeamId('')
                  setPlayerSearch('')
                  setPlayerPositionFilter('TODAS')
                  setPlayerPage(1)
                }} className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white">
                  {categoryOptions.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
                <select value={selectedTeam?.id ?? ''} onChange={(event) => {
                  setSelectedTeamId(event.target.value)
                  setPlayerPage(1)
                }} className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white">
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>{team.name}</option>
                  ))}
                </select>
              </div>

              {!selectedTeam ? (
                <p className="mt-3 text-sm text-slate-300">No hay equipos para esta categoría.</p>
              ) : (
                <>
                  <p className="mt-2 text-xs text-slate-400">
                    Equipo: {selectedTeam.name} · Temporada {selectedLeague.season} · identifica jugadores por dorsal y edad.
                  </p>
                  <p className="mt-1 text-xs text-cyan-200">
                    Cupo categoría: {selectedTeam.players.length}/{activeCategoryMaxRegisteredPlayers} jugadoras registradas
                  </p>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    <input
                      value={playerSearch}
                      onChange={(event) => {
                        setPlayerSearch(event.target.value)
                        setPlayerPage(1)
                      }}
                      placeholder="Buscar por nombre o apodo"
                      className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                    />
                    <select
                      value={playerPositionFilter}
                      onChange={(event) => {
                        setPlayerPositionFilter(event.target.value as 'TODAS' | 'POR' | 'DEF' | 'MED' | 'DEL')
                        setPlayerPage(1)
                      }}
                      className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                    >
                      <option value="TODAS">Todas las posiciones</option>
                      {playerPositionOptions.map((position) => (
                        <option key={position} value={position}>{position}</option>
                      ))}
                    </select>
                    <p className="rounded border border-white/10 bg-slate-900 px-2 py-1 text-xs text-slate-300">
                      {filteredPlayers.length} jugadores
                    </p>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-7">
                    <input value={(playerDraftByTeam[selectedTeam.id] ?? defaultPlayerDraft).name} onChange={(event) => setPlayerDraftByTeam((current) => ({ ...current, [selectedTeam.id]: { ...(current[selectedTeam.id] ?? defaultPlayerDraft), name: event.target.value } }))} placeholder="Nombre jugador" className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white" />
                    <input value={(playerDraftByTeam[selectedTeam.id] ?? defaultPlayerDraft).nickname} onChange={(event) => setPlayerDraftByTeam((current) => ({ ...current, [selectedTeam.id]: { ...(current[selectedTeam.id] ?? defaultPlayerDraft), nickname: event.target.value } }))} placeholder="Apodo" className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white" />
                    <label className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-[11px] text-amber-200">Edad (años)
                      <input type="number" value={(playerDraftByTeam[selectedTeam.id] ?? defaultPlayerDraft).age} onChange={(event) => setPlayerDraftByTeam((current) => ({ ...current, [selectedTeam.id]: { ...(current[selectedTeam.id] ?? defaultPlayerDraft), age: Number(event.target.value) } }))} className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-xs text-white" />
                    </label>
                    <label className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-[11px] text-cyan-200">Dorsal (#)
                      <input type="number" value={(playerDraftByTeam[selectedTeam.id] ?? defaultPlayerDraft).number} onChange={(event) => setPlayerDraftByTeam((current) => ({ ...current, [selectedTeam.id]: { ...(current[selectedTeam.id] ?? defaultPlayerDraft), number: Number(event.target.value) } }))} className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-2 py-1 text-xs text-white" />
                    </label>
                    <select value={normalizePosition((playerDraftByTeam[selectedTeam.id] ?? defaultPlayerDraft).position)} onChange={(event) => setPlayerDraftByTeam((current) => ({ ...current, [selectedTeam.id]: { ...(current[selectedTeam.id] ?? defaultPlayerDraft), position: event.target.value } }))} className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white">
                      {playerPositionOptions.map((position) => (
                        <option key={position} value={position}>{position}</option>
                      ))}
                    </select>
                    <select
                      value={(playerDraftByTeam[selectedTeam.id] ?? defaultPlayerDraft).registrationStatus}
                      onChange={(event) =>
                        setPlayerDraftByTeam((current) => ({
                          ...current,
                          [selectedTeam.id]: {
                            ...(current[selectedTeam.id] ?? defaultPlayerDraft),
                            registrationStatus: event.target.value as 'pending' | 'registered',
                          },
                        }))
                      }
                      className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                    >
                      <option value="pending">Pendiente de registro</option>
                      <option value="registered">Registro OK</option>
                    </select>
                    <label className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-slate-200">Foto
                      <input type="file" accept="image/*" className="mt-1 block w-full" onChange={async (event) => {
                        const file = event.target.files?.[0]
                        if (!file) return
                        const photoUrl = await toDataUrl(file)
                        setPlayerDraftByTeam((current) => ({
                          ...current,
                          [selectedTeam.id]: {
                            ...(current[selectedTeam.id] ?? defaultPlayerDraft),
                            photoUrl,
                          },
                        }))
                      }} />
                    </label>
                  </div>
                  {(playerDraftByTeam[selectedTeam.id] ?? defaultPlayerDraft).photoUrl && (
                    <img
                      src={(playerDraftByTeam[selectedTeam.id] ?? defaultPlayerDraft).photoUrl}
                      alt="Nueva foto"
                      className="mt-2 h-10 w-10 rounded-full border border-white/20 object-cover"
                    />
                  )}
                  <div className="mt-2 grid grid-cols-1 gap-2 rounded border border-white/10 bg-slate-900/50 p-2 md:grid-cols-[auto_1fr]">
                    <label className="flex items-center gap-2 text-xs text-amber-100">
                      <input
                        type="checkbox"
                        checked={playerReplacementByTeam[selectedTeam.id]?.enabled ?? false}
                        onChange={(event) =>
                          setPlayerReplacementByTeam((current) => ({
                            ...current,
                            [selectedTeam.id]: {
                              enabled: event.target.checked,
                              replacePlayerId: event.target.checked ? (current[selectedTeam.id]?.replacePlayerId ?? '') : '',
                            },
                          }))
                        }
                      />
                      Reemplazo por lesión
                    </label>
                    <select
                      disabled={!(playerReplacementByTeam[selectedTeam.id]?.enabled ?? false)}
                      value={playerReplacementByTeam[selectedTeam.id]?.replacePlayerId ?? ''}
                      onChange={(event) =>
                        setPlayerReplacementByTeam((current) => ({
                          ...current,
                          [selectedTeam.id]: {
                            enabled: current[selectedTeam.id]?.enabled ?? true,
                            replacePlayerId: event.target.value,
                          },
                        }))
                      }
                      className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <option value="">Selecciona jugadora lesionada</option>
                      {selectedTeam.players.map((player) => (
                        <option key={`replace-${player.id}`} value={player.id}>
                          {player.name} · #{player.number}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    disabled={isReadOnlySeason}
                    onClick={() => void handleAddPlayer(selectedTeam.id)}
                    className="mt-2 rounded border border-primary-300/40 bg-primary-500/20 px-3 py-1 text-xs font-semibold text-primary-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {(playerReplacementByTeam[selectedTeam.id]?.enabled ?? false) ? 'Reemplazar jugadora' : 'Agregar jugador'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab('carnet')}
                    className="mt-3 rounded border border-cyan-300/40 bg-cyan-500/20 px-3 py-1 text-xs font-semibold text-cyan-100"
                  >
                    Ir a pestaña Carnet digital
                  </button>

                  <div className="mt-3 max-h-64 space-y-2 overflow-auto pr-1">
                    {playerPagination.pageItems.map((player) => {
                      const key = `${selectedTeam.id}:${player.id}`
                      const draft = playerEditById[key] ?? {
                        name: player.name,
                        nickname: player.nickname,
                        age: player.age,
                        number: player.number,
                        position: player.position,
                        registrationStatus: player.registrationStatus ?? 'registered',
                        photoUrl: player.photoUrl ?? '',
                      }

                      return (
                        <div key={player.id} className="rounded border border-white/10 bg-slate-800 p-2">
                          <div className="mb-2 flex items-center gap-2">
                            {draft.photoUrl ? (
                              <img src={draft.photoUrl} alt={draft.name} className="h-8 w-8 rounded-full border border-white/20 object-cover" />
                            ) : (
                              <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/20 text-[10px] text-slate-400">S/F</div>
                            )}
                            <p className="text-xs text-slate-300">{player.name} · Dorsal #{player.number} · {player.age} años</p>
                          </div>

                          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 xl:grid-cols-7">
                            <input value={draft.name} onChange={(event) => updatePlayerEdit(selectedTeam.id, player.id, { ...draft, name: event.target.value })} className="rounded border border-white/20 bg-slate-900 px-1 py-1 text-[11px] text-white" />
                            <input value={draft.nickname} onChange={(event) => updatePlayerEdit(selectedTeam.id, player.id, { ...draft, nickname: event.target.value })} className="rounded border border-white/20 bg-slate-900 px-1 py-1 text-[11px] text-white" />
                            <label className="rounded border border-white/20 bg-slate-900 px-1 py-1 text-[10px] text-amber-200">Edad
                              <input type="number" value={draft.age} onChange={(event) => updatePlayerEdit(selectedTeam.id, player.id, { ...draft, age: Number(event.target.value) })} className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-1 py-1 text-[11px] text-white" />
                            </label>
                            <label className="rounded border border-white/20 bg-slate-900 px-1 py-1 text-[10px] text-cyan-200">Dorsal
                              <input type="number" value={draft.number} onChange={(event) => updatePlayerEdit(selectedTeam.id, player.id, { ...draft, number: Number(event.target.value) })} className="mt-1 w-full rounded border border-white/20 bg-slate-800 px-1 py-1 text-[11px] text-white" />
                            </label>
                            <select value={normalizePosition(draft.position)} onChange={(event) => updatePlayerEdit(selectedTeam.id, player.id, { ...draft, position: event.target.value })} className="rounded border border-white/20 bg-slate-900 px-1 py-1 text-[11px] text-white">
                              {playerPositionOptions.map((position) => (
                                <option key={position} value={position}>{position}</option>
                              ))}
                            </select>
                            <select
                              value={draft.registrationStatus}
                              onChange={(event) =>
                                updatePlayerEdit(selectedTeam.id, player.id, {
                                  ...draft,
                                  registrationStatus: event.target.value as 'pending' | 'registered',
                                })
                              }
                              className="rounded border border-white/20 bg-slate-900 px-1 py-1 text-[11px] text-white"
                            >
                              <option value="pending">Pendiente</option>
                              <option value="registered">Registro OK</option>
                            </select>
                            <label className="rounded border border-white/20 bg-slate-900 px-1 py-1 text-[11px] text-slate-200">Foto
                              <input type="file" accept="image/*" className="mt-1 block w-full" onChange={async (event) => {
                                const file = event.target.files?.[0]
                                if (!file) return
                                updatePlayerEdit(selectedTeam.id, player.id, {
                                  ...draft,
                                  photoUrl: await toDataUrl(file),
                                })
                              }} />
                            </label>
                          </div>
                          <div className="mt-1 flex gap-2">
                            <button type="button" disabled={isReadOnlySeason} onClick={() => void savePlayerEdit(selectedTeam.id, player.id, draft)} className="rounded border border-primary-300/40 bg-primary-500/20 px-2 py-1 text-[11px] font-semibold text-primary-100 disabled:cursor-not-allowed disabled:opacity-60">Guardar</button>
                            <button type="button" disabled={isReadOnlySeason} onClick={() => requestDeletePlayer(selectedTeam.id, player.id, player.name)} className="rounded border border-rose-300/50 bg-rose-600/20 px-2 py-1 text-[11px] font-semibold text-rose-100 disabled:cursor-not-allowed disabled:opacity-60">Eliminar</button>
                          </div>
                        </div>
                      )
                    })}
                    {playerPagination.pageItems.length === 0 && (
                      <p className="text-xs text-slate-400">No hay jugadores con los filtros actuales.</p>
                    )}
                  </div>
                  {playerPagination.totalPages > 1 && (
                    <div className="mt-2 flex items-center justify-end gap-2 text-xs text-slate-300">
                      <button type="button" disabled={playerPagination.currentPage === 1} onClick={() => setPlayerPage((current) => Math.max(current - 1, 1))} className="rounded border border-white/20 px-2 py-1 disabled:opacity-50">Anterior</button>
                      <span>Página {playerPagination.currentPage} / {playerPagination.totalPages}</span>
                      <button type="button" disabled={playerPagination.currentPage === playerPagination.totalPages} onClick={() => setPlayerPage((current) => Math.min(current + 1, playerPagination.totalPages))} className="rounded border border-white/20 px-2 py-1 disabled:opacity-50">Siguiente</button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'carnet' && (
        <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/60 p-4">
          {!selectedLeague ? (
            <p className="text-sm text-slate-300">Selecciona una liga para generar carnets.</p>
          ) : teams.length === 0 ? (
            <p className="text-sm text-slate-300">No hay equipos en la categoría seleccionada para generar carnets.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                <select
                  value={activeCategoryId}
                  onChange={(event) => {
                    setSelectedCategoryId(event.target.value)
                    setSelectedTeamId('')
                    setDigitalCardTeamId('')
                    setDigitalCardPlayerId('')
                  }}
                  className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white"
                >
                  {categoryOptions.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>

                <select
                  value={digitalCardTeam?.id ?? ''}
                  onChange={(event) => {
                    setDigitalCardTeamId(event.target.value)
                    setDigitalCardPlayerId('')
                  }}
                  className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white"
                >
                  {teams.map((team) => (
                    <option key={`digital-card-team-${team.id}`} value={team.id}>{team.name}</option>
                  ))}
                </select>

                <select
                  value={digitalCardPlayer?.id ?? ''}
                  onChange={(event) => setDigitalCardPlayerId(event.target.value)}
                  className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white"
                >
                  {(digitalCardTeam?.players ?? []).map((player) => (
                    <option key={`digital-card-player-${player.id}`} value={player.id}>
                      {player.name} · #{player.number}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                <label className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-xs text-slate-200">
                  Logo de liga para carnet (opcional)
                  <input
                    type="file"
                    accept="image/*"
                    className="mt-1 block w-full"
                    onChange={async (event) => {
                      const file = event.target.files?.[0]
                      if (!file) return
                      setDigitalCardLeagueLogoOverrideDataUrl(await toDataUrl(file))
                      event.currentTarget.value = ''
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setDigitalCardLeagueLogoOverrideDataUrl('')}
                  className="rounded border border-white/20 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200"
                >
                  Restaurar logo oficial de liga
                </button>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-4">
                <button
                  type="button"
                  onClick={() => void downloadDigitalCardPng()}
                  disabled={!digitalCardPlayer || isGeneratingBulkCards}
                  className="rounded border border-emerald-300/40 bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Descargar imagen
                </button>
                <button
                  type="button"
                  onClick={() => void shareDigitalCardByWhatsapp()}
                  disabled={!digitalCardPlayer || isGeneratingBulkCards}
                  className="rounded border border-cyan-300/40 bg-cyan-500/20 px-3 py-2 text-xs font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Compartir por WS
                </button>
                <button
                  type="button"
                  onClick={() => void downloadTeamCardsZip()}
                  disabled={!digitalCardTeam || isGeneratingBulkCards}
                  className="rounded border border-violet-300/40 bg-violet-500/20 px-3 py-2 text-xs font-semibold text-violet-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isGeneratingBulkCards ? 'Generando ZIP...' : 'ZIP del equipo'}
                </button>
                <button
                  type="button"
                  onClick={() => void downloadCategoryCardsZip()}
                  disabled={teams.length === 0 || isGeneratingBulkCards}
                  className="rounded border border-amber-300/40 bg-amber-500/20 px-3 py-2 text-xs font-semibold text-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isGeneratingBulkCards ? 'Generando ZIP...' : 'ZIP de categoría'}
                </button>
              </div>

              <p className="mt-2 text-[11px] text-slate-400">
                Si cambian datos de jugadora (foto, dorsal, nombres), vuelve a generar y saldrá actualizado automáticamente.
              </p>

              {!digitalCardTeam || !digitalCardPlayer ? (
                <p className="mt-3 text-xs text-slate-400">Selecciona equipo y jugadora para previsualizar el carnet.</p>
              ) : (
                <div className="mt-4 overflow-x-auto pb-2">
                  <div
                    ref={digitalCardRef}
                    className="relative z-0 isolate h-[260px] w-[460px] overflow-hidden rounded-2xl border border-white/25 p-4 shadow-2xl"
                    style={{
                      backgroundImage: `linear-gradient(160deg, ${toRgba(digitalCardThemeColor, 0.98)} 0%, ${toRgba(
                        digitalCardThemeColor,
                        0.75,
                      )} 46%, ${toRgba('#020617', 0.95)} 100%)`,
                      color: digitalCardTextColor,
                    }}
                  >
                    <div className="absolute inset-0 opacity-15" style={{ backgroundImage: 'radial-gradient(circle at 18% 20%, #ffffff 0%, transparent 38%), radial-gradient(circle at 90% 88%, #ffffff 0%, transparent 28%)' }} />

                    <div className="relative z-10 flex h-full flex-col justify-between gap-3">
                      <div className="rounded-lg border border-white/20 bg-black/15 p-2.5">
                        <div className="flex items-center gap-2.5">
                          {digitalCardLeagueLogoSrc ? (
                            <img
                              src={digitalCardLeagueLogoSrc}
                              alt={selectedLeague.name}
                              crossOrigin="anonymous"
                              referrerPolicy="no-referrer"
                              className="h-11 w-11 rounded-full border border-white/40 bg-white object-contain p-1"
                            />
                          ) : (
                            <div className="flex h-11 w-11 items-center justify-center rounded-full border border-white/40 bg-white/20 text-[11px] font-bold">{digitalCardLeagueInitials || 'FL'}</div>
                          )}
                          <div>
                            <p className="text-[15px] font-black leading-tight">CARNET DIGITAL OFICIAL</p>
                            <p className="text-[11px] opacity-95">{selectedLeague.name} · Temporada {selectedLeague.season} · {activeCategoryName}</p>
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-[auto_1fr] items-center gap-3">
                        {digitalCardPlayerPhotoSrc ? (
                          <img
                            src={digitalCardPlayerPhotoSrc}
                            alt={digitalCardPlayer.name}
                            crossOrigin="anonymous"
                            referrerPolicy="no-referrer"
                            className="h-28 w-28 rounded-xl border-2 border-white/70 bg-slate-900 object-cover"
                          />
                        ) : (
                          <div className="flex h-28 w-28 items-center justify-center rounded-xl border-2 border-white/70 bg-slate-900/70 text-xs font-semibold">SIN FOTO</div>
                        )}

                        <div className="min-w-0 rounded-lg border border-white/20 bg-black/20 p-2.5">
                          <p className="truncate text-[11px] font-semibold tracking-wide opacity-90">NOMBRES</p>
                          <p className="truncate text-xl font-black leading-tight">{digitalCardPlayer.name}</p>
                          <p className="mt-1 text-lg font-bold">Dorsal #{digitalCardPlayer.number}</p>
                          <div className="mt-1.5 flex items-center gap-2">
                            {digitalCardTeamLogoSrc ? (
                              <img
                                src={digitalCardTeamLogoSrc}
                                alt={digitalCardTeam.name}
                                crossOrigin="anonymous"
                                referrerPolicy="no-referrer"
                                className="h-8 w-8 rounded border border-white/50 bg-white object-contain p-0.5"
                              />
                            ) : (
                              <div className="flex h-8 w-8 items-center justify-center rounded border border-white/50 bg-white/20 text-[10px] font-bold">EQ</div>
                            )}
                            <p className="truncate text-[14px] font-semibold">{digitalCardTeam.name}</p>
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-[108px_1fr] items-end gap-3">
                        <div className="rounded-md border border-white/40 bg-white p-1.5 text-slate-900">
                          {digitalCardQrDataUrl ? (
                            <img
                              src={digitalCardQrDataUrl}
                              alt="QR validación"
                              className="h-24 w-24"
                            />
                          ) : (
                            <div className="flex h-24 w-24 items-center justify-center text-[10px] font-semibold">QR</div>
                          )}
                        </div>
                        <p className="text-[11px] opacity-95">Escanea para validar registro de jugadora en plantilla titular/suplente.</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-4 rounded-xl border border-white/15 bg-slate-950/60 p-3">
                <p className="text-sm font-semibold text-white">Verificación de carnet por QR</p>
                <p className="mt-1 text-xs text-slate-300">
                  En celular puedes usar cámara. En computadora puedes cargar imagen del QR o pegar el texto del QR.
                </p>

                <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
                  <button
                    type="button"
                    onClick={() => void startQrScanner()}
                    disabled={isQrScanning}
                    className="rounded border border-cyan-300/40 bg-cyan-500/20 px-3 py-2 text-xs font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isQrScanning ? 'Escaneando...' : 'Escanear con cámara'}
                  </button>
                  <button
                    type="button"
                    onClick={() => stopQrScanner()}
                    disabled={!isQrScanning}
                    className="rounded border border-rose-300/40 bg-rose-500/20 px-3 py-2 text-xs font-semibold text-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Detener cámara
                  </button>
                  <label className="rounded border border-white/20 bg-slate-900 px-3 py-2 text-xs text-slate-200">
                    Validar desde imagen
                    <input
                      type="file"
                      accept="image/*"
                      className="mt-1 block w-full"
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        if (!file) return
                        void validateQrFromImageFile(file)
                        event.currentTarget.value = ''
                      }}
                    />
                  </label>
                </div>

                {isQrScanning && (
                  <div className="mt-3 max-w-sm overflow-hidden rounded-lg border border-white/20 bg-black">
                    <video ref={qrVideoRef} className="h-56 w-full object-cover" muted playsInline />
                  </div>
                )}

                <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto]">
                  <textarea
                    value={qrManualInput}
                    onChange={(event) => setQrManualInput(event.target.value)}
                    placeholder="Pega aquí el contenido del QR (JSON del carnet)"
                    className="min-h-24 rounded border border-white/20 bg-slate-900 px-2 py-2 text-xs text-white"
                  />
                  <button
                    type="button"
                    onClick={() => validateQrPayload(qrManualInput)}
                    className="rounded border border-emerald-300/40 bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-100"
                  >
                    Validar texto QR
                  </button>
                </div>

                {qrScanError && <p className="mt-2 text-xs text-amber-200">{qrScanError}</p>}

                {qrValidationState && (
                  <div className={`mt-3 rounded border px-3 py-2 text-xs ${qrValidationState.ok ? 'border-emerald-300/40 bg-emerald-500/10 text-emerald-100' : 'border-rose-300/40 bg-rose-500/10 text-rose-100'}`}>
                    <p className="font-semibold">{qrValidationState.title}</p>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {qrValidationState.details.map((detail, index) => (
                        <li key={`qr-validation-${index}`}>{detail}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'fixture' && (
        <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/60 p-4">
          {!selectedLeague ? (
            <p className="text-sm text-slate-300">Selecciona una liga para gestionar fixture.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
                <select value={activeCategoryId} onChange={(event) => {
                  setSelectedCategoryId(event.target.value)
                  setSelectedFixtureRound('')
                  setFixtureDraftMatchesByRound({})
                  setDraftMatchHomeTeamId('')
                  setDraftMatchAwayTeamId('')
                  setDraftMatchScheduledAt('')
                  setDraftMatchVenue('')
                }} className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white">
                  {categoryOptions.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void refreshFixture(true)}
                  disabled={isRefreshingFixture}
                  className="rounded border border-primary-300/40 bg-primary-500/20 px-3 py-2 text-xs font-semibold text-primary-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isRefreshingFixture ? 'Actualizando...' : 'Actualizar fixture'}
                </button>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">Recarga fixture, agenda y mejores jugadoras desde el backend.</p>

              <p className="mt-2 text-xs text-slate-400">
                Liga: {selectedLeague.name} · Temporada {selectedLeague.season} · Total de fechas: {fixtureRounds.length || 0}.
              </p>

              {isReadOnlySeason && (
                <p className="mt-2 rounded border border-amber-300/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">
                  Temporada histórica en solo lectura: puedes consultar fixture, pero no agregar ni publicar cambios.
                </p>
              )}

              {fixtureRounds.length > 0 && (
                <div className="mt-3 rounded border border-white/10 bg-slate-800/70 p-3">
                  <p className="text-xs font-semibold text-white">Selecciona la fecha a gestionar</p>
                  <p className="mt-1 text-[11px] text-slate-400">La fecha se carga en blanco para que agregues y edites cruces manualmente antes de guardar.</p>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[220px_auto] sm:items-center">
                    <select
                      value={activeFixtureRound ? String(activeFixtureRound) : ''}
                      onChange={(event) => {
                        setSelectedFixtureRound(event.target.value)
                        setDraftMatchHomeTeamId('')
                        setDraftMatchAwayTeamId('')
                        setDraftMatchScheduledAt('')
                        setDraftMatchVenue('')
                      }}
                      className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                    >
                      {fixtureRounds.map((round) => (
                        <option key={round} value={round}>Fecha {round}</option>
                      ))}
                    </select>
                    <p className="text-xs text-slate-300">Cruces en la fecha: {fixtureMatchesByRound.length}</p>
                  </div>
                </div>
              )}

              {activeFixtureRound > 0 && (
                <>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void downloadSocialCardPng()} className="rounded border border-primary-300/40 bg-primary-500/20 px-3 py-1 text-xs font-semibold text-primary-100">
                      Descargar PNG
                    </button>
                    <button type="button" onClick={shareFixtureByWhatsapp} className="rounded border border-emerald-300/40 bg-emerald-600/20 px-3 py-1 text-xs font-semibold text-emerald-100">
                      Compartir en WhatsApp
                    </button>
                    <button
                      type="button"
                      onClick={() => setMobileLogoOnlyMode((current) => !current)}
                      className="rounded border border-cyan-300/40 bg-cyan-500/20 px-3 py-1 text-xs font-semibold text-cyan-100"
                    >
                      {mobileLogoOnlyMode ? 'Móvil: solo logos' : 'Móvil: logos + nombre'}
                    </button>
                  </div>

                  <div ref={socialCardRef} className="mt-3 rounded-xl border border-slate-300 bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <TeamLogo logoUrl={selectedLeague.logoUrl} name={selectedLeague.name} sizeClass="h-12 w-12" />
                      <div>
                        <p className="text-base font-semibold text-slate-900">{selectedLeague.name}</p>
                        <p className="text-xs text-slate-600">Temporada {selectedLeague.season} · Fecha {activeFixtureRound}</p>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {socialMatches.length === 0 && <p className="text-xs text-slate-500">Aún no hay emparejamientos cargados para publicar en esta fecha.</p>}

                    {socialMatches.map((match, index) => {
                      const homeTeam = teamMap.get(match.homeTeamId)
                      const awayTeam = teamMap.get(match.awayTeamId)
                      const homeName = homeTeam?.name ?? 'Local'
                      const awayName = awayTeam?.name ?? 'Visitante'
                      const homeShortName = abbreviateTeamName(homeName)
                      const awayShortName = abbreviateTeamName(awayName)
                      const startLabel = match.scheduledAt ? new Date(match.scheduledAt).toLocaleString() : 'Hora por definir'
                      const venueLabel = match.venue?.trim() || ''

                      return (
                        <div key={`${match.homeTeamId}-${match.awayTeamId}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
                          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <TeamLogo logoUrl={homeTeam?.logoUrl} name={homeName} sizeClass="h-8 w-8" />
                              <span className="truncate text-sm font-semibold text-slate-900">
                                {!mobileLogoOnlyMode && <span className="sm:hidden">{homeShortName}</span>}
                                <span className="hidden sm:inline">{homeName}</span>
                              </span>
                            </div>
                            <span className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600">VS</span>
                            <div className="flex min-w-0 items-center justify-end gap-2">
                              <span className="truncate text-right text-sm font-semibold text-slate-900">
                                {!mobileLogoOnlyMode && <span className="sm:hidden">{awayShortName}</span>}
                                <span className="hidden sm:inline">{awayName}</span>
                              </span>
                              <TeamLogo logoUrl={awayTeam?.logoUrl} name={awayName} sizeClass="h-8 w-8" />
                            </div>
                          </div>
                          <p className="mt-2 text-center text-[11px] text-slate-600">{startLabel}</p>
                          {venueLabel && <p className="mt-1 text-center text-[11px] font-semibold text-slate-700">Cancha: {venueLabel}</p>}
                        </div>
                      )
                    })}
                  </div>

                  {projectedFreeTeam && (
                    <div className="mt-3 flex items-center gap-2 rounded border border-amber-300/60 bg-amber-100 px-2 py-1 text-xs text-amber-900">
                      <TeamLogo logoUrl={projectedFreeTeam.logoUrl} name={projectedFreeTeam.name} sizeClass="h-6 w-6" />
                      <span>Equipo libre de la fecha: {projectedFreeTeam.name}</span>
                    </div>
                  )}
                  </div>
                </>
              )}

              <div className="mt-3 rounded border border-white/10 bg-slate-800/70 p-3">
                <div className="rounded border border-white/10 bg-slate-900/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-white">Lista de cruces en borrador (editar o eliminar antes de guardar)</p>
                    <button
                      type="button"
                      disabled={isReadOnlySeason || !hasPublishedRoundMatches}
                      onClick={editPublishedRoundMatches}
                      className="rounded border border-primary-300/40 bg-primary-500/20 px-2 py-1 text-[11px] font-semibold text-primary-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Editar fixture guardado
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">Agrega partidos, modifica local/visitante/hora y al final guarda la fecha completa. Los partidos ya jugados se conservan y no se eliminan automáticamente.</p>

                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                      <select
                        value={draftMatchHomeTeamId}
                        onChange={(event) => {
                          const nextHomeTeamId = event.target.value
                          setDraftMatchHomeTeamId(nextHomeTeamId)
                          if (!nextHomeTeamId || nextHomeTeamId === draftMatchAwayTeamId) {
                            setDraftMatchAwayTeamId('')
                          }
                        }}
                        className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                      >
                        <option value="">Local</option>
                        {availableHomeTeamsForDraft.map((team) => (
                          <option key={team.id} value={team.id}>{team.name}</option>
                        ))}
                      </select>

                      <select
                        value={draftMatchAwayTeamId}
                        disabled={!draftMatchHomeTeamId}
                        onChange={(event) => setDraftMatchAwayTeamId(event.target.value)}
                        className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <option value="">{draftMatchHomeTeamId ? 'Visitante' : 'Primero selecciona local'}</option>
                        {availableAwayTeamsForDraft.map((team) => (
                          <option key={team.id} value={team.id}>{team.name}</option>
                        ))}
                      </select>

                      <input
                        type="datetime-local"
                        value={draftMatchScheduledAt}
                        onChange={(event) => setDraftMatchScheduledAt(event.target.value)}
                        className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                      />

                      {activeCategoryCourtsCount > 1 && (
                        <input
                          type="text"
                          value={draftMatchVenue}
                          onChange={(event) => setDraftMatchVenue(event.target.value)}
                          placeholder="Cancha"
                          className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                        />
                      )}

                      <button
                        type="button"
                        disabled={isReadOnlySeason}
                        onClick={addDraftMatchToRound}
                        className="rounded border border-primary-300/40 bg-primary-500/20 px-2 py-1 text-xs font-semibold text-primary-100 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Agregar partido
                      </button>
                  </div>

                  <div className="mt-3 space-y-2">
                    {activeRoundDraftMatches.length === 0 && (
                      <p className="text-xs text-slate-400">Todavía no hay partidos en borrador para esta fecha.</p>
                    )}

                    {activeRoundDraftMatches.map((draft) => {
                      const homeName = teamMap.get(draft.homeTeamId)?.name ?? 'Local'
                      const awayName = teamMap.get(draft.awayTeamId)?.name ?? 'Visitante'

                      return (
                        <div key={draft.id} className="rounded border border-white/10 bg-slate-900/70 p-2">
                          <p className="text-xs text-white">{homeName} vs {awayName}</p>
                          <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                            <select
                              value={draft.homeTeamId}
                              onChange={(event) =>
                                updateDraftMatchInRound(draft.id, {
                                  homeTeamId: event.target.value,
                                  sourceMatchId: undefined,
                                })
                              }
                              className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                            >
                              {sortedTeams
                                .filter((team) => team.id === draft.homeTeamId || !usedTeamIdsInDraftRound.has(team.id))
                                .map((team) => (
                                  <option key={team.id} value={team.id}>{team.name}</option>
                                ))}
                            </select>

                            <select
                              value={draft.awayTeamId}
                              onChange={(event) =>
                                updateDraftMatchInRound(draft.id, {
                                  awayTeamId: event.target.value,
                                  sourceMatchId: undefined,
                                })
                              }
                              className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                            >
                              {sortedTeams
                                .filter(
                                  (team) =>
                                    team.id !== draft.homeTeamId &&
                                    (team.id === draft.awayTeamId || !usedTeamIdsInDraftRound.has(team.id)),
                                )
                                .map((team) => (
                                  <option key={team.id} value={team.id}>{team.name}</option>
                                ))}
                            </select>

                            <input
                              type="datetime-local"
                              value={draft.scheduledAt}
                              onChange={(event) => updateDraftMatchInRound(draft.id, { scheduledAt: event.target.value })}
                              className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                            />

                            {activeCategoryCourtsCount > 1 && (
                              <input
                                type="text"
                                value={draft.venue ?? ''}
                                onChange={(event) => updateDraftMatchInRound(draft.id, { venue: event.target.value })}
                                placeholder="Cancha"
                                className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                              />
                            )}

                            <button
                              type="button"
                              disabled={isReadOnlySeason}
                              onClick={() => deleteDraftMatchInRound(draft.id)}
                              className="rounded border border-rose-300/50 bg-rose-600/20 px-2 py-1 text-xs font-semibold text-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Eliminar
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      disabled={isReadOnlySeason || activeRoundDraftMatches.length === 0 || isSavingFixtureRound}
                      onClick={() => void publishDraftRoundMatches()}
                      className="rounded border border-emerald-300/40 bg-emerald-600/20 px-3 py-1 text-xs font-semibold text-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isSavingFixtureRound ? 'Guardando...' : 'Guardar fecha'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Videos de partidos jugados */}
              {playedMatchesRecords.filter((r) => r.round === activeFixtureRound).length > 0 && (
                <div className="mt-4 rounded border border-cyan-300/20 bg-cyan-900/10 p-3">
                  <p className="mb-2 text-xs font-semibold text-white">Videos · Partidos jugados en Fecha {activeFixtureRound}</p>
                  <div className="flex flex-col gap-3">
                    {playedMatchesRecords
                      .filter((r) => r.round === activeFixtureRound)
                      .map((record) => {
                        const form = videoFormByMatch[record.matchId] ?? { file: null, name: '', url: '', mode: 'file' as const }
                        const isUploading = videoUploadingByMatch[record.matchId] ?? false
                        return (
                          <div key={record.matchId} className="rounded border border-white/10 bg-slate-800/50 p-2">
                            <p className="mb-1 text-xs font-medium text-slate-200">
                              {record.homeTeamName} {record.homeStats.goals} – {record.awayStats.goals} {record.awayTeamName}
                            </p>
                            {record.highlightVideos.length > 0 ? (
                              <div className="mb-2 grid gap-2 md:grid-cols-2">
                                {record.highlightVideos.map((video) => (
                                  <div key={video.id} className="rounded border border-white/10 bg-slate-900/60 p-2">
                                    <div className="mb-2 flex items-center justify-between gap-2">
                                      <p className="truncate text-xs text-cyan-100">{video.name}</p>
                                      <button
                                        type="button"
                                        onClick={() => void handleDeleteMatchVideo(record.matchId, video.id, record.categoryId)}
                                        className="rounded border border-red-400/30 bg-red-500/10 px-2 py-1 text-[10px] font-semibold text-red-200 hover:bg-red-500/20"
                                      >
                                        Eliminar
                                      </button>
                                    </div>
                                    <video src={video.url} controls className="w-full rounded" />
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="mb-2 text-xs text-slate-500">Sin videos</p>
                            )}
                            <div className="flex flex-col gap-1">
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => setVideoFormByMatch((prev) => ({ ...prev, [record.matchId]: { ...(prev[record.matchId] ?? { file: null, name: '', url: '' }), mode: 'file' } }))}
                                  className={`rounded px-2 py-0.5 text-xs ${form.mode !== 'url' ? 'bg-cyan-600/40 text-cyan-100' : 'text-slate-400'}`}
                                >Archivo</button>
                                <button
                                  type="button"
                                  onClick={() => setVideoFormByMatch((prev) => ({ ...prev, [record.matchId]: { ...(prev[record.matchId] ?? { file: null, name: '', url: '' }), mode: 'url' } }))}
                                  className={`rounded px-2 py-0.5 text-xs ${form.mode === 'url' ? 'bg-cyan-600/40 text-cyan-100' : 'text-slate-400'}`}
                                >URL</button>
                              </div>
                              <input
                                type="text"
                                placeholder="Nombre del video (opcional)"
                                value={form.name}
                                onChange={(e) => setVideoFormByMatch((prev) => ({ ...prev, [record.matchId]: { ...(prev[record.matchId] ?? { file: null, url: '', mode: 'file' as const }), name: e.target.value } }))}
                                className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white placeholder-slate-500"
                              />
                              {form.mode !== 'url' ? (
                                <input
                                  type="file"
                                  accept="video/*"
                                  onChange={(e) => setVideoFormByMatch((prev) => ({ ...prev, [record.matchId]: { ...(prev[record.matchId] ?? { name: '', url: '', mode: 'file' as const }), file: e.target.files?.[0] ?? null } }))}
                                  className="text-xs text-slate-300"
                                />
                              ) : (
                                <input
                                  type="url"
                                  placeholder="https://..."
                                  value={form.url}
                                  onChange={(e) => setVideoFormByMatch((prev) => ({ ...prev, [record.matchId]: { ...(prev[record.matchId] ?? { file: null, name: '', mode: 'url' as const }), url: e.target.value } }))}
                                  className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white placeholder-slate-500"
                                />
                              )}
                              <button
                                type="button"
                                disabled={isUploading}
                                onClick={() => void handleUploadMatchVideo(record.matchId, record.categoryId)}
                                className="self-end rounded border border-cyan-300/40 bg-cyan-600/20 px-3 py-1 text-xs font-semibold text-cyan-100 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {isUploading ? 'Subiendo...' : 'Agregar video'}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                  </div>
                </div>
              )}

            </>
          )}
        </div>
      )}

      {tab === 'mvp' && (
        <div className="mt-4 rounded-xl border border-white/10 bg-slate-900/60 p-4">
          {!selectedLeague ? (
            <p className="text-sm text-slate-300">Selecciona una liga para gestionar MVP por fecha.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
                <select
                  value={activeCategoryId}
                  onChange={(event) => {
                    setSelectedCategoryId(event.target.value)
                    setSelectedFixtureRound('')
                  }}
                  className="rounded border border-white/20 bg-slate-900 px-2 py-2 text-sm text-white"
                >
                  {categoryOptions.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void refreshFixture(true)}
                  disabled={isRefreshingFixture}
                  className="rounded border border-primary-300/40 bg-primary-500/20 px-3 py-2 text-xs font-semibold text-primary-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isRefreshingFixture ? 'Actualizando...' : 'Actualizar datos'}
                </button>
              </div>

              {fixtureRounds.length > 0 && (
                <div className="mt-3 rounded border border-white/10 bg-slate-800/70 p-3">
                  <p className="text-xs font-semibold text-white">Selecciona la fecha para MVP</p>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[220px_auto] sm:items-center">
                    <select
                      value={activeFixtureRound ? String(activeFixtureRound) : ''}
                      onChange={(event) => setSelectedFixtureRound(event.target.value)}
                      className="rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                    >
                      {fixtureRounds.map((round) => (
                        <option key={round} value={round}>Fecha {round}</option>
                      ))}
                    </select>
                    <p className="text-xs text-slate-300">Partidos agendados en la fecha: {scheduledRoundMatches.length}</p>
                  </div>
                </div>
              )}

              <div className="mt-3 rounded border border-fuchsia-300/20 bg-fuchsia-900/10 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs font-semibold text-white">Mejores jugadoras por partido · Fecha {activeFixtureRound || '-'}</p>
                    <p className="mt-1 text-[11px] text-slate-300">Selecciona la mejor jugadora de cada cruce y luego define la jugadora de la fecha.</p>
                    <p className="mt-1 text-[11px] text-amber-200">Partidos culminados en la fecha: {roundCompletedMatchesCount}/{totalRoundMatches || 0}</p>
                  </div>
                  <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap">
                    <button type="button" onClick={() => void downloadRoundAwardsCardPng()} className="rounded border border-fuchsia-300/40 bg-fuchsia-500/20 px-2 py-1 text-xs font-semibold text-fuchsia-100 sm:w-auto">
                      Descargar imagen MVP
                    </button>
                    <button type="button" onClick={shareRoundAwardsByWhatsapp} className="rounded border border-emerald-300/40 bg-emerald-600/20 px-2 py-1 text-xs font-semibold text-emerald-100 sm:w-auto">
                      Compartir MVP en WhatsApp
                    </button>
                    <button
                      type="button"
                      onClick={() => setMvpMobileLogoOnlyMode((current) => !current)}
                      className="rounded border border-cyan-300/40 bg-cyan-500/20 px-2 py-1 text-xs font-semibold text-cyan-100 sm:w-auto"
                    >
                      {mvpMobileLogoOnlyMode ? 'MVP móvil: solo logos' : 'MVP móvil: logos + nombre'}
                    </button>
                  </div>
                </div>

                <div ref={roundAwardsCardRef} className="mt-3 rounded-xl border border-slate-300 bg-white p-4">
                  <div className="flex items-center gap-3">
                    <TeamLogo logoUrl={selectedLeague.logoUrl} name={selectedLeague.name} sizeClass="h-10 w-10" />
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{selectedLeague.name}</p>
                      <p className="text-xs text-slate-600">Mejores jugadoras · Fecha {activeFixtureRound}</p>
                    </div>
                  </div>

                  <div className="mt-3 space-y-2">
                    {mergedActiveRoundMatchBestPlayers.length === 0 && (
                      <p className="text-xs text-slate-500">Aún no hay jugadoras seleccionadas para esta fecha.</p>
                    )}
                    {mergedActiveRoundMatchBestPlayers.map((item) => {
                      const homeTeam = teamMap.get(item.homeTeamId)
                      const awayTeam = teamMap.get(item.awayTeamId)
                      const homeName = homeTeam?.name ?? 'Local'
                      const awayName = awayTeam?.name ?? 'Visitante'
                      const homeShortName = abbreviateTeamName(homeName)
                      const awayShortName = abbreviateTeamName(awayName)
                      const candidatePhotoUrl = playersById.get(item.playerId)?.photoUrl
                      const isRoundBest = mergedActiveRoundBestPlayerId === item.playerId
                      const mvpCountInRound = activeRoundMvpCountByPlayerId.get(item.playerId) ?? 1
                      return (
                        <div key={item.matchKey} className={`rounded border px-2 py-2 ${isRoundBest ? 'border-amber-400 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}>
                          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <TeamLogo logoUrl={homeTeam?.logoUrl} name={homeName} sizeClass="h-7 w-7" />
                              <span className="truncate text-xs font-semibold text-slate-900">
                                {!mvpMobileLogoOnlyMode && <span className="sm:hidden">{homeShortName}</span>}
                                <span className="hidden sm:inline">{homeName}</span>
                              </span>
                            </div>
                            <span className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600">VS</span>
                            <div className="flex min-w-0 items-center justify-end gap-2">
                              <span className="truncate text-right text-xs font-semibold text-slate-900">
                                {!mvpMobileLogoOnlyMode && <span className="sm:hidden">{awayShortName}</span>}
                                <span className="hidden sm:inline">{awayName}</span>
                              </span>
                              <TeamLogo logoUrl={awayTeam?.logoUrl} name={awayName} sizeClass="h-7 w-7" />
                            </div>
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            {candidatePhotoUrl ? (
                              <img src={candidatePhotoUrl} alt={item.playerName} className="h-8 w-8 rounded-full border border-slate-300 object-cover" />
                            ) : (
                              <div className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 bg-slate-100 text-[10px] font-semibold text-slate-600">
                                MVP
                              </div>
                            )}
                            <div className="min-w-0">
                              <p className="truncate text-[11px] font-semibold text-slate-800">⭐ {item.playerName}</p>
                              <p className="truncate text-[10px] text-slate-600">{item.teamName}</p>
                            </div>
                            {mvpCountInRound > 1 && (
                              <span className="ml-auto rounded border border-fuchsia-300 bg-fuchsia-100 px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-700">
                                x{mvpCountInRound} en fecha
                              </span>
                            )}
                          </div>
                          {isRoundBest && (
                            <p className="mt-1 rounded border border-amber-300/70 bg-amber-100 px-2 py-1 text-[10px] font-semibold text-amber-900">
                              🏅 Seleccionada como jugadora de la fecha
                            </p>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {(() => {
                    const roundBestPlayer = mergedRoundBestPlayerOptions.find((item) => item.playerId === mergedActiveRoundBestPlayerId)
                    if (!roundBestPlayer) return null
                    const roundBestPhotoUrl = playersById.get(roundBestPlayer.playerId)?.photoUrl
                    return (
                      <div className="mt-3 rounded border border-amber-300/60 bg-amber-100 px-2 py-2 text-xs text-amber-900">
                        <div className="flex items-center gap-2">
                          {roundBestPhotoUrl ? (
                            <img src={roundBestPhotoUrl} alt={roundBestPlayer.playerName} className="h-9 w-9 rounded-full border border-amber-400 object-cover" />
                          ) : (
                            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-amber-400 bg-amber-50 text-[10px] font-bold text-amber-700">
                              MVP
                            </div>
                          )}
                          <p className="font-semibold">🏅 Jugadora de la fecha: {roundBestPlayer.playerName} ({roundBestPlayer.teamName})</p>
                        </div>
                      </div>
                    )
                  })()}
                </div>

                <div className="mt-3 space-y-2">
                  {activeRoundMatchMvpOptions.length === 0 && (
                    <p className="text-xs text-slate-300">Primero agenda y guarda partidos en la fecha para habilitar selección de MVP por partido.</p>
                  )}
                  {activeRoundMatchMvpOptions.map((entry) => {
                    const selected = activeRoundBestPlayerByMatch.get(entry.matchKey)

                    return (
                      <div key={entry.matchKey} className="rounded border border-white/10 bg-slate-900/60 p-2">
                        <p className="text-xs text-white">{entry.homeTeamName} vs {entry.awayTeamName}</p>
                        <select
                          value={selected?.playerId ?? ''}
                          onChange={(event) => {
                            const candidate = entry.players.find((item) => item.playerId === event.target.value)
                            if (!candidate) return
                            setMatchBestPlayer(entry.matchKey, entry.match.homeTeamId, entry.match.awayTeamId, candidate)
                          }}
                          className="mt-1 w-full rounded border border-white/20 bg-slate-900 px-2 py-1 text-xs text-white"
                        >
                          <option value="">Selecciona mejor jugadora del partido</option>
                          {entry.players.map((player) => (
                            <option key={player.playerId} value={player.playerId}>
                              {player.playerName} · {player.teamName}
                            </option>
                          ))}
                        </select>
                      </div>
                    )
                  })}
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto] md:items-center">
                  <select
                    value={mergedActiveRoundBestPlayerId}
                    onChange={(event) => {
                      const nextRoundBestPlayerId = event.target.value
                      setRoundAwardsByRound((current) => ({
                        ...current,
                        [activeFixtureRound]: {
                          matchBestPlayers: mergedActiveRoundMatchBestPlayers,
                          roundBestPlayerId: nextRoundBestPlayerId,
                        },
                      }))
                    }}
                    className="rounded border border-amber-300/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-100"
                  >
                    <option value="">Selecciona jugadora de la fecha</option>
                    {mergedRoundBestPlayerOptions.map((item) => {
                      const roundCount = activeRoundMvpCountByPlayerId.get(item.playerId) ?? 1
                      return (
                      <option key={item.playerId} value={item.playerId}>
                        {item.playerName} · {item.teamName} · MVP partido x{roundCount}
                      </option>
                      )
                    })}
                  </select>

                  <button
                    type="button"
                    disabled={isReadOnlySeason || mergedActiveRoundMatchBestPlayers.length === 0 || !isActiveRoundCompleted}
                    onClick={() => void saveRoundAwards()}
                    className="rounded border border-fuchsia-300/40 bg-fuchsia-500/20 px-3 py-1 text-xs font-semibold text-fuchsia-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Guardar mejores jugadoras
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div className="rounded border border-white/10 bg-slate-900/70 p-2">
                  <p className="text-xs font-semibold text-white">Top 5 acumulado · Jugadora de la fecha</p>
                  <div className="mt-2 space-y-1 text-xs">
                    {top5RoundAwardsRanking.length === 0 && (
                      <p className="text-slate-400">Aún no hay votos guardados de jugadora de la fecha.</p>
                    )}
                    {top5RoundAwardsRanking.map((item, index) => (
                      <p key={item.playerId} className="text-slate-200">
                        {index + 1}. {item.playerName} ({item.teamName}) · {item.votes} voto{item.votes === 1 ? '' : 's'}
                      </p>
                    ))}
                    {top5RoundAwardsRanking[0] && (
                      <p className="mt-2 rounded border border-emerald-300/40 bg-emerald-500/10 px-2 py-1 text-emerald-100">
                        Líder de temporada: {top5RoundAwardsRanking[0].playerName} ({top5RoundAwardsRanking[0].teamName}) · {top5RoundAwardsRanking[0].votes} votos
                      </p>
                    )}
                  </div>
                  </div>
                  <div className="rounded border border-white/10 bg-slate-900/70 p-2">
                    <p className="text-xs font-semibold text-white">Top 5 acumulado · MVP por partido</p>
                    <div className="mt-2 space-y-1 text-xs">
                      {seasonMatchMvpRanking.length === 0 && (
                        <p className="text-slate-400">Aún no hay MVP de partido registrados.</p>
                      )}
                      {seasonMatchMvpRanking.slice(0, 5).map((item, index) => (
                        <p key={item.playerId} className="text-slate-200">
                          {index + 1}. {item.playerName} ({item.teamName}) · {item.votes} MVP{item.votes === 1 ? '' : 's'}
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-white/20 bg-slate-900 p-4 shadow-xl">
            <h4 className="text-lg font-semibold text-white">{confirmTitle}</h4>
            <p className="mt-2 text-sm text-slate-300">
              ¿Confirmas eliminar <span className="font-semibold text-white">{confirmAction.label}</span>? Esta acción no se puede deshacer.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmAction(null)} className="rounded border border-white/20 px-3 py-1 text-sm text-slate-200">Cancelar</button>
              <button type="button" onClick={() => void executeConfirm()} className="rounded border border-rose-300/50 bg-rose-600/30 px-3 py-1 text-sm font-semibold text-rose-100">Eliminar</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
