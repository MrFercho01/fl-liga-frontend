export type KnockoutFormat = 'final_2' | 'semi_4' | 'quarter_8' | 'r16_16' | 'r32_32'
export type KnockoutSeedingMethod = 'intelligent' | 'random'

export interface KnockoutTeamEntry {
  teamId: string
  teamName: string
  position: number
}

export interface KnockoutMatch {
  id: string
  slot: number
  homeTeamId: string | null
  awayTeamId: string | null
  homeTeamName: string | null
  awayTeamName: string | null
  isBye: boolean
  /** Aggregate goals (or single-leg goals) */
  homeGoals: number | null
  awayGoals: number | null
  penaltyHome: number | null
  penaltyAway: number | null
  winnerId: string | null
  winnerName: string | null
  status: 'pending' | 'finished'
  homeFromRoundIdx: number | null
  homeFromSlot: number | null
  awayFromRoundIdx: number | null
  awayFromSlot: number | null
  fixtureRound: number
  // Two-legged support
  twoLegged: boolean
  fixtureRound2: number | null
  leg1HomeGoals: number | null
  leg1AwayGoals: number | null
  leg2HomeGoals: number | null
  leg2AwayGoals: number | null
  leg1Done: boolean
  leg2Done: boolean
}

export interface KnockoutRound {
  index: number
  name: string
  fixtureRound: number
  twoLegged: boolean
  matches: KnockoutMatch[]
}

export interface KnockoutBracket {
  id: string
  leagueId: string
  categoryId: string
  format: KnockoutFormat
  seedingMethod: KnockoutSeedingMethod
  qualifiedTeams: KnockoutTeamEntry[]
  rounds: KnockoutRound[]
  createdAt: string
  updatedAt: string
}

export interface KnockoutFormatOption {
  format: KnockoutFormat
  label: string
  teamsNeeded: number
  roundNames: string[]
}
