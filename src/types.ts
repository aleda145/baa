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
  stunnedMs: number
  slowedMs: number
  boostMs: number
  tumbleMs: number
  score: number
  combo: number
}

export type GameItemKind = 'fence' | 'mud' | 'wolf' | 'bell' | 'hay' | 'flower'

export type GameItem = {
  id: string
  kind: GameItemKind
  lane: Lane
  distance: number
  collectedOrHit: boolean
  missed: boolean
}

export type GameEventKind =
  | 'fence-hit'
  | 'mud-hit'
  | 'wolf-hit'
  | 'bell'
  | 'hay'
  | 'flower'
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
  finishTimeMs: number | null
  sheep: SheepState
  items: GameItem[]
  events: GameEvent[]
}
