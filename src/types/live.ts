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
  players: LivePlayer[]
  starters: string[]
  substitutes: string[]
  formationKey?: string
  redCarded: string[]
  staffDiscipline: {
    director: {
      name?: string
      yellows: number
      reds: number
      sentOff: boolean
    }
    assistant: {
      name?: string
      yellows: number
      reds: number
      sentOff: boolean
    }
  }
  stats: LiveTeamStats
  playerStats: Record<string, LiveTeamStats>
}

export type LiveStaffRole = 'director' | 'assistant'

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
  substitutionInPlayerId?: string
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
    | 'staff_red'
  staffRole?: LiveStaffRole
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
