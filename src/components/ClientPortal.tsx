import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { StoreFooter } from './StoreFooter'
import { apiBaseUrl, apiService } from '../services/api'
import type { FixtureScheduleEntry } from '../types/admin'
import type { LiveEvent, LiveMatch } from '../types/live'

interface PublicLeagueSummary {
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
}

interface PublicTeam {
  id: string
  name: string
  logoUrl?: string
  technicalStaff?: {
    director?: {
      name: string
      photoUrl?: string
    }
    assistant?: {
      name: string
      photoUrl?: string
    }
  }
  players: Array<{
    id: string
    name: string
    nickname: string
    age: number
    number: number
    position: string
    photoUrl?: string
  }>
}

interface PublicFixturePayload {
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
  category: { id: string; name: string }
  teams: PublicTeam[]
  fixture: {
    rounds: Array<{
      round: number
      matches: Array<{
        homeTeamId: string
        awayTeamId: string | null
        hasBye: boolean
      }>
    }>
  }
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
      type: LiveEvent['type']
      teamName: string
      playerName: string
      substitutionInPlayerName?: string
      staffRole?: 'director' | 'assistant'
    }>
    playerOfMatchId?: string
    playerOfMatchName?: string
    playerOfMatchPhotoUrl?: string
    playerOfMatchTeamName?: string
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

interface ClientPortalProps {
  clientId: string
}

interface ScheduledMatch {
  id: string
  round: number
  homeTeamId: string
  awayTeamId: string
  scheduledAt?: string
  venue?: string
  played: boolean
}

type LineupPlayer = {
  id: string
  name: string
  number: number
  position?: string
  photoUrl?: string
}

type ClientStatsTab = 'matches' | 'standings' | 'scorers' | 'assists' | 'yellows' | 'reds' | 'keepers'

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

const normalizeLabel = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

const parseFormationLines = (formationKey?: string) => {
  if (!formationKey) return null

  const parsed = formationKey
    .split('-')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0)

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

type TeamPalette = {
  fill: string
  text: string
}

type PublicEngagementState = {
  visits: number
  likes: number
  likedByCurrentUser: boolean
}

type PublicMatchLikeState = {
  likes: number
  likedByCurrentUser: boolean
}

const clampChannel = (value: number) => Math.max(45, Math.min(210, Math.round(value)))

const toPalette = (red: number, green: number, blue: number): TeamPalette => {
  const r = clampChannel(red)
  const g = clampChannel(green)
  const b = clampChannel(blue)
  const luminance = r * 0.299 + g * 0.587 + b * 0.114
  return {
    fill: `rgb(${r}, ${g}, ${b})`,
    text: luminance > 160 ? '#0f172a' : '#f8fafc',
  }
}

const paletteFromName = (seed: string): TeamPalette => {
  const normalized = seed.trim().toLowerCase() || 'equipo'
  let hash = 0
  for (let index = 0; index < normalized.length; index += 1) {
    hash = normalized.charCodeAt(index) + ((hash << 5) - hash)
  }

  const red = (hash >> 16) & 255
  const green = (hash >> 8) & 255
  const blue = hash & 255

  return toPalette(Math.abs(red), Math.abs(green), Math.abs(blue))
}

const extractLogoPalette = async (logoUrl?: string): Promise<TeamPalette | null> => {
  if (!logoUrl || typeof window === 'undefined') return null

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('Logo no disponible'))
      img.src = logoUrl
    })

    const canvas = document.createElement('canvas')
    canvas.width = 24
    canvas.height = 24
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null

    context.drawImage(image, 0, 0, 24, 24)
    const pixels = context.getImageData(0, 0, 24, 24).data

    let red = 0
    let green = 0
    let blue = 0
    let count = 0

    for (let offset = 0; offset < pixels.length; offset += 4) {
      const alpha = pixels[offset + 3]
      if (alpha < 40) continue

      red += pixels[offset] ?? 0
      green += pixels[offset + 1] ?? 0
      blue += pixels[offset + 2] ?? 0
      count += 1
    }

    if (count === 0) return null

    return toPalette(red / count, green / count, blue / count)
  } catch {
    return null
  }
}

