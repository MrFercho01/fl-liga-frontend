export interface LivePlayer {
  id: string
  name: string
  nickname: string
  number: number
  position: string
  age: number
  photoUrl?: string
}

export interface LiveTeamStats {
  shots: number
  goals: number
  yellows: number
  reds: number
  assists: number
}

export interface LiveTeam {
  id: string
  name: string
  players: LivePlayer[]
  starters: string[]
  substitutes: string[]
  formationKey?: string
  redCarded: string[]
  stats: LiveTeamStats
  playerStats: Record<string, LiveTeamStats>
}

export interface LiveSettings {
  playersOnField: number
  matchMinutes: number
  breakMinutes: number
  homeHasBye: boolean
  awayHasBye: boolean
}

export interface LiveEvent {
  id: string
  timestamp: string
  teamId: string
  playerId: string | null
  type: 'shot' | 'goal' | 'penalty_goal' | 'penalty_miss' | 'yellow' | 'red' | 'double_yellow' | 'assist' | 'substitution'
  minute: number
  elapsedSeconds: number
  clock: string
}

export interface LiveMatch {
  id: string
  leagueName: string
  categoryName: string
  status: 'scheduled' | 'live' | 'finished'
  homeTeam: LiveTeam
  awayTeam: LiveTeam
  settings: LiveSettings
  timer: {
    running: boolean
    startedAt: number | null
    elapsedSeconds: number
  }
  currentMinute: number
  events: LiveEvent[]
}

export type LiveTimerAction = 'start' | 'stop' | 'reset' | 'finish'
