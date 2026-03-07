export interface RegisteredPlayer {
  id: string
  name: string
  nickname: string
  age: number
  number: number
  position: string
  photoUrl?: string
}

export interface RegisteredTeam {
  id: string
  leagueId: string
  categoryId: string
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
  players: RegisteredPlayer[]
}

export interface CreateLeaguePayload {
  name: string
  slug: string
  country: string
  season: number
  slogan?: string
  themeColor?: string
  backgroundImageUrl?: string
  logoUrl?: string
  categories: Array<{
    name: string
    minAge: number
    maxAge: number | null
    rules: {
      playersOnField: number
      maxRegisteredPlayers?: number
      matchMinutes: number
      breakMinutes: number
      allowDraws: boolean
      pointsWin: number
      pointsDraw: number
      pointsLoss: number
      courtsCount?: number
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
    }
  }>
}

export interface FixtureMatch {
  homeTeamId: string
  awayTeamId: string | null
  hasBye: boolean
}

export interface FixtureRound {
  round: number
  matches: FixtureMatch[]
}

export interface FixtureResponse {
  teamsCount: number
  hasBye: boolean
  rounds: FixtureRound[]
}

export interface AuthUser {
  id: string
  name: string
  organizationName?: string
  email: string
  role: 'super_admin' | 'client_admin'
}

export interface LoginPayload {
  identifier: string
  password: string
  accessToken?: string
}

export interface ClientAccessValidation {
  client: AuthUser
  expiresAt: string
}

export interface ClientAccessTokenSummary {
  id: string
  clientUserId: string
  clientName: string
  clientEmail: string
  organizationName?: string
  publicRouteAlias?: string
  publicPortalPath?: string
  token: string
  expiresAt: string
  active: boolean
  createdAt: string
  revokedAt?: string
}

export interface UserWithLeagues extends AuthUser {
  active: boolean
  publicRouteAlias?: string
  publicPortalPath?: string
  leagues: Array<{
    id: string
    name: string
    slug?: string
    country: string
    season: number
    slogan?: string
    ownerUserId: string
    active: boolean
  }>
  leaguesCount: number
}

export interface AuditLogEntry {
  id: string
  timestamp: string
  userId: string
  userEmail: string
  action: 'login_success' | 'login_failed' | 'logout'
  ip: string
  details?: string
}

export interface FixtureScheduleEntry {
  leagueId: string
  categoryId: string
  matchId: string
  round: number
  scheduledAt: string
  venue?: string
}

export interface RoundMatchBestPlayer {
  matchKey: string
  homeTeamId: string
  awayTeamId: string
  playerId: string
  playerName: string
  teamId: string
  teamName: string
}

export interface RoundAwardsEntry {
  leagueId: string
  categoryId: string
  round: number
  matchBestPlayers: RoundMatchBestPlayer[]
  roundBestPlayerId?: string
  roundBestPlayerName?: string
  roundBestPlayerTeamId?: string
  roundBestPlayerTeamName?: string
  updatedAt: string
}

export interface RoundAwardsRankingEntry {
  playerId: string
  playerName: string
  teamId: string
  teamName: string
  votes: number
}

export interface PlayedMatchRecord {
  matchId: string
  leagueId: string
  categoryId: string
  round: number
  finalMinute: number
  homeTeamName: string
  awayTeamName: string
  homeStats: {
    shots: number
    goals: number
    yellows: number
    reds: number
    assists: number
  }
  awayStats: {
    shots: number
    goals: number
    yellows: number
    reds: number
    assists: number
  }
  penaltyShootout?: {
    home: number
    away: number
  }
  playerOfMatchId?: string
  playerOfMatchName?: string
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
  players: Array<{
    playerId: string
    playerName: string
    teamId: string
    teamName: string
    position: string
    goals: number
    assists: number
    shots: number
    yellows: number
    reds: number
    goalsConceded: number
  }>
  goals: Array<{
    minute: number
    clock: string
    teamName: string
    playerName: string
  }>
  events: Array<{
    clock: string
    type: 'shot' | 'goal' | 'penalty_goal' | 'penalty_miss' | 'yellow' | 'red' | 'double_yellow' | 'assist' | 'substitution'
    teamName: string
    playerName: string
  }>
  highlightVideos: Array<{
    id: string
    name: string
    url: string
  }>
  playedAt: string
}