const withAlpha = (rgb: string, alpha: number) => {
  const raw = rgb.trim().toLowerCase()

  if (raw.startsWith('#')) {
    const hex = raw.slice(1)
    if (hex.length === 3) {
      const red = Number.parseInt(hex[0] + hex[0], 16)
      const green = Number.parseInt(hex[1] + hex[1], 16)
      const blue = Number.parseInt(hex[2] + hex[2], 16)
      return `rgba(${red}, ${green}, ${blue}, ${alpha})`
    }

    if (hex.length >= 6) {
      const red = Number.parseInt(hex.slice(0, 2), 16)
      const green = Number.parseInt(hex.slice(2, 4), 16)
      const blue = Number.parseInt(hex.slice(4, 6), 16)
      return `rgba(${red}, ${green}, ${blue}, ${alpha})`
    }
  }

  const channels = raw.match(/\d+/g)
  if (!channels || channels.length < 3) return `rgba(15, 23, 42, ${alpha})`
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`
}

const parseRgb = (color: string) => {
  const raw = color.trim().toLowerCase()
  if (raw.startsWith('#')) {
    const hex = raw.slice(1)
    if (hex.length === 3) {
      const red = Number.parseInt(hex[0] + hex[0], 16)
      const green = Number.parseInt(hex[1] + hex[1], 16)
      const blue = Number.parseInt(hex[2] + hex[2], 16)
      return { red, green, blue }
    }
    if (hex.length === 6) {
      const red = Number.parseInt(hex.slice(0, 2), 16)
      const green = Number.parseInt(hex.slice(2, 4), 16)
      const blue = Number.parseInt(hex.slice(4, 6), 16)
      return { red, green, blue }
    }
  }

  const channels = raw.match(/\d+/g)
  if (!channels || channels.length < 3) return null
  return {
    red: Number(channels[0] ?? 0),
    green: Number(channels[1] ?? 0),
    blue: Number(channels[2] ?? 0),
  }
}

const pickReadableEventTextColor = (backgroundColor: string, alpha = 0.22) => {
  const parsed = parseRgb(backgroundColor)
  if (!parsed) return '#f8fafc'

  const base = { red: 2, green: 6, blue: 23 }
  const blended = {
    red: Math.round(parsed.red * alpha + base.red * (1 - alpha)),
    green: Math.round(parsed.green * alpha + base.green * (1 - alpha)),
    blue: Math.round(parsed.blue * alpha + base.blue * (1 - alpha)),
  }

  const luminance = blended.red * 0.299 + blended.green * 0.587 + blended.blue * 0.114
  return luminance > 150 ? '#0f172a' : '#f8fafc'
}

const playGoalBeep = () => {
  if (typeof window === 'undefined') return

  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) return

  const context = new AudioContextClass()
  const oscillator = context.createOscillator()
  const gain = context.createGain()

  oscillator.type = 'triangle'
  oscillator.frequency.setValueAtTime(740, context.currentTime)
  oscillator.frequency.exponentialRampToValueAtTime(960, context.currentTime + 0.12)

  gain.gain.setValueAtTime(0.0001, context.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.03)
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22)

  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start(context.currentTime)
  oscillator.stop(context.currentTime + 0.24)

  window.setTimeout(() => {
    void context.close()
  }, 280)
}

const getPublicLikeStorageKey = (clientId: string) => `@fl_public_like_${clientId}`

const getPublicVisitSessionKey = (clientId: string) => `@fl_public_visit_session_${clientId}`

const getPublicAliasStorageKey = (clientId: string) => `@fl_public_alias_${clientId}`

const getPublicMatchLikeStorageKey = (clientId: string, matchId: string) => `@fl_public_like_${clientId}_${matchId}`

const readPublicLikePreference = (clientId: string) => {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(getPublicLikeStorageKey(clientId)) === '1'
}

const persistPublicLikePreference = (clientId: string, liked: boolean) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(getPublicLikeStorageKey(clientId), liked ? '1' : '0')
}

const buildTeamFromLiveOrRoster = (
  teamId: string,
  liveTeam: LiveMatch['homeTeam'] | LiveMatch['awayTeam'] | null,
  rosterTeam: PublicTeam | null,
  savedLineup?: {
    starters: string[]
    substitutes: string[]
    formationKey?: string
  } | null,
) => {
  if (liveTeam) {
    const starters = liveTeam.starters
      .map((playerId) => liveTeam.players.find((player) => player.id === playerId))
      .filter((item): item is LiveMatch['homeTeam']['players'][number] => Boolean(item))

    const substitutes = liveTeam.substitutes
      .map((playerId) => liveTeam.players.find((player) => player.id === playerId))
      .filter((item): item is LiveMatch['homeTeam']['players'][number] => Boolean(item))

    return {
      id: liveTeam.id,
      name: liveTeam.name,
      logoUrl: rosterTeam?.logoUrl,
      allPlayers: liveTeam.players,
      starters,
      substitutes,
      formationKey: liveTeam.formationKey,
    }
  }

  const players = (rosterTeam?.players ?? []).slice().sort((left, right) => left.number - right.number)

  if (savedLineup && players.length > 0) {
    const byId = new Map(players.map((player) => [player.id, player]))
    const starters = savedLineup.starters
      .map((playerId) => byId.get(playerId))
      .filter((item): item is PublicTeam['players'][number] => Boolean(item))
    const substitutes = savedLineup.substitutes
      .map((playerId) => byId.get(playerId))
      .filter((item): item is PublicTeam['players'][number] => Boolean(item))

    const includedIds = new Set([...starters.map((item) => item.id), ...substitutes.map((item) => item.id)])
    const remaining = players.filter((item) => !includedIds.has(item.id))

    return {
      id: teamId,
      name: rosterTeam?.name ?? 'Equipo',
      logoUrl: rosterTeam?.logoUrl,
      allPlayers: players,
      starters,
      substitutes: [...substitutes, ...remaining],
      formationKey: savedLineup.formationKey,
    }
  }

  const starters: typeof players = []
  const substitutes = players

  return {
    id: teamId,
    name: rosterTeam?.name ?? 'Equipo',
    logoUrl: rosterTeam?.logoUrl,
    allPlayers: players,
    starters,
    substitutes,
    formationKey: undefined,
  }
}

const eventLabel: Record<LiveEvent['type'], string> = {
  shot: 'Remate',
  goal: 'Gol',
  penalty_goal: 'Gol de penal',
  penalty_miss: 'Penal fallado',
  yellow: 'TA',
  red: 'TR',
  double_yellow: 'Doble amarilla',
  assist: 'Asistencia',
  substitution: 'Cambio',
  staff_yellow: 'TA CT',
  staff_red: 'TR CT',
}

const staffRoleLabel = (role: 'director' | 'assistant') => (role === 'director' ? 'DT' : 'AT')

const TeamBadge = ({ logoUrl, name }: { logoUrl?: string; name: string }) => (
  <div className="flex items-center gap-2">
    {logoUrl ? (
      <img src={logoUrl} alt={name} className="h-8 w-8 rounded-full border border-white/20 bg-white object-contain p-0.5" />
    ) : (
      <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/20 text-[10px] text-slate-300">{name.slice(0, 2).toUpperCase()}</div>
    )}
    <span className="font-semibold text-white">{name}</span>
  </div>
)

const StaffCard = ({
  side,
  teamName,
  palette,
  director,
  assistant,
  discipline,
}: {
  side: 'home' | 'away'
  teamName: string
  palette: TeamPalette
  director?: { name: string; photoUrl?: string }
  assistant?: { name: string; photoUrl?: string }
  discipline?: {
    director?: { yellows: number; reds: number }
    assistant?: { yellows: number; reds: number }
  }
}) => {
  const people = [
    {
      label: 'DT',
      role: 'director' as const,
      name: director?.name ?? 'Sin registrar',
      photoUrl: director?.photoUrl,
      yellows: discipline?.director?.yellows ?? 0,
      reds: discipline?.director?.reds ?? 0,
    },
    {
      label: 'AT',
      role: 'assistant' as const,
      name: assistant?.name ?? 'Sin registrar',
      photoUrl: assistant?.photoUrl,
      yellows: discipline?.assistant?.yellows ?? 0,
      reds: discipline?.assistant?.reds ?? 0,
    },
  ]

  return (
    <div
      className={`rounded-xl border p-2 ${side === 'away' ? 'text-right' : ''}`}
      style={{
        borderColor: withAlpha(palette.fill, 0.65),
        backgroundColor: withAlpha(palette.fill, 0.16),
      }}
    >
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: palette.text }}>
        Cuerpo técnico · {teamName}
      </p>
      <div className="space-y-2">
        {people.map((person) => (
          <div key={person.label} className={`flex items-center gap-2 ${side === 'away' ? 'justify-end' : ''}`}>
            {side === 'away' && (
              <p className="text-xs" style={{ color: palette.text }}>
                {person.label}: {person.name}
                {(person.yellows > 0 || person.reds > 0) && (
                  <span className="ml-2 inline-flex items-center gap-1">
                    {person.yellows > 0 && <span className="rounded bg-amber-400/90 px-1 text-[10px] font-bold text-amber-950">TA {person.yellows}</span>}
                    {person.reds > 0 && <span className="rounded bg-rose-600/95 px-1 text-[10px] font-bold text-rose-50">TR {person.reds}</span>}
                  </span>
                )}
              </p>
            )}
            {person.photoUrl ? (
              <img
                src={person.photoUrl}
                alt={`${person.label} ${person.name}`}
                className="h-10 w-10 rounded-full border border-white/30 object-cover"
              />
            ) : (
              <div
                className="flex h-10 w-10 items-center justify-center rounded-full border text-[10px] font-bold"
                style={{
                  borderColor: withAlpha(palette.text, 0.45),
                  backgroundColor: withAlpha(palette.fill, 0.32),
                  color: palette.text,
                }}
              >
                {person.label}
              </div>
            )}
            {side === 'home' && (
              <p className="text-xs" style={{ color: palette.text }}>
                {person.label}: {person.name}
                {(person.yellows > 0 || person.reds > 0) && (
                  <span className="ml-2 inline-flex items-center gap-1">
                    {person.yellows > 0 && <span className="rounded bg-amber-400/90 px-1 text-[10px] font-bold text-amber-950">TA {person.yellows}</span>}
                    {person.reds > 0 && <span className="rounded bg-rose-600/95 px-1 text-[10px] font-bold text-rose-50">TR {person.reds}</span>}
                  </span>
                )}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export const ClientPortal = ({ clientId }: ClientPortalProps) => {
  const [leagues, setLeagues] = useState<PublicLeagueSummary[]>([])
  const [selectedLeagueId, setSelectedLeagueId] = useState('')
  const [selectedCategoryId, setSelectedCategoryId] = useState('')
  const [selectedRound, setSelectedRound] = useState<number>(1)
  const [selectedMatchId, setSelectedMatchId] = useState('')
  const [fixturePayload, setFixturePayload] = useState<PublicFixturePayload | null>(null)
  const [liveMatch, setLiveMatch] = useState<LiveMatch | null>(null)
  const [homeLogoPalette, setHomeLogoPalette] = useState<{ logoUrl: string; palette: TeamPalette | null } | null>(null)
  const [awayLogoPalette, setAwayLogoPalette] = useState<{ logoUrl: string; palette: TeamPalette | null } | null>(null)
  const [clockNowMs, setClockNowMs] = useState(() => Date.now())
  const [liveSnapshotCapturedAt, setLiveSnapshotCapturedAt] = useState(() => Date.now())
  const [recentEventIds, setRecentEventIds] = useState<string[]>([])
  const [goalAlertActive, setGoalAlertActive] = useState(false)
  const [penaltyMissAlertActive, setPenaltyMissAlertActive] = useState(false)
  const [showMvpPopup, setShowMvpPopup] = useState(false)
  const [publicStatsTab, setPublicStatsTab] = useState<ClientStatsTab>('matches')
  const [publicStandingsSearchTerm, setPublicStandingsSearchTerm] = useState('')
  const [publicStandingsPage, setPublicStandingsPage] = useState(1)
  const [publicRankingSearchTerm, setPublicRankingSearchTerm] = useState('')
  const [publicRankingPage, setPublicRankingPage] = useState(1)
  const [publicKeepersSearchTerm, setPublicKeepersSearchTerm] = useState('')
  const [publicKeepersPage, setPublicKeepersPage] = useState(1)
  const [publicEngagement, setPublicEngagement] = useState<PublicEngagementState>(() => ({
    visits: 0,
    likes: 0,
    likedByCurrentUser: readPublicLikePreference(clientId),
  }))
  const [visitorAliasDraft, setVisitorAliasDraft] = useState('')
  const [visitorAlias, setVisitorAlias] = useState(() => {
    if (typeof window === 'undefined') return ''
    return window.localStorage.getItem(getPublicAliasStorageKey(clientId)) ?? ''
  })
  const [matchLikeState, setMatchLikeState] = useState<PublicMatchLikeState>({ likes: 0, likedByCurrentUser: false })
  const [updatingMatchLike, setUpdatingMatchLike] = useState(false)
  const [updatingLike, setUpdatingLike] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return false
    return window.Notification.permission === 'granted'
  })
  const [goalSoundEnabled, setGoalSoundEnabled] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('@fl_goal_sound_enabled') === '1'
  })
  const [initialLiveStartersByMatch, setInitialLiveStartersByMatch] = useState<
    Record<string, { home: string[]; away: string[] }>
  >({})
  const previousEventIdsRef = useRef<string[]>([])
  const mvpPopupShownMatchIdsRef = useRef<Set<string>>(new Set())
  const [loadingLeagues, setLoadingLeagues] = useState(true)
  const [loadingFixture, setLoadingFixture] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    let disposed = false

    const run = async () => {
      setLoadingLeagues(true)
      setErrorMessage('')
      const response = await apiService.getPublicClientLeagues(clientId)
      if (!response.ok) {
        if (!disposed) {
          setErrorMessage(response.message)
          setLeagues([])
          setLoadingLeagues(false)
        }
        return
      }

      if (disposed) return
      setLeagues(response.data)
      const firstLeague = response.data[0]
      setSelectedLeagueId(firstLeague?.id ?? '')
      setSelectedCategoryId(firstLeague?.categories[0]?.id ?? '')
      setLoadingLeagues(false)
    }

    void run()
    return () => {
      disposed = true
    }
  }, [clientId])

  const selectedLeague = useMemo(
    () => leagues.find((league) => league.id === selectedLeagueId) ?? null,
    [leagues, selectedLeagueId],
  )

  const availableCategories = selectedLeague?.categories ?? []
  const activeCategoryId =
    selectedCategoryId && availableCategories.some((category) => category.id === selectedCategoryId)
      ? selectedCategoryId
      : (availableCategories[0]?.id ?? '')

  useEffect(() => {
    setVisitorAliasDraft(visitorAlias)
  }, [visitorAlias])

  useEffect(() => {
    let disposed = false

    const run = async () => {
      const likedByCurrentUser = readPublicLikePreference(clientId)

      const baseResponse = await apiService.getPublicClientEngagement(clientId)
      if (baseResponse.ok && !disposed) {
        setPublicEngagement({
          visits: baseResponse.data.visits,
          likes: baseResponse.data.likes,
          likedByCurrentUser,
        })
      }

      if (typeof window === 'undefined') return
      const visitSessionKey = getPublicVisitSessionKey(clientId)
      if (window.sessionStorage.getItem(visitSessionKey)) return

      const visitResponse = await apiService.updatePublicClientEngagement(clientId, { action: 'visit' })
      if (visitResponse.ok && !disposed) {
        setPublicEngagement((current) => ({
          visits: visitResponse.data.visits,
          likes: visitResponse.data.likes,
          likedByCurrentUser: current.likedByCurrentUser,
        }))
      }
      window.sessionStorage.setItem(visitSessionKey, '1')
    }

    void run()
    return () => {
      disposed = true
    }
  }, [clientId])

  const handleToggleLike = useCallback(async () => {
    if (updatingLike) return

    const previousLiked = publicEngagement.likedByCurrentUser
    const nextLiked = !previousLiked
    persistPublicLikePreference(clientId, nextLiked)

    setPublicEngagement((current) => ({
      visits: current.visits,
      likes: nextLiked ? current.likes + 1 : Math.max(0, current.likes - 1),
      likedByCurrentUser: nextLiked,
    }))

    setUpdatingLike(true)
    const response = await apiService.updatePublicClientEngagement(clientId, {
      action: 'like',
      delta: nextLiked ? 1 : -1,
    })

    if (response.ok) {
      setPublicEngagement({
        visits: response.data.visits,
        likes: response.data.likes,
        likedByCurrentUser: nextLiked,
      })
    } else {
      persistPublicLikePreference(clientId, previousLiked)
      setPublicEngagement((current) => ({
        visits: current.visits,
        likes: previousLiked ? current.likes + 1 : Math.max(0, current.likes - 1),
        likedByCurrentUser: previousLiked,
      }))
    }

    setUpdatingLike(false)
  }, [clientId, publicEngagement.likedByCurrentUser, updatingLike])

  const handleShareWhatsApp = useCallback(() => {
    if (typeof window === 'undefined') return

    const shareUrl = window.location.href
    const leagueName = selectedLeague?.name ?? 'FL Liga'
    const message = `⚽ Mira los partidos en vivo y resultados de ${leagueName}: ${shareUrl}`
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`
    window.open(whatsappUrl, '_blank', 'noopener,noreferrer')
  }, [selectedLeague?.name])

  const handleSaveAlias = useCallback(() => {
    if (typeof window === 'undefined') return
    const normalized = visitorAliasDraft.trim()
    setVisitorAlias(normalized)
    window.localStorage.setItem(getPublicAliasStorageKey(clientId), normalized)
  }, [clientId, visitorAliasDraft])

  const handleContinueAnonymous = useCallback(() => {
    if (typeof window === 'undefined') return
    setVisitorAlias('')
    setVisitorAliasDraft('')
    window.localStorage.setItem(getPublicAliasStorageKey(clientId), '')
  }, [clientId])

  useEffect(() => {
    let disposed = false

    const run = async () => {
      if (!selectedLeague || !activeCategoryId) {
        setFixturePayload(null)
        return
      }

      setLoadingFixture(true)
      setErrorMessage('')
      const response = await apiService.getPublicClientLeagueFixture(clientId, selectedLeague.id, activeCategoryId)
      if (!response.ok) {
        if (!disposed) {
          setFixturePayload(null)
          setErrorMessage(response.message)
          setLoadingFixture(false)
        }
        return
      }

      if (disposed) return
      setFixturePayload(response.data)
      const firstRound = response.data.fixture.rounds[0]?.round ?? 1
      setSelectedRound(firstRound)
      setSelectedMatchId('')
      setLoadingFixture(false)
    }

    void run()
    return () => {
      disposed = true
    }
  }, [activeCategoryId, clientId, selectedLeague])

  const refreshFixture = useCallback(async () => {
    if (!selectedLeague || !activeCategoryId) return

    const response = await apiService.getPublicClientLeagueFixture(clientId, selectedLeague.id, activeCategoryId)
    if (!response.ok) return

    setFixturePayload(response.data)
  }, [activeCategoryId, clientId, selectedLeague])

  useEffect(() => {
    const fetchLive = async () => {
      const response = await apiService.getLiveMatch()
      if (response.ok) {
        setLiveMatch(response.data)
        setLiveSnapshotCapturedAt(Date.now())
      }
    }

    void fetchLive()
    const socket = io(apiBaseUrl, {
      transports: ['websocket'],
    })

    socket.on('live:update', (snapshot: LiveMatch) => {
      setLiveMatch(snapshot)
      setLiveSnapshotCapturedAt(Date.now())
    })

    const timer = window.setInterval(() => {
      void fetchLive()
    }, 15000)

    return () => {
      window.clearInterval(timer)
      socket.disconnect()
    }
  }, [])

  const teamMap = useMemo(() => {
    const map = new Map<string, PublicTeam>()
    fixturePayload?.teams.forEach((team) => map.set(team.id, team))
    return map
  }, [fixturePayload])

  const scheduledMatches = useMemo<ScheduledMatch[]>(() => {
    if (!fixturePayload) return []

    const generatedByRound = new Map<number, ScheduledMatch[]>()
    const scheduleByRound = new Map<number, ScheduledMatch[]>()
    const generatedMap = new Map<string, ScheduledMatch>()

    fixturePayload.fixture.rounds.forEach((round) => {
      const roundItems: ScheduledMatch[] = []
      round.matches.forEach((match, index) => {
        if (match.hasBye || !match.awayTeamId) return
        const generatedId = `${round.round}-${index}-${match.homeTeamId}-${match.awayTeamId}`
        const generatedItem: ScheduledMatch = {
          id: generatedId,
          round: round.round,
          homeTeamId: match.homeTeamId,
          awayTeamId: match.awayTeamId,
          played: fixturePayload.playedMatchIds.includes(generatedId),
        }

        roundItems.push(generatedItem)
        generatedMap.set(generatedId, generatedItem)
      })
      generatedByRound.set(round.round, roundItems)
    })

    fixturePayload.schedule.forEach((entry) => {
      if (generatedMap.has(entry.matchId)) {
        const generated = generatedMap.get(entry.matchId)
        if (!generated) return

        const roundItems = scheduleByRound.get(entry.round) ?? []
        roundItems.push({
          ...generated,
          ...(entry.scheduledAt ? { scheduledAt: entry.scheduledAt } : {}),
          ...(entry.venue ? { venue: entry.venue } : {}),
          played: fixturePayload.playedMatchIds.includes(entry.matchId),
        })
        scheduleByRound.set(entry.round, roundItems)
        return
      }

      const manual = parseManualMatchId(entry.matchId, entry.round)
      if (!manual) return

      const roundItems = scheduleByRound.get(entry.round) ?? []
      roundItems.push({
        id: entry.matchId,
        round: entry.round,
        homeTeamId: manual.homeTeamId,
        awayTeamId: manual.awayTeamId,
        scheduledAt: entry.scheduledAt,
        ...(entry.venue ? { venue: entry.venue } : {}),
        played: fixturePayload.playedMatchIds.includes(entry.matchId),
      })
      scheduleByRound.set(entry.round, roundItems)
    })

    const next: ScheduledMatch[] = []
    const rounds = fixturePayload.fixture.rounds.map((round) => round.round)
    rounds.forEach((roundNumber) => {
      const scheduledRound = scheduleByRound.get(roundNumber)
      if (scheduledRound && scheduledRound.length > 0) {
        next.push(...scheduledRound)
        return
      }

      const generatedRound = generatedByRound.get(roundNumber) ?? []
      next.push(...generatedRound)
    })

    return next.sort((left, right) => {
      if (left.round !== right.round) return left.round - right.round
      const leftTime = left.scheduledAt ? new Date(left.scheduledAt).getTime() : Number.POSITIVE_INFINITY
      const rightTime = right.scheduledAt ? new Date(right.scheduledAt).getTime() : Number.POSITIVE_INFINITY
      return leftTime - rightTime
    })
  }, [fixturePayload])

  const availableRounds = useMemo(() => {
    if (!fixturePayload) return [] as number[]
    return fixturePayload.fixture.rounds.map((round) => round.round)
  }, [fixturePayload])

  const matchesByRound = useMemo(
    () => scheduledMatches.filter((match) => match.round === selectedRound),
    [scheduledMatches, selectedRound],
  )

  const selectedRoundAward = useMemo(() => {
    if (!fixturePayload) return null

    const entry = fixturePayload.roundAwards.find((item) => item.round === selectedRound)
    if (!entry?.roundBestPlayerId || !entry.roundBestPlayerName) return null

    const team = entry.roundBestPlayerTeamId
      ? fixturePayload.teams.find((item) => item.id === entry.roundBestPlayerTeamId)
      : null
    const rosterPlayer = team?.players.find((player) => player.id === entry.roundBestPlayerId)

    return {
      id: entry.roundBestPlayerId,
      name: entry.roundBestPlayerName,
      teamName: entry.roundBestPlayerTeamName ?? team?.name ?? 'Equipo',
      photoUrl: entry.roundBestPlayerPhotoUrl ?? rosterPlayer?.photoUrl,
      round: entry.round,
    }
  }, [fixturePayload, selectedRound])

  const awardBurstColor = useMemo(() => {
    const themeColor = fixturePayload?.league.themeColor ?? selectedLeague?.themeColor
    return themeColor ? withAlpha(themeColor, 0.82) : 'rgba(251, 191, 36, 0.8)'
  }, [fixturePayload?.league.themeColor, selectedLeague?.themeColor])

  const playedMatchById = useMemo(() => {
    const map = new Map<string, PublicFixturePayload['playedMatches'][number]>()
    fixturePayload?.playedMatches.forEach((match) => map.set(match.matchId, match))
    return map
  }, [fixturePayload?.playedMatches])

  const publicTeamsByNormalizedName = useMemo(() => {
    const map = new Map<string, PublicTeam>()
    fixturePayload?.teams.forEach((team) => {
      map.set(normalizeLabel(team.name), team)
    })
    return map
  }, [fixturePayload?.teams])

  const publicStandings = useMemo(() => {
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
        avgGc: number
      }
    >()

    const ensure = (teamId: string, teamName: string, teamLogoUrl?: string) => {
      const existing = table.get(teamId)
      if (existing) return existing
      const created = {
        teamId,
        teamName,
        teamLogoUrl,
        pj: 0,
        pg: 0,
        pe: 0,
        pp: 0,
        gf: 0,
        gc: 0,
        dg: 0,
        pts: 0,
        avgGc: 0,
      }
      table.set(teamId, created)
      return created
    }

    ;(fixturePayload?.teams ?? []).forEach((team) => ensure(team.id, team.name, team.logoUrl))

    ;(fixturePayload?.playedMatches ?? []).forEach((record) => {
      const homeTeam = publicTeamsByNormalizedName.get(normalizeLabel(record.homeTeamName))
      const awayTeam = publicTeamsByNormalizedName.get(normalizeLabel(record.awayTeamName))

      const home = ensure(homeTeam?.id ?? `home-${normalizeLabel(record.homeTeamName)}`, record.homeTeamName, homeTeam?.logoUrl)
      const away = ensure(awayTeam?.id ?? `away-${normalizeLabel(record.awayTeamName)}`, record.awayTeamName, awayTeam?.logoUrl)

      home.pj += 1
      away.pj += 1
      home.gf += record.homeGoals
      home.gc += record.awayGoals
      away.gf += record.awayGoals
      away.gc += record.homeGoals

      if (record.homeGoals > record.awayGoals) {
        home.pg += 1
        home.pts += 3
        away.pp += 1
      } else if (record.homeGoals < record.awayGoals) {
        away.pg += 1
        away.pts += 3
        home.pp += 1
      } else {
        home.pe += 1
        away.pe += 1
        home.pts += 1
        away.pts += 1
      }
    })

    return Array.from(table.values())
      .map((item) => ({
        ...item,
        dg: item.gf - item.gc,
        avgGc: item.pj > 0 ? item.gc / item.pj : 0,
      }))
      .sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf || a.teamName.localeCompare(b.teamName, 'es', { sensitivity: 'base' }))
  }, [fixturePayload?.playedMatches, fixturePayload?.teams, publicTeamsByNormalizedName])

  const publicRankings = useMemo(() => {
    type Item = {
      key: string
      playerName: string
      teamName: string
      teamLogoUrl?: string
      value: number
    }

    const goals = new Map<string, Item>()
    const assists = new Map<string, Item>()
    const yellows = new Map<string, Item>()
    const reds = new Map<string, Item>()

    const ensure = (map: Map<string, Item>, playerName: string, teamName: string, teamLogoUrl?: string) => {
      const key = `${normalizeLabel(teamName)}::${normalizeLabel(playerName)}`
      const existing = map.get(key)
      if (existing) return existing
      const created = {
        key,
        playerName,
        teamName,
        teamLogoUrl,
        value: 0,
      }
      map.set(key, created)
      return created
    }

    ;(fixturePayload?.playedMatches ?? []).forEach((record) => {
      record.events.forEach((event) => {
        const team = publicTeamsByNormalizedName.get(normalizeLabel(event.teamName))
        const logoUrl = team?.logoUrl

        if (event.type === 'goal' || event.type === 'penalty_goal') {
          ensure(goals, event.playerName, event.teamName, logoUrl).value += 1
        }
        if (event.type === 'assist') {
          ensure(assists, event.playerName, event.teamName, logoUrl).value += 1
        }
        if (event.type === 'yellow' || event.type === 'double_yellow') {
          ensure(yellows, event.playerName, event.teamName, logoUrl).value += 1
        }
        if (event.type === 'red' || event.type === 'double_yellow') {
          ensure(reds, event.playerName, event.teamName, logoUrl).value += 1
        }
      })
    })

    const toSorted = (map: Map<string, Item>) =>
      Array.from(map.values())
        .filter((item) => item.value > 0)
        .sort(
          (a, b) =>
            b.value - a.value
            || a.playerName.localeCompare(b.playerName, 'es', { sensitivity: 'base' })
            || a.teamName.localeCompare(b.teamName, 'es', { sensitivity: 'base' }),
        )

    return {
      scorers: toSorted(goals),
      assists: toSorted(assists),
      yellows: toSorted(yellows),
      reds: toSorted(reds),
    }
  }, [fixturePayload?.playedMatches, publicTeamsByNormalizedName])

  const publicKeepers = useMemo(() => {
    return publicStandings
      .filter((item) => item.pj > 0)
      .map((item) => ({
        teamId: item.teamId,
        teamName: item.teamName,
        teamLogoUrl: item.teamLogoUrl,
        gc: item.gc,
        pj: item.pj,
        avgGc: item.avgGc,
      }))
      .sort((a, b) => a.avgGc - b.avgGc || a.gc - b.gc || a.teamName.localeCompare(b.teamName, 'es', { sensitivity: 'base' }))
  }, [publicStandings])

  const publicActiveRanking = useMemo(() => {
    if (publicStatsTab === 'scorers') {
      return {
        title: 'Tabla de goleadoras',
        unit: 'gol',
        items: publicRankings.scorers,
      }
    }
    if (publicStatsTab === 'assists') {
      return {
        title: 'Tabla de asistidoras',
        unit: 'asist',
        items: publicRankings.assists,
      }
    }
    if (publicStatsTab === 'yellows') {
      return {
        title: 'Tabla TA',
        unit: 'TA',
        items: publicRankings.yellows,
      }
    }
    if (publicStatsTab === 'reds') {
      return {
        title: 'Tabla TR',
        unit: 'TR',
        items: publicRankings.reds,
      }
    }

    return null
  }, [publicRankings.assists, publicRankings.reds, publicRankings.scorers, publicRankings.yellows, publicStatsTab])

  const paginatePublicItems = useCallback(<T,>(items: T[], page: number) => {
    const pageSize = 10
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
    const currentPage = Math.min(Math.max(page, 1), totalPages)
    const offset = (currentPage - 1) * pageSize

    return {
      totalItems: items.length,
      totalPages,
      currentPage,
      pageItems: items.slice(offset, offset + pageSize),
    }
  }, [])

  const filteredPublicStandings = useMemo(() => {
    const query = publicStandingsSearchTerm.trim().toLowerCase()
    if (!query) return publicStandings
    return publicStandings.filter((item) => item.teamName.toLowerCase().includes(query))
  }, [publicStandings, publicStandingsSearchTerm])

  const filteredPublicRanking = useMemo(() => {
    if (!publicActiveRanking) return []
    const query = publicRankingSearchTerm.trim().toLowerCase()
    if (!query) return publicActiveRanking.items
    return publicActiveRanking.items.filter((item) => `${item.playerName} ${item.teamName}`.toLowerCase().includes(query))
  }, [publicActiveRanking, publicRankingSearchTerm])

  const filteredPublicKeepers = useMemo(() => {
    const query = publicKeepersSearchTerm.trim().toLowerCase()
    if (!query) return publicKeepers
    return publicKeepers.filter((item) => item.teamName.toLowerCase().includes(query))
  }, [publicKeepers, publicKeepersSearchTerm])

  const publicStandingsPagination = useMemo(
    () => paginatePublicItems(filteredPublicStandings, publicStandingsPage),
    [filteredPublicStandings, paginatePublicItems, publicStandingsPage],
  )

  const publicRankingPagination = useMemo(
    () => paginatePublicItems(filteredPublicRanking, publicRankingPage),
    [filteredPublicRanking, paginatePublicItems, publicRankingPage],
  )

  const publicKeepersPagination = useMemo(
    () => paginatePublicItems(filteredPublicKeepers, publicKeepersPage),
    [filteredPublicKeepers, paginatePublicItems, publicKeepersPage],
  )

  const resolvePlayedHistory = useCallback((match: ScheduledMatch) => {
    const direct = playedMatchById.get(match.id)
    if (direct) {
      return {
        record: direct,
        reverse: false,
      }
    }

    const homeName = teamMap.get(match.homeTeamId)?.name
    const awayName = teamMap.get(match.awayTeamId)?.name
    if (!homeName || !awayName) return null

    const normalizedHome = normalizeLabel(homeName)
    const normalizedAway = normalizeLabel(awayName)

    const byNames = fixturePayload?.playedMatches.find((item) => {
      if (item.round !== match.round) return false
      const itemHome = normalizeLabel(item.homeTeamName)
      const itemAway = normalizeLabel(item.awayTeamName)
      return itemHome === normalizedHome && itemAway === normalizedAway
    })

    if (byNames) {
      return {
        record: byNames,
        reverse: false,
      }
    }

    const reversed = fixturePayload?.playedMatches.find((item) => {
      if (item.round !== match.round) return false
      const itemHome = normalizeLabel(item.homeTeamName)
      const itemAway = normalizeLabel(item.awayTeamName)
      return itemHome === normalizedAway && itemAway === normalizedHome
    })

    if (reversed) {
      return {
        record: reversed,
        reverse: true,
      }
    }

    return null
  }, [fixturePayload?.playedMatches, playedMatchById, teamMap])

  const selectedMatch = useMemo(
    () => scheduledMatches.find((match) => match.id === selectedMatchId) ?? null,
    [scheduledMatches, selectedMatchId],
  )

  const selectedMatchHistory = useMemo(() => {
    if (!selectedMatch) return null
    return resolvePlayedHistory(selectedMatch)
  }, [selectedMatch, resolvePlayedHistory])

  useEffect(() => {
    let disposed = false

    const run = async () => {
      if (!selectedMatch || !fixturePayload) {
        setMatchLikeState({ likes: 0, likedByCurrentUser: false })
        return
      }

      const likedByCurrentUser =
        typeof window !== 'undefined' &&
        window.localStorage.getItem(getPublicMatchLikeStorageKey(clientId, selectedMatch.id)) === '1'

      const response = await apiService.getPublicMatchEngagement(
        clientId,
        fixturePayload.league.id,
        fixturePayload.category.id,
        selectedMatch.id,
      )
      if (!disposed && response.ok) {
        setMatchLikeState({
          likes: response.data.likes,
          likedByCurrentUser,
        })
      }
    }

    void run()
    return () => {
      disposed = true
    }
  }, [clientId, fixturePayload, selectedMatch])

  const handleToggleMatchLike = useCallback(async () => {
    if (!selectedMatch || !fixturePayload || updatingMatchLike) return

    const storageKey = getPublicMatchLikeStorageKey(clientId, selectedMatch.id)
    const previousLiked = matchLikeState.likedByCurrentUser
    const nextLiked = !previousLiked

    if (nextLiked && typeof window !== 'undefined' && 'Notification' in window && window.Notification.permission === 'default') {
      try {
        const permission = await window.Notification.requestPermission()
        setNotificationsEnabled(permission === 'granted')
      } catch {
        setNotificationsEnabled(false)
      }
    } else if (typeof window !== 'undefined' && 'Notification' in window) {
      setNotificationsEnabled(window.Notification.permission === 'granted')
    }

    if (typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey, nextLiked ? '1' : '0')
    }

    setMatchLikeState((current) => ({
      likes: nextLiked ? current.likes + 1 : Math.max(0, current.likes - 1),
      likedByCurrentUser: nextLiked,
    }))

    setUpdatingMatchLike(true)
    const response = await apiService.updatePublicMatchEngagement(clientId, selectedMatch.id, {
      leagueId: fixturePayload.league.id,
      categoryId: fixturePayload.category.id,
      delta: nextLiked ? 1 : -1,
    })

    if (response.ok) {
      setMatchLikeState({
        likes: response.data.likes,
        likedByCurrentUser: nextLiked,
      })
    } else {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(storageKey, previousLiked ? '1' : '0')
      }
      setMatchLikeState((current) => ({
        likes: previousLiked ? current.likes + 1 : Math.max(0, current.likes - 1),
        likedByCurrentUser: previousLiked,
      }))
    }

    setUpdatingMatchLike(false)
  }, [clientId, fixturePayload, matchLikeState.likedByCurrentUser, selectedMatch, updatingMatchLike])


  const selectedMatchMvp = useMemo(() => {
    const record = selectedMatchHistory?.record
    if (!record?.playerOfMatchName) return null

    return {
      id: record.playerOfMatchId ?? '',
      name: record.playerOfMatchName,
      photoUrl: record.playerOfMatchPhotoUrl,
      teamName: record.playerOfMatchTeamName,
    }
  }, [selectedMatchHistory])

  const liveForSelected = useMemo(() => {
    if (!selectedMatch || !liveMatch) return null

    const direct = liveMatch.homeTeam.id === selectedMatch.homeTeamId && liveMatch.awayTeam.id === selectedMatch.awayTeamId
    const reverse = liveMatch.homeTeam.id === selectedMatch.awayTeamId && liveMatch.awayTeam.id === selectedMatch.homeTeamId

    if (!direct && !reverse) return null

    if (direct) {
      return {
        homeTeam: liveMatch.homeTeam,
        awayTeam: liveMatch.awayTeam,
        events: liveMatch.events,
        status: liveMatch.status,
        minute: liveMatch.currentMinute,
        timer: liveMatch.timer,
      }
    }

    return {
      homeTeam: liveMatch.awayTeam,
      awayTeam: liveMatch.homeTeam,
      events: liveMatch.events,
      status: liveMatch.status,
      minute: liveMatch.currentMinute,
      timer: liveMatch.timer,
    }
  }, [liveMatch, selectedMatch])

  const liveSelectedStatus = liveForSelected?.status

  useEffect(() => {
    if (!selectedMatchId) {
      setInitialLiveStartersByMatch({})
    }
  }, [selectedMatchId])

  useEffect(() => {
    if (!selectedMatch || !liveForSelected) return
    if (liveForSelected.status === 'scheduled') {
      setInitialLiveStartersByMatch((current) => {
        if (!current[selectedMatch.id]) return current
        const next = { ...current }
        delete next[selectedMatch.id]
        return next
      })
      return
    }

    setInitialLiveStartersByMatch((current) => {
      if (current[selectedMatch.id]) return current
      return {
        ...current,
        [selectedMatch.id]: {
          home: [...liveForSelected.homeTeam.starters],
          away: [...liveForSelected.awayTeam.starters],
        },
      }
    })
  }, [liveForSelected, selectedMatch])

  useEffect(() => {
    if (!liveForSelected?.timer.running) return

    const interval = window.setInterval(() => {
      setClockNowMs(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(interval)
    }
  }, [liveForSelected?.timer.running])

  const liveElapsedSeconds = useMemo(() => {
    if (!liveForSelected) return 0

    if (!liveForSelected.timer.running) {
      return liveForSelected.timer.elapsedSeconds
    }

    const delta = Math.floor((clockNowMs - liveSnapshotCapturedAt) / 1000)
    return liveForSelected.timer.elapsedSeconds + Math.max(delta, 0)
  }, [clockNowMs, liveForSelected, liveSnapshotCapturedAt])

  const liveCurrentMinute = Math.floor(liveElapsedSeconds / 60)

  const liveClockLabel = `${String(liveCurrentMinute).padStart(2, '0')}:${String(liveElapsedSeconds % 60).padStart(2, '0')}`

  const playerEventIndicators = useMemo(() => {
    const map = new Map<string, {
      goals: number
      penaltyMisses: number
      yellows: number
      reds: number
      recentGoal: boolean
      recentPenaltyMiss: boolean
      recentYellow: boolean
      recentRed: boolean
    }>()
    const applyToPlayer = (playerId: string, eventType: LiveEvent['type'], isRecent: boolean) => {
      const current = map.get(playerId) ?? {
        goals: 0,
        penaltyMisses: 0,
        yellows: 0,
        reds: 0,
        recentGoal: false,
        recentPenaltyMiss: false,
        recentYellow: false,
        recentRed: false,
      }

      if (eventType === 'goal' || eventType === 'penalty_goal') {
        current.goals += 1
        if (isRecent) current.recentGoal = true
      }
      if (eventType === 'penalty_miss') {
        current.penaltyMisses += 1
        if (isRecent) current.recentPenaltyMiss = true
      }
      if (eventType === 'yellow') {
        current.yellows += 1
        if (isRecent) current.recentYellow = true
      }
      if (eventType === 'double_yellow') {
        current.yellows += 1
        current.reds += 1
        if (isRecent) {
          current.recentYellow = true
          current.recentRed = true
        }
      }
      if (eventType === 'red') {
        current.reds += 1
        if (isRecent) current.recentRed = true
      }

      map.set(playerId, current)
    }

    if (liveForSelected) {
      liveForSelected.events.forEach((event) => {
        if (!event.playerId) return
        const isRecent = liveElapsedSeconds - event.elapsedSeconds <= 18
        applyToPlayer(event.playerId, event.type, isRecent)
      })
      return map
    }

    if (selectedMatchHistory?.record && selectedMatch && fixturePayload) {
      const homeName = normalizeLabel(selectedMatchHistory.reverse ? selectedMatchHistory.record.awayTeamName : selectedMatchHistory.record.homeTeamName)
      const awayName = normalizeLabel(selectedMatchHistory.reverse ? selectedMatchHistory.record.homeTeamName : selectedMatchHistory.record.awayTeamName)
      const selectedHomeTeamRoster = fixturePayload.teams.find((team) => team.id === selectedMatch.homeTeamId)
      const selectedAwayTeamRoster = fixturePayload.teams.find((team) => team.id === selectedMatch.awayTeamId)

      const findPlayerIdByEvent = (teamName: string, playerName: string) => {
        const normalizedTeam = normalizeLabel(teamName)
        const normalizedPlayer = normalizeLabel(playerName)
        const teamPlayers = normalizedTeam === homeName
          ? (selectedHomeTeamRoster?.players ?? [])
          : normalizedTeam === awayName
            ? (selectedAwayTeamRoster?.players ?? [])
            : []
        if (teamPlayers.length === 0) return ''

        const player = teamPlayers.find((item) => normalizeLabel(item.name) === normalizedPlayer)
        return player?.id ?? ''
      }

      selectedMatchHistory.record.events.forEach((event) => {
        const playerId = findPlayerIdByEvent(event.teamName, event.playerName)
        if (!playerId) return
        applyToPlayer(playerId, event.type, false)
      })
    }

    return map
  }, [fixturePayload, liveElapsedSeconds, liveForSelected, selectedMatch, selectedMatchHistory])

  const scoreboard = useMemo(() => {
    if (liveForSelected) {
      const isBreak = liveForSelected.status === 'live' && !liveForSelected.timer.running && liveForSelected.timer.elapsedSeconds > 0
      return {
        homeGoals: liveForSelected.homeTeam.stats.goals,
        awayGoals: liveForSelected.awayTeam.stats.goals,
        minute: liveCurrentMinute,
        status: liveForSelected.status,
        clock: liveClockLabel,
        isBreak,
      }
    }

    if (selectedMatchHistory?.record) {
      const homeGoals = selectedMatchHistory.reverse ? selectedMatchHistory.record.awayGoals : selectedMatchHistory.record.homeGoals
      const awayGoals = selectedMatchHistory.reverse ? selectedMatchHistory.record.homeGoals : selectedMatchHistory.record.awayGoals
      const finalMinute = Math.max(0, selectedMatchHistory.record.finalMinute)
      return {
        homeGoals,
        awayGoals,
        minute: finalMinute,
        status: 'finished' as const,
        clock: `${String(finalMinute).padStart(2, '0')}:00`,
        isBreak: false,
      }
    }

    return null
  }, [liveClockLabel, liveCurrentMinute, liveForSelected, selectedMatchHistory])

  const selectedHomeTeam = selectedMatch ? teamMap.get(selectedMatch.homeTeamId) ?? null : null
  const selectedAwayTeam = selectedMatch ? teamMap.get(selectedMatch.awayTeamId) ?? null : null

  const homeFallbackPalette = useMemo(
    () => paletteFromName(selectedHomeTeam?.name ?? 'local'),
    [selectedHomeTeam?.name],
  )

  const awayFallbackPalette = useMemo(
    () => paletteFromName(selectedAwayTeam?.name ?? 'visitante'),
    [selectedAwayTeam?.name],
  )

  const homePalette =
    selectedHomeTeam?.logoUrl && homeLogoPalette?.logoUrl === selectedHomeTeam.logoUrl && homeLogoPalette.palette
      ? homeLogoPalette.palette
      : homeFallbackPalette

  const awayPalette =
    selectedAwayTeam?.logoUrl && awayLogoPalette?.logoUrl === selectedAwayTeam.logoUrl && awayLogoPalette.palette
      ? awayLogoPalette.palette
      : awayFallbackPalette

  useEffect(() => {
    let disposed = false
    const logoUrl = selectedHomeTeam?.logoUrl

    void extractLogoPalette(logoUrl).then((palette) => {
      if (!disposed) {
        setHomeLogoPalette(logoUrl ? { logoUrl, palette } : null)
      }
    })

    return () => {
      disposed = true
    }
  }, [selectedHomeTeam?.logoUrl])

  useEffect(() => {
    let disposed = false
    const logoUrl = selectedAwayTeam?.logoUrl

    void extractLogoPalette(logoUrl).then((palette) => {
      if (!disposed) {
        setAwayLogoPalette(logoUrl ? { logoUrl, palette } : null)
      }
    })

    return () => {
      disposed = true
    }
  }, [selectedAwayTeam?.logoUrl])

  const savedHomeLineup = selectedMatchHistory?.record
    ? (selectedMatchHistory.reverse ? selectedMatchHistory.record.awayLineup : selectedMatchHistory.record.homeLineup)
    : null

  const savedAwayLineup = selectedMatchHistory?.record
    ? (selectedMatchHistory.reverse ? selectedMatchHistory.record.homeLineup : selectedMatchHistory.record.awayLineup)
    : null

  const homeLineup = selectedMatch
    ? buildTeamFromLiveOrRoster(
        selectedMatch.homeTeamId,
        liveForSelected?.homeTeam ?? null,
        selectedHomeTeam,
        savedHomeLineup,
      )
    : null

  const awayLineup = selectedMatch
    ? buildTeamFromLiveOrRoster(
        selectedMatch.awayTeamId,
        liveForSelected?.awayTeam ?? null,
        selectedAwayTeam,
        savedAwayLineup,
      )
    : null

  const substitutionDataByTeam = useMemo(() => {
    const byTeam = new Map<string, {
      outPlayerIds: Set<string>
      inPlayerIds: Set<string>
      timeline: Array<{ id: string; minute: number; clock: string; outPlayerId: string; inPlayerId?: string }>
    }>()

    const ensure = (teamId: string) => {
      const current = byTeam.get(teamId)
      if (current) return current
      const next = {
        outPlayerIds: new Set<string>(),
        inPlayerIds: new Set<string>(),
        timeline: [] as Array<{ id: string; minute: number; clock: string; outPlayerId: string; inPlayerId?: string }>,
      }
      byTeam.set(teamId, next)
      return next
    }

    if (!selectedMatch || !homeLineup || !awayLineup) return byTeam

    const initialFromSavedHome = savedHomeLineup?.starters ?? []
    const initialFromSavedAway = savedAwayLineup?.starters ?? []
    const capturedInitial = initialLiveStartersByMatch[selectedMatch.id]

    const initialHomeStarters = capturedInitial?.home ?? initialFromSavedHome
    const initialAwayStarters = capturedInitial?.away ?? initialFromSavedAway

    const homeEntry = ensure(homeLineup.id)
    const awayEntry = ensure(awayLineup.id)

    homeLineup.starters.forEach((player) => {
      if (!initialHomeStarters.includes(player.id)) {
        homeEntry.inPlayerIds.add(player.id)
      }
    })

    awayLineup.starters.forEach((player) => {
      if (!initialAwayStarters.includes(player.id)) {
        awayEntry.inPlayerIds.add(player.id)
      }
    })

    if (liveForSelected) {
      liveForSelected.events
        .filter((event) => event.type === 'substitution' && event.playerId)
        .slice()
        .reverse()
        .forEach((event) => {
          if (!event.playerId) return
          const teamEntry = ensure(event.teamId)
          teamEntry.outPlayerIds.add(event.playerId)
          teamEntry.timeline.push({
            id: event.id,
            minute: event.minute,
            clock: event.clock,
            outPlayerId: event.playerId,
            ...(event.substitutionInPlayerId ? { inPlayerId: event.substitutionInPlayerId } : {}),
          })
          if (event.substitutionInPlayerId) {
            teamEntry.inPlayerIds.add(event.substitutionInPlayerId)
          }
        })
    }

    if (!liveForSelected && selectedMatchHistory?.record) {
      const homeName = normalizeLabel(selectedMatchHistory.reverse ? selectedMatchHistory.record.awayTeamName : selectedMatchHistory.record.homeTeamName)
      const awayName = normalizeLabel(selectedMatchHistory.reverse ? selectedMatchHistory.record.homeTeamName : selectedMatchHistory.record.awayTeamName)

      const findInLineup = (lineup: typeof homeLineup, playerName: string) => {
        if (!lineup) return ''
        const normalizedPlayer = normalizeLabel(playerName)
        const player = lineup.allPlayers.find((item) => normalizeLabel(item.name) === normalizedPlayer)
        return player?.id ?? ''
      }

      const parseMinute = (clock: string) => {
        const raw = Number(clock.split(':')[0] ?? '0')
        return Number.isFinite(raw) ? raw : 0
      }

      selectedMatchHistory.record.events
        .filter((event) => event.type === 'substitution')
        .forEach((event, index) => {
          const normalizedTeam = normalizeLabel(event.teamName)
          const isHomeTeam = normalizedTeam === homeName
          const lineup = isHomeTeam ? homeLineup : normalizedTeam === awayName ? awayLineup : null
          if (!lineup) return

          const outPlayerId = findInLineup(lineup, event.playerName)
          if (!outPlayerId) return
          const inPlayerId = event.substitutionInPlayerName ? findInLineup(lineup, event.substitutionInPlayerName) : ''

          const teamEntry = ensure(lineup.id)
          teamEntry.outPlayerIds.add(outPlayerId)
          if (inPlayerId) {
            teamEntry.inPlayerIds.add(inPlayerId)
          }
          teamEntry.timeline.push({
            id: `history-sub-${selectedMatchHistory.record.matchId}-${index}`,
            minute: parseMinute(event.clock),
            clock: event.clock,
            outPlayerId,
            ...(inPlayerId ? { inPlayerId } : {}),
          })
        })
    }

    return byTeam
  }, [
    awayLineup,
    homeLineup,
    initialLiveStartersByMatch,
    liveForSelected,
    savedAwayLineup?.starters,
    savedHomeLineup?.starters,
    selectedMatchHistory,
    selectedMatch,
  ])

  const homeSubstitutionData = useMemo(
    () => substitutionDataByTeam.get(homeLineup?.id ?? '') ?? { outPlayerIds: new Set<string>(), inPlayerIds: new Set<string>(), timeline: [] as Array<{ id: string; minute: number; clock: string; outPlayerId: string; inPlayerId?: string }> },
    [homeLineup?.id, substitutionDataByTeam],
  )

  const awaySubstitutionData = useMemo(
    () => substitutionDataByTeam.get(awayLineup?.id ?? '') ?? { outPlayerIds: new Set<string>(), inPlayerIds: new Set<string>(), timeline: [] as Array<{ id: string; minute: number; clock: string; outPlayerId: string; inPlayerId?: string }> },
    [awayLineup?.id, substitutionDataByTeam],
  )

  const homeBenchVisibleIds = useMemo(() => {
    if (!homeLineup) return [] as string[]
    const visible = new Set<string>([
      ...homeLineup.substitutes.map((player) => player.id),
      ...Array.from(homeSubstitutionData.inPlayerIds),
    ])
    return homeLineup.allPlayers.map((player) => player.id).filter((playerId) => visible.has(playerId))
  }, [homeLineup, homeSubstitutionData.inPlayerIds])

  const awayBenchVisibleIds = useMemo(() => {
    if (!awayLineup) return [] as string[]
    const visible = new Set<string>([
      ...awayLineup.substitutes.map((player) => player.id),
      ...Array.from(awaySubstitutionData.inPlayerIds),
    ])
    return awayLineup.allPlayers.map((player) => player.id).filter((playerId) => visible.has(playerId))
  }, [awayLineup, awaySubstitutionData.inPlayerIds])

  const events = useMemo(() => {
    if (!selectedMatch) return [] as Array<{ id: string; label: string; isHomeTeamEvent: boolean; type: LiveEvent['type'] }>

    if (liveForSelected) {
      return liveForSelected.events
        .slice()
        .reverse()
        .map((event) => {
          const isHome = event.teamId === liveForSelected.homeTeam.id
          const team = isHome ? liveForSelected.homeTeam : liveForSelected.awayTeam
          const actorName = event.staffRole
            ? `${staffRoleLabel(event.staffRole)} ${team.technicalStaff?.[event.staffRole]?.name ?? 'Sin registrar'}`
            : event.playerId
              ? (() => {
                const outName = team.players.find((item) => item.id === event.playerId)?.name ?? 'Sin jugador'
                if (event.type !== 'substitution') return outName
                const inName = event.substitutionInPlayerId
                  ? (team.players.find((item) => item.id === event.substitutionInPlayerId)?.name ?? 'Sin jugador')
                  : ''
                return inName ? `${outName} ↘ · ${inName} ↗` : `${outName} ↘`
              })()
              : 'Sin jugador'
          return {
            id: event.id,
            label: `${event.clock} · ${eventLabel[event.type]} · ${team.name} · ${actorName}`,
            isHomeTeamEvent: isHome,
            type: event.type,
          }
        })
    }

    if (!selectedMatchHistory?.record) return []

    const homeName = selectedMatchHistory.reverse ? selectedMatchHistory.record.awayTeamName : selectedMatchHistory.record.homeTeamName
    return selectedMatchHistory.record.events
      .slice()
      .reverse()
      .map((event, index) => ({
        id: `history-${selectedMatch.id}-${index}`,
        label: `${event.clock} · ${eventLabel[event.type]} · ${event.teamName} · ${event.playerName}`,
        isHomeTeamEvent: normalizeLabel(event.teamName) === normalizeLabel(homeName),
        type: event.type,
      }))
  }, [liveForSelected, selectedMatch, selectedMatchHistory])

  const goalTimelineRows = useMemo(() => {
    if (liveForSelected) {
      return liveForSelected.events
        .slice()
        .reverse()
        .filter((event) => event.type === 'goal' || event.type === 'penalty_goal')
        .map((event) => {
          const isHomeTeam = event.teamId === liveForSelected.homeTeam.id
          const team = isHomeTeam ? liveForSelected.homeTeam : liveForSelected.awayTeam
          const playerName = event.playerId
            ? (team.players.find((player) => player.id === event.playerId)?.name ?? 'Sin jugadora')
            : 'Sin jugadora'

          return {
            id: `goal-live-${event.id}`,
            minute: `${event.minute}'`,
            clock: event.clock,
            teamName: team.name,
            playerName,
            isPenalty: event.type === 'penalty_goal',
            isHomeTeam,
          }
        })
    }

    if (!selectedMatchHistory?.record) return [] as Array<{
      id: string
      minute: string
      clock: string
      teamName: string
      playerName: string
      isPenalty: boolean
      isHomeTeam: boolean
    }>

    const homeName = selectedMatchHistory.reverse ? selectedMatchHistory.record.awayTeamName : selectedMatchHistory.record.homeTeamName

    return selectedMatchHistory.record.events
      .filter((event) => event.type === 'goal' || event.type === 'penalty_goal')
      .map((event, index) => {
        const parsedMinute = Number(event.clock.split(':')[0] ?? '0')
        const minute = Number.isFinite(parsedMinute) ? `${parsedMinute}'` : '0\''

        return {
          id: `goal-history-${selectedMatchHistory.record.matchId}-${index}`,
          minute,
          clock: event.clock,
          teamName: event.teamName,
          playerName: event.playerName,
          isPenalty: event.type === 'penalty_goal',
          isHomeTeam: normalizeLabel(event.teamName) === normalizeLabel(homeName),
        }
      })
  }, [liveForSelected, selectedMatchHistory])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('@fl_goal_sound_enabled', goalSoundEnabled ? '1' : '0')
  }, [goalSoundEnabled])

  useEffect(() => {
    const currentIds = events.map((event) => event.id)
    const previousSet = new Set(previousEventIdsRef.current)
    const incomingIds = currentIds.filter((id) => !previousSet.has(id))
    const hasPrevious = previousEventIdsRef.current.length > 0
    const incomingEvents = events.filter((event) => incomingIds.includes(event.id))
    const hasIncomingGoal = incomingEvents.some((event) => event.type === 'goal' || event.type === 'penalty_goal')
    const incomingGoalEvents = incomingEvents.filter((event) => event.type === 'goal' || event.type === 'penalty_goal')
    const hasIncomingPenaltyMiss = incomingEvents.some((event) => event.type === 'penalty_miss')
    const highlightTypes = new Set<LiveEvent['type']>([
      'goal',
      'penalty_goal',
      'penalty_miss',
      'yellow',
      'red',
      'double_yellow',
      'staff_yellow',
      'staff_red',
    ])
    const highlightIncomingIds = incomingEvents
      .filter((event) => highlightTypes.has(event.type))
      .map((event) => event.id)

    if (incomingIds.length > 0) {
      if (highlightIncomingIds.length > 0) {
        setRecentEventIds((current) => Array.from(new Set([...current, ...highlightIncomingIds])))
      }

      const recentTimer = window.setTimeout(() => {
        setRecentEventIds((current) => current.filter((id) => !highlightIncomingIds.includes(id)))
      }, 1200)

      let goalTimer: number | null = null
      let penaltyMissTimer: number | null = null
      if (hasPrevious && hasIncomingGoal && liveForSelected?.status === 'live') {
        setGoalAlertActive(true)
        goalTimer = window.setTimeout(() => {
          setGoalAlertActive(false)
        }, 1700)

        if (goalSoundEnabled) {
          playGoalBeep()
        }

        if (
          matchLikeState.likedByCurrentUser
          && selectedMatch
          && typeof window !== 'undefined'
          && 'Notification' in window
          && window.Notification.permission === 'granted'
        ) {
          const lastGoalEvent = incomingGoalEvents[incomingGoalEvents.length - 1]
          const scoreText = liveForSelected ? `${liveForSelected.homeTeam.stats.goals} - ${liveForSelected.awayTeam.stats.goals}` : ''
          const title = `⚽ Gol en ${selectedMatch.id}`
          const body = lastGoalEvent
            ? `${lastGoalEvent.label}${scoreText ? ` · Marcador ${scoreText}` : ''}`
            : `Se registró un gol en el partido seguido${scoreText ? ` · ${scoreText}` : ''}`

          try {
            const notification = new window.Notification(title, {
              body,
              tag: `goal-${selectedMatch.id}`,
            })
            window.setTimeout(() => notification.close(), 7000)
          } catch {
            // Ignora fallos de notificación del navegador/dispositivo
          }
        }
      }

      if (hasPrevious && hasIncomingPenaltyMiss && liveForSelected?.status === 'live') {
        setPenaltyMissAlertActive(true)
        penaltyMissTimer = window.setTimeout(() => {
          setPenaltyMissAlertActive(false)
        }, 1700)
      }

      previousEventIdsRef.current = currentIds
      return () => {
        window.clearTimeout(recentTimer)
        if (goalTimer) {
          window.clearTimeout(goalTimer)
        }
        if (penaltyMissTimer) {
          window.clearTimeout(penaltyMissTimer)
        }
      }
    }

    previousEventIdsRef.current = currentIds
    return undefined
  }, [
    events,
    goalSoundEnabled,
    liveForSelected,
    liveForSelected?.status,
    matchLikeState.likedByCurrentUser,
    selectedMatch,
  ])

  useEffect(() => {
    if (!selectedMatch || !liveForSelected) return
    if (liveForSelected.status !== 'finished') return
    if (mvpPopupShownMatchIdsRef.current.has(selectedMatch.id)) return

    const timer = window.setTimeout(() => {
      void refreshFixture()
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [liveForSelected, refreshFixture, selectedMatch])

  useEffect(() => {
    if (!selectedMatch) return
    if (!selectedMatchMvp) return
    if (liveSelectedStatus !== 'finished') return
    if (mvpPopupShownMatchIdsRef.current.has(selectedMatch.id)) return

    const timer = window.setTimeout(() => {
      mvpPopupShownMatchIdsRef.current.add(selectedMatch.id)
      setShowMvpPopup(true)
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [liveSelectedStatus, selectedMatch, selectedMatchMvp])

  useEffect(() => {
    if (!showMvpPopup) return

    const timer = window.setTimeout(() => {
      setShowMvpPopup(false)
    }, 5000)

    return () => {
      window.clearTimeout(timer)
    }
  }, [showMvpPopup])

  const noDefinedStarters = Boolean(
    selectedMatch && homeLineup && awayLineup && homeLineup.starters.length === 0 && awayLineup.starters.length === 0,
  )

  const awayVisualLines = useMemo(
    () => (awayLineup ? buildVisualLines(awayLineup.starters, awayLineup.formationKey) : []),
    [awayLineup],
  )

  const homeVisualLines = useMemo(
    () => (homeLineup ? buildVisualLines(homeLineup.starters, homeLineup.formationKey).slice().reverse() : []),
    [homeLineup],
  )

  const homeBenchPlayers = useMemo<LineupPlayer[]>(() => {
    const lineup = homeLineup
    if (!lineup) return []
    if (noDefinedStarters) return lineup.allPlayers as LineupPlayer[]

    const resolved: LineupPlayer[] = []
    homeBenchVisibleIds.forEach((id) => {
      const player = lineup.allPlayers.find((item) => item.id === id)
      if (player) {
        resolved.push(player)
      }
    })

    return resolved
  }, [homeBenchVisibleIds, homeLineup, noDefinedStarters])

  const awayBenchPlayers = useMemo<LineupPlayer[]>(() => {
    const lineup = awayLineup
    if (!lineup) return []
    if (noDefinedStarters) return lineup.allPlayers as LineupPlayer[]

    const resolved: LineupPlayer[] = []
    awayBenchVisibleIds.forEach((id) => {
      const player = lineup.allPlayers.find((item) => item.id === id)
      if (player) {
        resolved.push(player)
      }
    })

    return resolved
  }, [awayBenchVisibleIds, awayLineup, noDefinedStarters])

  const backgroundStyle = useMemo(() => {
    const selectedColor = fixturePayload?.league.themeColor ?? selectedLeague?.themeColor
    const selectedBackgroundImage = fixturePayload?.league.backgroundImageUrl ?? selectedLeague?.backgroundImageUrl

    if (!selectedColor && !selectedBackgroundImage) return undefined

    if (selectedBackgroundImage) {
      return {
        backgroundImage: `${selectedColor ? `linear-gradient(to bottom, ${selectedColor}D9 0%, #0f172ad0 45%, #020617f2 100%), ` : ''}url(${selectedBackgroundImage})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundAttachment: 'fixed',
      } as const
    }

    return {
      backgroundImage: `linear-gradient(to bottom, ${selectedColor} 0%, #0f172a 40%, #020617 100%)`,
    } as const
  }, [fixturePayload?.league.backgroundImageUrl, fixturePayload?.league.themeColor, selectedLeague?.backgroundImageUrl, selectedLeague?.themeColor])

  const isMatchScreen = Boolean(selectedMatch)

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100" style={backgroundStyle}>
      <header className="border-b border-white/10 bg-slate-950/70 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 md:px-8">
          <div className="flex items-center gap-3">
            <img
              src={selectedLeague?.logoUrl || '/logo.png'}
              alt={selectedLeague?.name || 'FL League'}
              className="h-12 w-12 rounded-full border border-white/20 bg-white object-contain p-1"
            />
            <div>
              <h1 className="text-2xl font-bold text-white md:text-3xl">{selectedLeague?.name ?? 'FL League'}</h1>
              {selectedLeague ? (
                <>
                  <p className="text-sm text-primary-200">Temporada {selectedLeague.season}</p>
                  {selectedLeague.slogan && <p className="text-xs text-slate-300">{selectedLeague.slogan}</p>}
                </>
              ) : (
                <p className="text-sm text-primary-200">Portal oficial del cliente</p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="rounded-full border border-cyan-300/30 bg-cyan-500/10 px-3 py-1 text-xs font-semibold text-cyan-100">
              {visitorAlias ? `Bienvenido ${visitorAlias}` : 'Bienvenido'}
            </div>
            <div className="rounded-full border border-white/20 bg-slate-900/70 px-3 py-1 text-xs font-semibold text-slate-100">
              👀 Visitas: {publicEngagement.visits}
            </div>
            <button
              type="button"
              onClick={handleToggleLike}
              disabled={updatingLike}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                publicEngagement.likedByCurrentUser
                  ? 'border-rose-300/50 bg-rose-500/20 text-rose-100'
                  : 'border-white/20 bg-slate-900/70 text-slate-100 hover:border-white/35'
              }`}
            >
              {publicEngagement.likedByCurrentUser ? '❤️ Te gusta' : '🤍 Me gusta'} · {publicEngagement.likes}
            </button>
            <button
              type="button"
              onClick={handleShareWhatsApp}
              className="rounded-full border border-emerald-300/45 bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-100 transition hover:border-emerald-200"
            >
              🟢 Compartir WhatsApp
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
        <div className="mb-4 rounded-xl border border-white/15 bg-slate-900/60 p-2 md:hidden">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-slate-100">👀 Visitas: {publicEngagement.visits}</span>
            <button
              type="button"
              onClick={handleToggleLike}
              disabled={updatingLike}
              className={`rounded-full border px-2 py-0.5 font-semibold ${
                publicEngagement.likedByCurrentUser
                  ? 'border-rose-300/50 bg-rose-500/20 text-rose-100'
                  : 'border-white/20 bg-slate-800 text-slate-100'
              }`}
            >
              {publicEngagement.likedByCurrentUser ? '❤️' : '🤍'} {publicEngagement.likes}
            </button>
            <button
              type="button"
              onClick={handleShareWhatsApp}
              className="rounded-full border border-emerald-300/45 bg-emerald-500/15 px-2 py-0.5 font-semibold text-emerald-100"
            >
              🟢 Compartir
            </button>
          </div>
        </div>

        {!isMatchScreen && (
          <div className="mb-4 rounded-xl border border-white/15 bg-slate-900/60 p-3">
            <p className="text-xs text-slate-200">Identifica tu visita con alias o continúa anónimo.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                value={visitorAliasDraft}
                onChange={(event) => setVisitorAliasDraft(event.target.value)}
                placeholder="Tu alias"
                className="min-w-[180px] flex-1 rounded border border-white/20 bg-slate-900 px-3 py-2 text-sm text-white"
              />
              <button
                type="button"
                onClick={handleSaveAlias}
                className="rounded border border-cyan-300/40 bg-cyan-500/20 px-3 py-2 text-xs font-semibold text-cyan-100"
              >
                Guardar alias
              </button>
              <button
                type="button"
                onClick={handleContinueAnonymous}
                className="rounded border border-white/20 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-100"
              >
                Continuar anónimo
              </button>
            </div>
          </div>
        )}

        {loadingLeagues && <p className="text-sm text-primary-200">Cargando ligas del cliente...</p>}
        {errorMessage && <p className="text-sm text-rose-300">{errorMessage}</p>}

        {!loadingLeagues && !isMatchScreen && (
          <section className="space-y-6">
            <article className="rounded-2xl border border-white/10 bg-white/5 p-4 md:p-5">
              <h2 className="text-xl font-semibold text-white">Ligas registradas</h2>
              <p className="mt-1 text-sm text-slate-300">Selecciona una liga para ver fixture y fechas programadas.</p>

              <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {leagues.length === 0 && <p className="text-sm text-slate-400">Este cliente aún no tiene ligas activas.</p>}
                {leagues.map((league) => {
                  const active = league.id === selectedLeagueId
                  return (
                    <button
                      key={league.id}
                      type="button"
                      onClick={() => {
                        setSelectedLeagueId(league.id)
                        setSelectedCategoryId(league.categories[0]?.id ?? '')
                        setPublicStatsTab('matches')
                      }}
                      className={`rounded-xl border px-3 py-3 text-left transition ${
                        active
                          ? 'border-primary-300/60 bg-primary-400/15'
                          : 'border-white/10 bg-slate-900/50 hover:border-white/20 hover:bg-slate-900'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {league.logoUrl ? (
                          <img src={league.logoUrl} alt={league.name} className="h-8 w-8 rounded border border-white/20 bg-white object-contain p-1" />
                        ) : (
                          <div className="flex h-8 w-8 items-center justify-center rounded border border-white/20 text-[10px] text-slate-300">LG</div>
                        )}
                        <p className="font-semibold text-white">{league.name}</p>
                      </div>
                      <p className="mt-1 text-xs text-slate-300">
                        {league.country} · Temporada {league.season}
                      </p>
                    </button>
                  )
                })}
              </div>
            </article>

            {selectedLeague && (
              <article className="rounded-2xl border border-white/10 bg-white/5 p-4 md:p-5">
                <div className="mb-4 flex flex-wrap gap-2">
                  {([
                    { key: 'matches', label: 'Partidos' },
                    { key: 'standings', label: 'Tabla de posiciones' },
                    { key: 'scorers', label: 'Goleadoras' },
                    { key: 'assists', label: 'Asistidoras' },
                    { key: 'yellows', label: 'TA' },
                    { key: 'reds', label: 'TR' },
                    { key: 'keepers', label: 'Arqueras' },
                  ] as Array<{ key: ClientStatsTab; label: string }>).map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setPublicStatsTab(tab.key)}
                      className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                        publicStatsTab === tab.key
                          ? 'border-cyan-300/70 bg-cyan-500/25 text-cyan-100 shadow-md shadow-cyan-500/20'
                          : 'border-white/20 bg-slate-900/60 text-slate-200 hover:border-white/35'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-xs text-slate-300">
                    Categoría
                    <select
                      value={activeCategoryId}
                      onChange={(event) => {
                        setSelectedCategoryId(event.target.value)
                        setPublicStatsTab('matches')
                      }}
                      className="mt-1 rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
                    >
                      {availableCategories.map((category) => (
                        <option key={category.id} value={category.id}>{category.name}</option>
                      ))}
                    </select>
                  </label>

                  {publicStatsTab === 'matches' && (
                    <label className="text-xs text-slate-300">
                      Fecha
                      <select
                        value={selectedRound}
                        onChange={(event) => setSelectedRound(Number(event.target.value) || 1)}
                        className="mt-1 rounded border border-white/20 bg-slate-900 px-2 py-1 text-sm text-white"
                      >
                        {availableRounds.map((round) => (
                          <option key={round} value={round}>Fecha {round}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>

                {publicStatsTab === 'matches' ? (
                  loadingFixture ? (
                  <p className="mt-4 text-sm text-primary-200">Cargando fixture...</p>
                ) : (
                  <div className="mt-4 space-y-2">
                    {selectedRoundAward && (
                      <div key={`round-award-${selectedRound}`} className="relative mb-2 overflow-hidden rounded-2xl border border-amber-300/45 bg-gradient-to-r from-amber-500/20 via-fuchsia-500/20 to-cyan-500/20 p-3 shadow-lg shadow-amber-500/10">
                        <div className="pointer-events-none absolute inset-0">
                          {Array.from({ length: 8 }).map((_, index) => (
                            <span
                              key={`award-burst-${selectedRound}-${index}`}
                              className="absolute h-2 w-2 rounded-full"
                              style={{
                                left: `${10 + index * 11}%`,
                                top: index % 2 === 0 ? '22%' : '72%',
                                backgroundColor: awardBurstColor,
                                animation: `awardBurst 720ms ease-out ${index * 40}ms 1 both`,
                              }}
                            />
                          ))}
                        </div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-100">
                          Reconocimiento · Fecha {selectedRoundAward.round}
                        </p>
                        <div
                          className="relative mt-2 flex items-center gap-3 rounded-xl border border-amber-200/30 bg-slate-900/30 p-2"
                          style={{
                            animation: 'awardReveal 520ms cubic-bezier(0.22, 1, 0.36, 1), awardGlow 3.2s ease-in-out infinite',
                          }}
                        >
                          {selectedRoundAward.photoUrl ? (
                            <img
                              src={selectedRoundAward.photoUrl}
                              alt={selectedRoundAward.name}
                              className="h-14 w-14 rounded-full border-2 border-amber-300/80 object-cover sm:h-16 sm:w-16"
                              style={{ animation: 'awardPhotoFloat 2.8s ease-in-out infinite' }}
                            />
                          ) : (
                            <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-amber-300/80 bg-slate-900/60 text-xs font-bold text-amber-100 sm:h-16 sm:w-16">
                              MVP
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-amber-50 sm:text-sm">🏅 Jugadora de la fecha</p>
                            <p className="truncate text-sm font-bold text-white sm:text-base">{selectedRoundAward.name}</p>
                            <p className="truncate text-xs text-slate-200 sm:text-sm">{selectedRoundAward.teamName}</p>
                          </div>
                        </div>
                      </div>
                    )}

                    {matchesByRound.length === 0 && (
                      <div className="rounded-xl border border-dashed border-white/20 bg-slate-900/60 p-4 text-center">
                        <p className="text-sm font-semibold text-slate-200">Aún no se define la fecha</p>
                        <p className="mt-1 text-xs text-slate-400">Pronto se publicarán partidos y horarios para esta jornada.</p>
                      </div>
                    )}

                    {matchesByRound.map((match) => {
                      const homeTeam = teamMap.get(match.homeTeamId)
                      const awayTeam = teamMap.get(match.awayTeamId)
                      const history = resolvePlayedHistory(match)
                      const isLiveDirect = Boolean(
                        liveMatch
                        && liveMatch.homeTeam.id === match.homeTeamId
                        && liveMatch.awayTeam.id === match.awayTeamId,
                      )
                      const isLiveReverse = Boolean(
                        liveMatch
                        && liveMatch.homeTeam.id === match.awayTeamId
                        && liveMatch.awayTeam.id === match.homeTeamId,
                      )
                      const hasLiveReference = isLiveDirect || isLiveReverse
                      const isBreak = Boolean(
                        liveMatch
                        && liveMatch.status === 'live'
                        && hasLiveReference
                        && !liveMatch.timer.running
                        && liveMatch.timer.elapsedSeconds > 0,
                      )
                      const isLive = Boolean(liveMatch && liveMatch.status === 'live' && hasLiveReference && !isBreak)
                      const isLiveMarkedFinished = Boolean(liveMatch && liveMatch.status === 'finished' && hasLiveReference)
                      const isFinished = Boolean(history) || isLiveMarkedFinished

                      const liveHomeGoals = hasLiveReference
                        ? (isLiveDirect ? liveMatch?.homeTeam.stats.goals ?? 0 : liveMatch?.awayTeam.stats.goals ?? 0)
                        : 0
                      const liveAwayGoals = hasLiveReference
                        ? (isLiveDirect ? liveMatch?.awayTeam.stats.goals ?? 0 : liveMatch?.homeTeam.stats.goals ?? 0)
                        : 0

                      const homeGoals = history ? (history.reverse ? history.record.awayGoals : history.record.homeGoals) : 0
                      const awayGoals = history ? (history.reverse ? history.record.homeGoals : history.record.awayGoals) : 0
                      const previewHomeGoals = history ? homeGoals : liveHomeGoals
                      const previewAwayGoals = history ? awayGoals : liveAwayGoals
                      const historyEvents = history?.record.events ?? []
                      const normalizedHomeName = normalizeLabel(homeTeam?.name ?? history?.record.homeTeamName ?? 'local')
                      const normalizedAwayName = normalizeLabel(awayTeam?.name ?? history?.record.awayTeamName ?? 'visitante')

                      const summarizeScorers = (teamNormalizedName: string) => {
                        const scorerCount = new Map<string, number>()
                        historyEvents.forEach((event) => {
                          if ((event.type !== 'goal' && event.type !== 'penalty_goal') || normalizeLabel(event.teamName) !== teamNormalizedName) return
                          scorerCount.set(event.playerName, (scorerCount.get(event.playerName) ?? 0) + 1)
                        })

                        return Array.from(scorerCount.entries())
                          .sort((left, right) => left[0].localeCompare(right[0], 'es', { sensitivity: 'base' }))
                          .map(([playerName, goals]) => (goals > 1 ? `${playerName} x${goals}` : playerName))
                      }

                      const homeScorersHistory = summarizeScorers(normalizedHomeName)
                      const awayScorersHistory = summarizeScorers(normalizedAwayName)

                      const redCountHome = historyEvents.filter(
                        (event) => (event.type === 'red' || event.type === 'double_yellow' || event.type === 'staff_red') && normalizeLabel(event.teamName) === normalizedHomeName,
                      ).length
                      const redCountAway = historyEvents.filter(
                        (event) => (event.type === 'red' || event.type === 'double_yellow' || event.type === 'staff_red') && normalizeLabel(event.teamName) === normalizedAwayName,
                      ).length

                      const statusLabel = isLive ? 'En juego' : isBreak ? 'Descanso' : isFinished ? 'Finalizado' : 'Por jugar'
                      const statusClassName = isLive
                        ? 'border-rose-300/50 bg-rose-500/20 text-rose-100'
                        : isBreak
                          ? 'border-amber-300/50 bg-amber-500/20 text-amber-100'
                        : isFinished
                          ? 'border-emerald-300/40 bg-emerald-500/20 text-emerald-100'
                          : 'border-cyan-300/40 bg-cyan-500/15 text-cyan-100'

                      return (
                        <button
                          key={match.id}
                          type="button"
                          onClick={() => setSelectedMatchId(match.id)}
                          className="w-full rounded-2xl border border-white/10 bg-gradient-to-r from-slate-900/85 via-slate-900/75 to-slate-800/70 px-4 py-3 text-left shadow-lg shadow-slate-950/20 transition hover:-translate-y-0.5 hover:border-primary-300/50 hover:from-primary-500/10 hover:to-slate-800/70"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <TeamBadge logoUrl={homeTeam?.logoUrl} name={homeTeam?.name ?? 'Local'} />
                              <span className="text-slate-400">vs</span>
                              <TeamBadge logoUrl={awayTeam?.logoUrl} name={awayTeam?.name ?? 'Visitante'} />
                            </div>
                            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${statusClassName}`}>
                              {isLive && <span className="h-2 w-2 rounded-full bg-rose-300 animate-pulse" />}
                              {isBreak && <span className="h-2 w-2 rounded-full bg-amber-300" />}
                              {statusLabel}
                            </span>
                          </div>

                          <p className="mt-1 text-xs font-semibold text-cyan-100">
                            {(homeTeam?.name ?? 'Local')} ({previewHomeGoals}) vs {(awayTeam?.name ?? 'Visitante')} ({previewAwayGoals})
                          </p>

                          <p className="mt-2 text-xs text-slate-300">
                            {match.scheduledAt ? new Date(match.scheduledAt).toLocaleString() : 'Hora por definir'}
                            {match.venue ? ` · ${match.venue}` : ''}
                          </p>

                          {(isLive || isBreak || isFinished) && (
                            <div className={`mt-2 rounded-xl border px-3 py-2 ${isLive ? 'border-rose-300/40 bg-rose-500/10' : isBreak ? 'border-amber-300/40 bg-amber-500/10' : 'border-emerald-300/30 bg-emerald-500/10'}`}>
                              <p className={`text-sm font-semibold ${isLive ? 'text-rose-100' : isBreak ? 'text-amber-100' : 'text-emerald-100'}`}>
                                {isLive ? 'Marcador en juego' : isBreak ? 'Marcador al descanso' : 'Resultado final'}: {previewHomeGoals} - {previewAwayGoals}
                                {isFinished && history?.record.finalMinute ? ` · Min ${history.record.finalMinute}` : ''}
                              </p>
                            </div>
                          )}

                          {isFinished && (
                            <div className="mt-2 space-y-1 rounded-lg border border-emerald-300/30 bg-emerald-500/10 p-2">
                              <p className="text-[11px] text-emerald-50/95">
                                Goles: {homeScorersHistory.length > 0 ? homeScorersHistory.join(', ') : '—'} · {awayScorersHistory.length > 0 ? awayScorersHistory.join(', ') : '—'}
                              </p>
                              {(redCountHome > 0 || redCountAway > 0) && (
                                <p className="text-[11px] font-semibold text-rose-100">
                                  TR: {redCountHome} - {redCountAway}
                                </p>
                              )}
                            </div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                  )
                ) : loadingFixture ? (
                  <p className="mt-4 text-sm text-primary-200">Cargando estadísticas...</p>
                ) : (
                  <div className="mt-4 rounded-2xl border border-white/10 bg-gradient-to-br from-slate-900/80 via-slate-900/70 to-cyan-950/30 p-3">
                    {publicStatsTab === 'standings' && (
                      <>
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-white">Tabla de posiciones</p>
                          <input
                            value={publicStandingsSearchTerm}
                            onChange={(event) => {
                              setPublicStandingsSearchTerm(event.target.value)
                              setPublicStandingsPage(1)
                            }}
                            placeholder="Buscar equipo..."
                            className="w-40 rounded border border-white/20 bg-slate-800 px-2 py-1 text-[11px] text-white placeholder:text-slate-400"
                          />
                        </div>
                        {publicStandingsPagination.totalItems === 0 ? (
                          <p className="text-xs text-slate-400">Aún no hay partidos jugados para construir la tabla.</p>
                        ) : (
                          <div className="overflow-auto">
                            <table className="min-w-full text-xs text-slate-200">
                              <thead>
                                <tr className="text-slate-400">
                                  <th className="px-2 py-1 text-left">Equipo</th>
                                  <th className="px-2 py-1">PJ</th>
                                  <th className="px-2 py-1">PG</th>
                                  <th className="px-2 py-1">PE</th>
                                  <th className="px-2 py-1">PP</th>
                                  <th className="px-2 py-1">GF</th>
                                  <th className="px-2 py-1">GC</th>
                                  <th className="px-2 py-1">PROM GC</th>
                                  <th className="px-2 py-1">DG</th>
                                  <th className="px-2 py-1">PTS</th>
                                </tr>
                              </thead>
                              <tbody>
                                {publicStandingsPagination.pageItems.map((row) => (
                                  <tr key={row.teamId} className="border-t border-white/10">
                                    <td className="px-2 py-1 text-left">
                                      <span className="flex items-center gap-2 font-semibold text-white">
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
                                    <td className="px-2 py-1 text-center">{row.avgGc.toFixed(2)}</td>
                                    <td className="px-2 py-1 text-center">{row.dg}</td>
                                    <td className="px-2 py-1 text-center font-bold text-cyan-100">{row.pts}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {publicStandingsPagination.totalPages > 1 && (
                          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-300">
                            <span>Página {publicStandingsPagination.currentPage}/{publicStandingsPagination.totalPages}</span>
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={() => setPublicStandingsPage((current) => Math.max(1, current - 1))}
                                disabled={publicStandingsPagination.currentPage <= 1}
                                className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50"
                              >
                                ◀
                              </button>
                              <button
                                type="button"
                                onClick={() => setPublicStandingsPage((current) => Math.min(publicStandingsPagination.totalPages, current + 1))}
                                disabled={publicStandingsPagination.currentPage >= publicStandingsPagination.totalPages}
                                className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50"
                              >
                                ▶
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {publicActiveRanking && (
                      <>
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-white">{publicActiveRanking.title}</p>
                          <input
                            value={publicRankingSearchTerm}
                            onChange={(event) => {
                              setPublicRankingSearchTerm(event.target.value)
                              setPublicRankingPage(1)
                            }}
                            placeholder="Buscar jugadora/equipo..."
                            className="w-48 rounded border border-white/20 bg-slate-800 px-2 py-1 text-[11px] text-white placeholder:text-slate-400"
                          />
                        </div>
                        <div className="space-y-1">
                          {publicRankingPagination.totalItems === 0 && <p className="text-xs text-slate-400">Aún no hay registros.</p>}
                          {publicRankingPagination.pageItems.map((item, index) => (
                            <div key={item.key} className="rounded-lg border border-white/10 bg-slate-900/75 px-2 py-1.5 text-xs">
                              <p className="font-semibold text-cyan-100">{(publicRankingPagination.currentPage - 1) * 10 + index + 1}. {item.teamName}</p>
                              <p className="mt-0.5 flex items-center gap-2 text-slate-200">
                                {item.teamLogoUrl ? (
                                  <img src={item.teamLogoUrl} alt={item.teamName} className="h-4 w-4 rounded border border-white/20 bg-white object-contain p-0.5" />
                                ) : (
                                  <span className="flex h-4 w-4 items-center justify-center rounded border border-white/20 text-[9px] text-slate-400">EQ</span>
                                )}
                                {item.playerName} · {item.value} {publicActiveRanking.unit}{item.value === 1 || publicActiveRanking.unit === 'TA' || publicActiveRanking.unit === 'TR' ? '' : 's'}
                              </p>
                            </div>
                          ))}
                        </div>
                        {publicRankingPagination.totalPages > 1 && (
                          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-300">
                            <span>Página {publicRankingPagination.currentPage}/{publicRankingPagination.totalPages}</span>
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={() => setPublicRankingPage((current) => Math.max(1, current - 1))}
                                disabled={publicRankingPagination.currentPage <= 1}
                                className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50"
                              >
                                ◀
                              </button>
                              <button
                                type="button"
                                onClick={() => setPublicRankingPage((current) => Math.min(publicRankingPagination.totalPages, current + 1))}
                                disabled={publicRankingPagination.currentPage >= publicRankingPagination.totalPages}
                                className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50"
                              >
                                ▶
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {publicStatsTab === 'keepers' && (
                      <>
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-white">Arqueras · Valla menos vencida</p>
                          <input
                            value={publicKeepersSearchTerm}
                            onChange={(event) => {
                              setPublicKeepersSearchTerm(event.target.value)
                              setPublicKeepersPage(1)
                            }}
                            placeholder="Buscar equipo..."
                            className="w-40 rounded border border-white/20 bg-slate-800 px-2 py-1 text-[11px] text-white placeholder:text-slate-400"
                          />
                        </div>
                        <div className="space-y-1">
                          {publicKeepersPagination.totalItems === 0 && <p className="text-xs text-slate-400">Aún no hay partidos jugados.</p>}
                          {publicKeepersPagination.pageItems.map((item, index) => (
                            <div key={item.teamId} className="rounded-lg border border-white/10 bg-slate-900/75 px-2 py-1.5 text-xs">
                              <p className="flex items-center gap-2 font-semibold text-cyan-100">
                                <span>{(publicKeepersPagination.currentPage - 1) * 10 + index + 1}.</span>
                                {item.teamLogoUrl ? (
                                  <img src={item.teamLogoUrl} alt={item.teamName} className="h-4 w-4 rounded border border-white/20 bg-white object-contain p-0.5" />
                                ) : (
                                  <span className="flex h-4 w-4 items-center justify-center rounded border border-white/20 text-[9px] text-slate-400">EQ</span>
                                )}
                                {item.teamName}
                              </p>
                              <p className="mt-0.5 text-slate-200">GC: {item.gc} · PJ: {item.pj} · Prom. GC: {item.avgGc.toFixed(2)}</p>
                            </div>
                          ))}
                        </div>
                        {publicKeepersPagination.totalPages > 1 && (
                          <div className="mt-2 flex items-center justify-between text-[11px] text-slate-300">
                            <span>Página {publicKeepersPagination.currentPage}/{publicKeepersPagination.totalPages}</span>
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={() => setPublicKeepersPage((current) => Math.max(1, current - 1))}
                                disabled={publicKeepersPagination.currentPage <= 1}
                                className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50"
                              >
                                ◀
                              </button>
                              <button
                                type="button"
                                onClick={() => setPublicKeepersPage((current) => Math.min(publicKeepersPagination.totalPages, current + 1))}
                                disabled={publicKeepersPagination.currentPage >= publicKeepersPagination.totalPages}
                                className="rounded border border-white/20 bg-slate-800 px-2 py-0.5 disabled:opacity-50"
                              >
                                ▶
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </article>
            )}
          </section>
        )}

        {selectedMatch && homeLineup && awayLineup && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setSelectedMatchId('')}
                className="rounded border border-white/20 bg-slate-900 px-3 py-1 text-sm text-slate-100"
              >
                ← Volver al fixture
              </button>
              <p className="text-xs text-slate-300">
                Fecha {selectedMatch.round} · {selectedMatch.scheduledAt ? new Date(selectedMatch.scheduledAt).toLocaleString() : 'Hora por definir'}
                {selectedMatch.venue ? ` · ${selectedMatch.venue}` : ''}
              </p>
            </div>

            <div>
              <button
                type="button"
                onClick={handleToggleMatchLike}
                disabled={updatingMatchLike}
                className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                  matchLikeState.likedByCurrentUser
                    ? 'border-rose-300/50 bg-rose-500/20 text-rose-100'
                    : 'border-white/20 bg-slate-900/70 text-slate-100'
                }`}
              >
                {matchLikeState.likedByCurrentUser
                  ? `🔔 Siguiendo partido${notificationsEnabled ? '' : ' (sin permiso notif.)'}`
                  : '🔕 Seguir partido'} · {matchLikeState.likes}
              </button>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
              {selectedMatchHistory?.record && (
                <article className="rounded-2xl border border-emerald-300/30 bg-emerald-500/10 p-4 lg:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-emerald-100">
                      Datos finales del partido · {selectedMatchHistory.record.homeTeamName} {selectedMatchHistory.reverse ? selectedMatchHistory.record.awayGoals : selectedMatchHistory.record.homeGoals} - {selectedMatchHistory.reverse ? selectedMatchHistory.record.homeGoals : selectedMatchHistory.record.awayGoals} {selectedMatchHistory.record.awayTeamName}
                    </p>
                    <span className="rounded-full border border-emerald-300/40 bg-emerald-500/20 px-2 py-0.5 text-[11px] text-emerald-100">
                      Min final: {selectedMatchHistory.record.finalMinute}
                    </span>
                  </div>

                  <div className="mt-3 rounded-xl border border-white/15 bg-slate-900/65 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">MVP del partido</p>
                    {selectedMatchMvp ? (
                      <div className="mt-2 flex items-center gap-3">
                        {selectedMatchMvp.photoUrl ? (
                          <img
                            src={selectedMatchMvp.photoUrl}
                            alt={selectedMatchMvp.name}
                            className="h-14 w-14 rounded-full border border-white/30 object-cover sm:h-16 sm:w-16"
                          />
                        ) : (
                          <div className="flex h-14 w-14 items-center justify-center rounded-full border border-white/25 text-xs text-slate-300 sm:h-16 sm:w-16">
                            MVP
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-white">{selectedMatchMvp.name}</p>
                          <p className="truncate text-xs text-slate-300">{selectedMatchMvp.teamName ?? 'Equipo'}</p>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-slate-400">Aún no se registró MVP para este partido.</p>
                    )}

                    <div className="mt-3 rounded border border-white/10 bg-slate-950/60 px-2 py-1 text-[11px] text-slate-200">
                      Resumen guardado: Goles {selectedMatchHistory.record.homeGoals + selectedMatchHistory.record.awayGoals} · TA {selectedMatchHistory.record.events.filter((event) => event.type === 'yellow' || event.type === 'double_yellow' || event.type === 'staff_yellow').length} · TR {selectedMatchHistory.record.events.filter((event) => event.type === 'red' || event.type === 'double_yellow' || event.type === 'staff_red').length}
                    </div>
                  </div>
                </article>
              )}

              <article className="rounded-2xl border border-emerald-300/25 bg-gradient-to-b from-emerald-600/25 to-emerald-900/35 p-4">
                <div className="mb-3 grid gap-2 lg:grid-cols-[1fr_auto_1fr]">
                  <div className="space-y-2">
                    <TeamBadge logoUrl={homeLineup.logoUrl} name={homeLineup.name} />
                    <StaffCard
                      side="home"
                      teamName={homeLineup.name}
                      palette={homePalette}
                      director={selectedHomeTeam?.technicalStaff?.director}
                      assistant={selectedHomeTeam?.technicalStaff?.assistant}
                      discipline={liveForSelected?.homeTeam.staffDiscipline}
                    />
                  </div>
                  <div className="flex items-start justify-center">
                    <div
                      className={`relative rounded border px-4 py-2 text-center transition-all duration-300 ${goalAlertActive || penaltyMissAlertActive ? 'scale-[1.03] ring-2 shadow-lg' : ''} ${goalAlertActive ? 'ring-emerald-300/70 shadow-emerald-300/25' : penaltyMissAlertActive ? 'ring-amber-300/70 shadow-amber-300/25' : ''}`}
                      style={{
                        borderColor: withAlpha('#ffffff', 0.4),
                        backgroundImage: `linear-gradient(90deg, ${withAlpha(homePalette.fill, 0.35)} 0%, ${withAlpha(homePalette.fill, 0.35)} 50%, ${withAlpha(awayPalette.fill, 0.35)} 50%, ${withAlpha(awayPalette.fill, 0.35)} 100%)`,
                      }}
                    >
                      {goalAlertActive && (
                        <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full border border-emerald-200/70 bg-emerald-500/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-50 animate-pulse">
                          ⚽ Gol en vivo
                        </span>
                      )}
                      {!goalAlertActive && penaltyMissAlertActive && (
                        <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full border border-amber-200/70 bg-amber-500/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-50 animate-pulse">
                          ⚠ Penal fallado
                        </span>
                      )}
                      <span
                        className={`mb-1 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                          scoreboard?.isBreak
                            ? 'border-amber-300/70 bg-amber-500/20 text-amber-100'
                            : scoreboard?.status === 'live'
                            ? 'border-emerald-300/70 bg-emerald-500/20 text-emerald-100'
                            : scoreboard?.status === 'finished'
                              ? 'border-rose-300/70 bg-rose-500/20 text-rose-100'
                              : 'border-cyan-300/70 bg-cyan-500/20 text-cyan-100'
                        }`}
                      >
                        {scoreboard?.isBreak
                          ? 'Descanso'
                          : scoreboard?.status === 'live'
                          ? 'En vivo'
                          : scoreboard?.status === 'finished'
                            ? 'Finalizado'
                            : 'Por jugar'}
                      </span>
                      <p className="text-[10px] uppercase tracking-wide text-slate-300">Marcador en vivo</p>
                      <p className="text-xl font-bold text-white">
                        {scoreboard ? `${scoreboard.homeGoals} - ${scoreboard.awayGoals}` : '0 - 0'}
                      </p>
                      <p className="text-[10px] text-slate-200">
                        {scoreboard
                          ? `${scoreboard.isBreak ? `Descanso · ${scoreboard.clock}` : scoreboard.status === 'live' ? `Min ${scoreboard.minute} · ${scoreboard.clock}` : scoreboard.status === 'finished' ? `Final ${scoreboard.clock}` : 'Previo 00:00'}`
                          : 'Evento aún no inicia'}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <TeamBadge logoUrl={awayLineup.logoUrl} name={awayLineup.name} />
                    <StaffCard
                      side="away"
                      teamName={awayLineup.name}
                      palette={awayPalette}
                      director={selectedAwayTeam?.technicalStaff?.director}
                      assistant={selectedAwayTeam?.technicalStaff?.assistant}
                      discipline={liveForSelected?.awayTeam.staffDiscipline}
                    />
                  </div>
                </div>

                <div className="relative overflow-hidden rounded-xl border border-white/20 bg-emerald-600/75 p-3">
                  <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(0deg,rgba(255,255,255,0.04)_0px,rgba(255,255,255,0.04)_30px,rgba(0,0,0,0.04)_30px,rgba(0,0,0,0.04)_60px)]" />
                  <div className="pointer-events-none absolute inset-0">
                    <div className="absolute left-2 right-2 top-2 bottom-2 rounded-md border border-white/35" />
                    <div className="absolute left-2 right-2 top-1/2 h-px -translate-y-1/2 bg-white/45" />
                    <div className="absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40" />
                    <div className="absolute left-1/2 top-2 h-10 w-28 -translate-x-1/2 border border-white/35" />
                    <div className="absolute left-1/2 top-2 h-5 w-14 -translate-x-1/2 border border-white/35" />
                    <div className="absolute left-1/2 bottom-2 h-10 w-28 -translate-x-1/2 border border-white/35" />
                    <div className="absolute left-1/2 bottom-2 h-5 w-14 -translate-x-1/2 border border-white/35" />
                  </div>

                  <div className="relative mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide">
                    <span className="rounded px-1.5 py-0.5" style={{ backgroundColor: awayPalette.fill, color: awayPalette.text }}>{awayLineup.name}</span>
                    <span className="rounded px-1.5 py-0.5" style={{ backgroundColor: homePalette.fill, color: homePalette.text }}>{homeLineup.name}</span>
                  </div>

                  {noDefinedStarters ? (
                    <div className="relative rounded border border-dashed border-emerald-900/50 bg-emerald-200/30 p-3 text-center text-xs font-semibold text-emerald-950">
                      Aún no se han definido titulares. El esquema de cancha aparecerá automáticamente al cargar las alineaciones.
                    </div>
                  ) : (
                    <div className="relative h-[440px]">
                      <div className="absolute inset-x-2 top-4 bottom-1/2 flex flex-col justify-evenly">
                        {awayVisualLines.map((line, lineIndex) => (
                          <div key={`away-line-${lineIndex}`} className="px-1">
                            <div
                              className="grid items-start gap-2"
                              style={{ gridTemplateColumns: `repeat(${line.length}, minmax(0, 1fr))` }}
                            >
                            {line.map((player) => (
                              <div key={player.id} className="min-w-0 text-center">
                                <div className="relative mx-auto h-9 w-9">
                                  <div
                                    className="flex h-9 w-9 items-center justify-center rounded-full border border-white/80 text-xs font-bold"
                                    style={{ backgroundColor: awayPalette.fill, color: awayPalette.text }}
                                  >
                                    {player.number}
                                  </div>
                                  {(() => {
                                    const indicator = playerEventIndicators.get(player.id)
                                    if (!indicator) return null

                                    return (
                                      <div className="absolute -right-1 -top-1 flex flex-col items-start gap-0.5">
                                        {indicator.goals > 0 && (
                                          <span className={`rounded bg-slate-900/85 px-1 text-[10px] font-bold text-emerald-200 transition-all ${indicator.recentGoal ? 'animate-pulse ring-1 ring-emerald-300/70' : ''}`}>
                                            ⚽{indicator.goals > 1 ? `x${indicator.goals}` : ''}
                                          </span>
                                        )}
                                        {indicator.penaltyMisses > 0 && (
                                          <span className={`rounded bg-slate-900/85 px-1 text-[10px] font-bold text-slate-100 transition-all ${indicator.recentPenaltyMiss ? 'animate-pulse ring-1 ring-slate-300/70' : ''}`}>
                                            ❌⚽{indicator.penaltyMisses > 1 ? `x${indicator.penaltyMisses}` : ''}
                                          </span>
                                        )}
                                        {indicator.yellows > 0 && (
                                          <span className={`rounded bg-amber-400/90 px-1 text-[10px] font-bold text-amber-950 transition-all ${indicator.recentYellow ? 'animate-pulse ring-1 ring-amber-200/90' : ''}`}>
                                            TA{indicator.yellows > 1 ? `x${indicator.yellows}` : ''}
                                          </span>
                                        )}
                                        {indicator.reds > 0 && (
                                          <span className={`rounded bg-rose-600/95 px-1 text-[10px] font-bold text-rose-50 transition-all ${indicator.recentRed ? 'animate-pulse ring-1 ring-rose-200/90' : ''}`}>
                                            TR{indicator.reds > 1 ? `x${indicator.reds}` : ''}
                                          </span>
                                        )}
                                      </div>
                                    )
                                  })()}
                                </div>
                                <p className={`mt-1 px-0.5 font-semibold text-white drop-shadow ${line.length >= 5 ? 'text-[9px]' : 'text-[10px]'} leading-tight break-words`}>
                                  {player.name}
                                </p>
                              </div>
                            ))}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="absolute inset-x-2 top-1/2 bottom-4 flex flex-col justify-evenly">
                        {homeVisualLines.map((line, lineIndex) => (
                          <div key={`home-line-${lineIndex}`} className="px-1">
                            <div
                              className="grid items-start gap-2"
                              style={{ gridTemplateColumns: `repeat(${line.length}, minmax(0, 1fr))` }}
                            >
                            {line.map((player) => (
                              <div key={player.id} className="min-w-0 text-center">
                                <div className="relative mx-auto h-9 w-9">
                                  <div
                                    className="flex h-9 w-9 items-center justify-center rounded-full border border-white/80 text-xs font-bold"
                                    style={{ backgroundColor: homePalette.fill, color: homePalette.text }}
                                  >
                                    {player.number}
                                  </div>
                                  {(() => {
                                    const indicator = playerEventIndicators.get(player.id)
                                    if (!indicator) return null

                                    return (
                                      <div className="absolute -right-1 -top-1 flex flex-col items-start gap-0.5">
                                        {indicator.goals > 0 && (
                                          <span className={`rounded bg-slate-900/85 px-1 text-[10px] font-bold text-emerald-200 transition-all ${indicator.recentGoal ? 'animate-pulse ring-1 ring-emerald-300/70' : ''}`}>
                                            ⚽{indicator.goals > 1 ? `x${indicator.goals}` : ''}
                                          </span>
                                        )}
                                        {indicator.penaltyMisses > 0 && (
                                          <span className={`rounded bg-slate-900/85 px-1 text-[10px] font-bold text-slate-100 transition-all ${indicator.recentPenaltyMiss ? 'animate-pulse ring-1 ring-slate-300/70' : ''}`}>
                                            ❌⚽{indicator.penaltyMisses > 1 ? `x${indicator.penaltyMisses}` : ''}
                                          </span>
                                        )}
                                        {indicator.yellows > 0 && (
                                          <span className={`rounded bg-amber-400/90 px-1 text-[10px] font-bold text-amber-950 transition-all ${indicator.recentYellow ? 'animate-pulse ring-1 ring-amber-200/90' : ''}`}>
                                            TA{indicator.yellows > 1 ? `x${indicator.yellows}` : ''}
                                          </span>
                                        )}
                                        {indicator.reds > 0 && (
                                          <span className={`rounded bg-rose-600/95 px-1 text-[10px] font-bold text-rose-50 transition-all ${indicator.recentRed ? 'animate-pulse ring-1 ring-rose-200/90' : ''}`}>
                                            TR{indicator.reds > 1 ? `x${indicator.reds}` : ''}
                                          </span>
                                        )}
                                      </div>
                                    )
                                  })()}
                                </div>
                                <p className={`mt-1 px-0.5 font-semibold text-white drop-shadow ${line.length >= 5 ? 'text-[9px]' : 'text-[10px]'} leading-tight break-words`}>
                                  {player.name}
                                </p>
                              </div>
                            ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  <div
                    className="rounded-xl border p-2"
                    style={{
                      borderColor: withAlpha(homePalette.fill, 0.6),
                      backgroundColor: withAlpha('#020617', 0.72),
                    }}
                  >
                    <p className="text-xs font-semibold text-slate-100">
                      {noDefinedStarters ? `Plantel completo ${homeLineup.name}` : `Suplentes ${homeLineup.name}`}
                    </p>
                    <div className="mt-1 max-h-28 space-y-1 overflow-auto pr-1 text-xs text-slate-100">
                      {homeBenchPlayers.length === 0 && <p className="text-slate-400">Sin jugadores registrados.</p>}
                      {homeBenchPlayers.map((player: LineupPlayer) => {
                        const indicator = playerEventIndicators.get(player.id)
                        const isOnField = homeLineup.starters.some((starter) => starter.id === player.id)
                        const badges: string[] = []

                        if (indicator?.goals) badges.push(`⚽ ${indicator.goals}`)
                        if (indicator?.penaltyMisses) badges.push(`❌⚽ ${indicator.penaltyMisses}`)
                        if (indicator?.yellows) badges.push(`TA ${indicator.yellows}`)
                        if (indicator?.reds) badges.push(`TR ${indicator.reds}`)
                        if (homeSubstitutionData.outPlayerIds.has(player.id)) badges.push('↘ Salió')
                        if (homeSubstitutionData.inPlayerIds.has(player.id)) badges.push('↗ Entró')

                        return (
                          <div key={player.id} className="rounded border border-white/10 bg-slate-900/70 px-2 py-1">
                            <p className="font-medium">
                              #{player.number} {player.name}
                              {isOnField && <span className="ml-2 rounded bg-emerald-600/40 px-1 py-0.5 text-[10px] font-semibold text-emerald-100">↗ En cancha</span>}
                            </p>
                            {badges.length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {badges.map((badge) => (
                                  <span key={`${player.id}-${badge}`} className="rounded bg-slate-700/90 px-1 py-0.5 text-[10px] text-slate-100">
                                    {badge}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    <div className="mt-2 rounded border border-white/10 bg-slate-900/70 p-2">
                      <p className="text-[11px] font-semibold text-slate-200">Timeline de cambios</p>
                      <div className="mt-1 max-h-20 space-y-1 overflow-auto pr-1 text-[11px] text-slate-300">
                        {homeSubstitutionData.timeline.length === 0 && <p className="text-slate-400">Sin cambios registrados.</p>}
                        {homeSubstitutionData.timeline.map((entry) => {
                          const outName = homeLineup.allPlayers.find((player) => player.id === entry.outPlayerId)?.name ?? entry.outPlayerId
                          const inName = entry.inPlayerId
                            ? (homeLineup.allPlayers.find((player) => player.id === entry.inPlayerId)?.name ?? entry.inPlayerId)
                            : 'Cambio'
                          return (
                            <p key={entry.id} className="rounded border border-white/10 bg-slate-800/80 px-2 py-1">
                              {entry.minute}' · {entry.clock} · <span className="text-rose-300">↘ {outName}</span> · <span className="text-emerald-300">↗ {inName}</span>
                            </p>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                  <div
                    className="rounded-xl border p-2"
                    style={{
                      borderColor: withAlpha(awayPalette.fill, 0.6),
                      backgroundColor: withAlpha('#020617', 0.72),
                    }}
                  >
                    <p className="text-xs font-semibold text-slate-100">
                      {noDefinedStarters ? `Plantel completo ${awayLineup.name}` : `Suplentes ${awayLineup.name}`}
                    </p>
                    <div className="mt-1 max-h-28 space-y-1 overflow-auto pr-1 text-xs text-slate-100">
                      {awayBenchPlayers.length === 0 && <p className="text-slate-400">Sin jugadores registrados.</p>}
                      {awayBenchPlayers.map((player: LineupPlayer) => {
                        const indicator = playerEventIndicators.get(player.id)
                        const isOnField = awayLineup.starters.some((starter) => starter.id === player.id)
                        const badges: string[] = []

                        if (indicator?.goals) badges.push(`⚽ ${indicator.goals}`)
                        if (indicator?.penaltyMisses) badges.push(`❌⚽ ${indicator.penaltyMisses}`)
                        if (indicator?.yellows) badges.push(`TA ${indicator.yellows}`)
                        if (indicator?.reds) badges.push(`TR ${indicator.reds}`)
                        if (awaySubstitutionData.outPlayerIds.has(player.id)) badges.push('↘ Salió')
                        if (awaySubstitutionData.inPlayerIds.has(player.id)) badges.push('↗ Entró')

                        return (
                          <div key={player.id} className="rounded border border-white/10 bg-slate-900/70 px-2 py-1">
                            <p className="font-medium">
                              #{player.number} {player.name}
                              {isOnField && <span className="ml-2 rounded bg-emerald-600/40 px-1 py-0.5 text-[10px] font-semibold text-emerald-100">↗ En cancha</span>}
                            </p>
                            {badges.length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {badges.map((badge) => (
                                  <span key={`${player.id}-${badge}`} className="rounded bg-slate-700/90 px-1 py-0.5 text-[10px] text-slate-100">
                                    {badge}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    <div className="mt-2 rounded border border-white/10 bg-slate-900/70 p-2">
                      <p className="text-[11px] font-semibold text-slate-200">Timeline de cambios</p>
                      <div className="mt-1 max-h-20 space-y-1 overflow-auto pr-1 text-[11px] text-slate-300">
                        {awaySubstitutionData.timeline.length === 0 && <p className="text-slate-400">Sin cambios registrados.</p>}
                        {awaySubstitutionData.timeline.map((entry) => {
                          const outName = awayLineup.allPlayers.find((player) => player.id === entry.outPlayerId)?.name ?? entry.outPlayerId
                          const inName = entry.inPlayerId
                            ? (awayLineup.allPlayers.find((player) => player.id === entry.inPlayerId)?.name ?? entry.inPlayerId)
                            : 'Cambio'
                          return (
                            <p key={entry.id} className="rounded border border-white/10 bg-slate-800/80 px-2 py-1">
                              {entry.minute}' · {entry.clock} · <span className="text-rose-300">↘ {outName}</span> · <span className="text-emerald-300">↗ {inName}</span>
                            </p>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </article>

              <aside
                className="rounded-2xl border p-4"
                style={{
                  borderColor: withAlpha('#ffffff', 0.18),
                  backgroundImage: `linear-gradient(180deg, ${withAlpha(homePalette.fill, 0.22)} 0%, ${withAlpha(awayPalette.fill, 0.2)} 100%)`,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-white">Eventos en vivo</p>
                  <button
                    type="button"
                    onClick={() => setGoalSoundEnabled((current) => !current)}
                    className={`rounded border px-2 py-0.5 text-[10px] font-semibold ${goalSoundEnabled ? 'border-emerald-200/60 bg-emerald-500/25 text-emerald-100' : 'border-white/30 bg-slate-900/40 text-slate-200'}`}
                  >
                    {goalSoundEnabled ? '🔊 Sonido gol ON' : '🔈 Sonido gol OFF'}
                  </button>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {liveForSelected
                    ? `Estado: ${liveForSelected.status === 'live' ? (liveForSelected.timer.running ? 'En juego' : liveForSelected.timer.elapsedSeconds > 0 ? 'Descanso' : 'Por jugar') : liveForSelected.status === 'finished' ? 'Finalizado' : 'Por jugar'} · Reloj ${liveClockLabel}`
                    : selectedMatchHistory?.record
                      ? `Estado: Finalizado · Min final ${selectedMatchHistory.record.finalMinute} · Detalle cargado desde historial`
                      : 'Este partido aún no está cargado en Live.'}
                </p>

                <div
                  className="mt-3 rounded-xl border p-2 text-xs"
                  style={{
                    borderColor: withAlpha('#ffffff', 0.15),
                    backgroundColor: withAlpha('#020617', 0.7),
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold text-slate-200">Tabla de goles</p>
                    <span className="rounded border border-white/20 bg-slate-900/70 px-2 py-0.5 text-[10px] text-slate-300">
                      {goalTimelineRows.length} {goalTimelineRows.length === 1 ? 'gol' : 'goles'}
                    </span>
                  </div>

                  {goalTimelineRows.length === 0 ? (
                    <p className="mt-2 rounded border border-dashed border-white/20 bg-slate-900/60 px-2 py-1.5 text-[11px] text-slate-400">
                      Aún no hay goles registrados.
                    </p>
                  ) : (
                    <>
                      <div className="mt-2 space-y-1 md:hidden">
                        {goalTimelineRows.map((row) => {
                          const palette = row.isHomeTeam ? homePalette : awayPalette
                          const textColor = pickReadableEventTextColor(palette.fill, 0.24)
                          return (
                            <div
                              key={row.id}
                              className="rounded border px-2 py-1.5"
                              style={{
                                borderColor: withAlpha(palette.fill, 0.5),
                                backgroundColor: withAlpha(palette.fill, 0.18),
                                color: textColor,
                              }}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold">{row.minute}</span>
                                <span className="text-[10px] opacity-85">{row.clock}</span>
                              </div>
                              <p className="mt-1 truncate text-[11px] font-semibold">⚽ {row.playerName}</p>
                              <p className="truncate text-[10px] opacity-90">{row.teamName}{row.isPenalty ? ' · Penal' : ''}</p>
                            </div>
                          )
                        })}
                      </div>

                      <div className="mt-2 hidden overflow-auto rounded border border-white/10 md:block">
                        <table className="min-w-full text-[11px] text-slate-100">
                          <thead className="bg-slate-900/70 text-slate-300">
                            <tr>
                              <th className="px-2 py-1 text-left font-semibold">Min</th>
                              <th className="px-2 py-1 text-left font-semibold">Equipo</th>
                              <th className="px-2 py-1 text-left font-semibold">Goleadora</th>
                              <th className="px-2 py-1 text-left font-semibold">Tipo</th>
                            </tr>
                          </thead>
                          <tbody>
                            {goalTimelineRows.map((row) => {
                              const palette = row.isHomeTeam ? homePalette : awayPalette
                              const textColor = pickReadableEventTextColor(palette.fill, 0.24)
                              return (
                                <tr key={row.id} className="border-t border-white/10">
                                  <td className="px-2 py-1.5 text-slate-200">{row.minute}</td>
                                  <td className="px-2 py-1.5">
                                    <span
                                      className="inline-flex max-w-[180px] truncate rounded px-1.5 py-0.5 font-semibold"
                                      style={{
                                        backgroundColor: withAlpha(palette.fill, 0.25),
                                        color: textColor,
                                      }}
                                    >
                                      {row.teamName}
                                    </span>
                                  </td>
                                  <td className="px-2 py-1.5 text-white">{row.playerName}</td>
                                  <td className="px-2 py-1.5 text-slate-300">{row.isPenalty ? 'Penal' : 'Juego'}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>

                <div
                  className="mt-3 rounded-xl border p-2 text-xs"
                  style={{
                    borderColor: withAlpha('#ffffff', 0.15),
                    backgroundColor: withAlpha('#020617', 0.76),
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold text-slate-200">Highlights</p>
                    <span className="rounded border border-white/20 bg-slate-900/70 px-2 py-0.5 text-[10px] text-slate-300">
                      {selectedMatchHistory?.record.highlightVideos?.length ?? 0} {(selectedMatchHistory?.record.highlightVideos?.length ?? 0) === 1 ? 'video' : 'videos'}
                    </span>
                  </div>

                  {selectedMatchHistory?.record.highlightVideos && selectedMatchHistory.record.highlightVideos.length > 0 ? (
                    <div className="mt-2 flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1 md:grid md:max-h-[30rem] md:grid-cols-1 md:gap-2 md:overflow-x-hidden md:overflow-y-auto md:pr-1">
                      {selectedMatchHistory.record.highlightVideos.map((video) => (
                        <div key={video.id} className="min-w-[18rem] snap-start rounded border border-white/10 bg-slate-900/70 p-2 md:min-w-0">
                          <p className="mb-2 truncate text-[11px] font-semibold text-slate-200">{video.name}</p>
                          <video src={video.url} controls preload="metadata" playsInline className="w-full rounded-lg bg-slate-950" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 rounded border border-dashed border-white/20 bg-slate-900/60 px-2 py-1.5 text-[11px] text-slate-400">
                      Todavia no hay highlights publicados para este partido.
                    </p>
                  )}
                </div>

                <div
                  className="mt-3 h-[340px] overflow-auto rounded-xl border p-2 text-xs"
                  style={{
                    borderColor: withAlpha('#ffffff', 0.15),
                    backgroundColor: withAlpha('#020617', 0.78),
                  }}
                >
                  {events.length === 0 && (
                    <div className="rounded border border-dashed p-3" style={{ borderColor: withAlpha('#ffffff', 0.2), color: '#cbd5e1' }}>
                      El evento aún no inicia.
                    </div>
                  )}
                  <div className="space-y-2">
                    {events.map((event) => {
                      const eventPalette = event.isHomeTeamEvent ? homePalette : awayPalette
                      const eventTextColor = pickReadableEventTextColor(eventPalette.fill, 0.22)
                      const eventTag = event.isHomeTeamEvent ? 'LOCAL' : 'VISITA'
                      const isRecentEvent = recentEventIds.includes(event.id)
                      return (
                        <div
                          key={event.id}
                          className={`rounded border px-2 py-1 transition-all duration-500 ${isRecentEvent ? 'translate-x-0 opacity-100 ring-1 scale-[1.01]' : 'translate-x-0 opacity-100'}`}
                          style={{
                            borderColor: withAlpha(eventPalette.fill, 0.62),
                            backgroundColor: withAlpha(eventPalette.fill, 0.22),
                            color: eventTextColor,
                            transform: isRecentEvent ? 'translateX(0)' : 'translateX(0)',
                            animation: isRecentEvent ? 'eventSlideIn 420ms ease-out' : undefined,
                          }}
                        >
                          <span
                            className="mr-2 inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold"
                            style={{
                              backgroundColor: withAlpha(eventTextColor, 0.18),
                              color: eventTextColor,
                            }}
                          >
                            {eventTag}
                          </span>
                          {event.label}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </aside>
            </div>
          </section>
        )}
      </main>

      {showMvpPopup && selectedMatchMvp && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/75 px-4 backdrop-blur-[2px]">
          <div className="w-full max-w-sm rounded-2xl border border-white/20 bg-slate-900 p-4 shadow-2xl shadow-black/40">
            <p className="text-center text-xs font-semibold uppercase tracking-wide text-emerald-200">Partido finalizado</p>
            <h3 className="mt-1 text-center text-lg font-bold text-white">MVP del partido</h3>

            <div className="mt-4 flex flex-col items-center gap-2 text-center">
              {selectedMatchMvp.photoUrl ? (
                <img
                  src={selectedMatchMvp.photoUrl}
                  alt={selectedMatchMvp.name}
                  className="h-20 w-20 rounded-full border border-white/30 object-cover sm:h-24 sm:w-24"
                />
              ) : (
                <div className="flex h-20 w-20 items-center justify-center rounded-full border border-white/25 text-sm font-semibold text-slate-300 sm:h-24 sm:w-24">
                  MVP
                </div>
              )}
              <p className="text-base font-semibold text-white">{selectedMatchMvp.name}</p>
              <p className="text-xs text-slate-300">{selectedMatchMvp.teamName ?? 'Equipo'}</p>
            </div>

            <button
              type="button"
              onClick={() => setShowMvpPopup(false)}
              className="mt-5 w-full rounded-lg border border-emerald-300/50 bg-emerald-500/20 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/30"
            >
              Entendido (se cierra en 5s)
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes eventSlideIn {
          0% {
            opacity: 0;
            transform: translateY(8px) scale(0.98);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        @keyframes awardReveal {
          0% {
            opacity: 0;
            transform: translateY(10px) scale(0.97);
            filter: saturate(0.8);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
            filter: saturate(1);
          }
        }

        @keyframes awardGlow {
          0%,
          100% {
            box-shadow: 0 0 0 rgba(251, 191, 36, 0);
          }
          50% {
            box-shadow: 0 0 0 6px rgba(251, 191, 36, 0.12);
          }
        }

        @keyframes awardPhotoFloat {
          0%,
          100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-2px);
          }
        }

        @keyframes awardBurst {
          0% {
            opacity: 0;
            transform: translateY(0) scale(0.45);
          }
          20% {
            opacity: 0.95;
          }
          100% {
            opacity: 0;
            transform: translateY(-16px) scale(1.25);
          }
        }
      `}</style>

      <StoreFooter />
    </div>
  )
}
