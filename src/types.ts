export type Lane = -1 | 0 | 1

export type InputState = {
  voiced: boolean
  pitchHz: number | null
  confidence: number
  volume: number
  lane: Lane
  label: 'BAA↑' | 'baa' | 'BAA↓' | '?'
}

export type SheepState = {
  lane: Lane
  targetLane: Lane
  lanePosition: number
  speed: number
  tumbleMs: number
  blinkMs: number
}

export type GameItemKind = 'wolf'

export type GameItem = {
  id: string
  kind: GameItemKind
  lane: Lane
  distance: number
  collectedOrHit: boolean
  missed: boolean
}

export type GameEventKind =
  | 'wolf-hit'
  | 'finish'

export type GameEvent = {
  id: string
  kind: GameEventKind
  message: string
  createdAtMs: number
}

export type GameState = {
  elapsedMs: number
  progress: number
  finished: boolean
  outcome: 'running' | 'won'
  finishTimeMs: number | null
  sheep: SheepState
  items: GameItem[]
  events: GameEvent[]
}
