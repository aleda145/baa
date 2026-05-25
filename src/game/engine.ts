import type { GameEvent, GameEventKind, GameItem, GameItemKind, GameState, Lane } from '../types'

export const COURSE_LENGTH = 3000
export const COURSE_START_X = 7
export const COURSE_END_X = 93
export const BASE_SPEED = 136
export const HIT_WINDOW = 24

const laneOrder: Lane[] = [1, 0, -1]

const itemEmoji: Record<GameItemKind, string> = {
  fence: '🚧',
  mud: '🟫',
  wolf: '🐺',
  bell: '🔔',
  hay: '🌾',
  flower: '🌼',
}

const eventMessages: Record<GameEventKind, string> = {
  'fence-hit': 'bonk!',
  'mud-hit': 'squelch',
  'wolf-hit': 'eep!',
  bell: '+100',
  hay: 'zoom',
  flower: 'combo',
  finish: 'barn!',
}

export function getItemEmoji(kind: GameItemKind): string {
  return itemEmoji[kind]
}

export function laneToPercent(lane: Lane | number): number {
  if (lane >= 0.5) return 23
  if (lane <= -0.5) return 77
  return 50
}

export function nearestLane(value: number): Lane {
  if (value > 0.5) return 1
  if (value < -0.5) return -1
  return 0
}

export function distanceToScreenX(distance: number): number {
  const clampedDistance = Math.min(COURSE_LENGTH, Math.max(0, distance))
  const courseWidth = COURSE_END_X - COURSE_START_X
  return COURSE_START_X + (clampedDistance / COURSE_LENGTH) * courseWidth
}

export function makeCourseItems(): GameItem[] {
  const kinds: GameItemKind[] = ['fence', 'bell', 'mud', 'flower', 'wolf', 'hay']
  const items: GameItem[] = []

  for (let i = 0; i < 15; i += 1) {
    const distance = 300 + i * 170
    const kind = kinds[i % kinds.length]
    const lane = laneOrder[(i + Math.floor(i / 3)) % laneOrder.length]

    items.push({
      id: `${kind}-${i}`,
      kind,
      lane,
      distance,
      collectedOrHit: false,
      missed: false,
    })
  }

  items.push({
    id: 'final-bell',
    kind: 'bell',
    lane: 0,
    distance: COURSE_LENGTH - 160,
    collectedOrHit: false,
    missed: false,
  })

  return items
}

export function createInitialGameState(): GameState {
  return {
    elapsedMs: 0,
    progress: 0,
    finished: false,
    finishTimeMs: null,
    sheep: {
      lane: 0,
      targetLane: 0,
      lanePosition: 0,
      speed: BASE_SPEED,
      stunnedMs: 0,
      slowedMs: 0,
      boostMs: 0,
      tumbleMs: 0,
      score: 0,
      combo: 0,
    },
    items: makeCourseItems(),
    events: [],
  }
}

export function getCourseItems(state: GameState): Array<GameItem & { screenXPercent: number; emoji: string }> {
  return state.items
    .filter((item) => !item.collectedOrHit && !item.missed)
    .map((item) => ({
      ...item,
      screenXPercent: distanceToScreenX(item.distance),
      emoji: getItemEmoji(item.kind),
    }))
}

export function updateGameState(state: GameState, targetLane: Lane, dtMs: number): GameState {
  if (state.finished) return state

  const next: GameState = {
    ...state,
    elapsedMs: state.elapsedMs + dtMs,
    sheep: { ...state.sheep, targetLane },
    items: state.items.map((item) => ({ ...item })),
    events: state.events.filter((event) => state.elapsedMs + dtMs - event.createdAtMs < 1200),
  }

  next.sheep.stunnedMs = Math.max(0, next.sheep.stunnedMs - dtMs)
  next.sheep.slowedMs = Math.max(0, next.sheep.slowedMs - dtMs)
  next.sheep.boostMs = Math.max(0, next.sheep.boostMs - dtMs)
  next.sheep.tumbleMs = Math.max(0, next.sheep.tumbleMs - dtMs)

  const laneEase = Math.min(1, dtMs / 150)
  next.sheep.lanePosition += (targetLane - next.sheep.lanePosition) * laneEase
  next.sheep.lane = nearestLane(next.sheep.lanePosition)

  let speed = BASE_SPEED
  if (next.sheep.slowedMs > 0) speed *= 0.62
  if (next.sheep.boostMs > 0) speed *= 1.45
  if (next.sheep.stunnedMs > 0) speed *= 0.18

  next.sheep.speed = speed
  next.progress += (speed * dtMs) / 1000

  for (const item of next.items) {
    const passed = item.distance < next.progress - HIT_WINDOW
    if (!item.collectedOrHit && !item.missed && passed) {
      item.missed = true
      if (item.kind === 'bell' || item.kind === 'flower') {
        next.sheep.combo = 0
      }
    }

    const canCollide =
      !item.collectedOrHit &&
      !item.missed &&
      item.lane === next.sheep.lane &&
      Math.abs(item.distance - next.progress) <= HIT_WINDOW

    if (canCollide) {
      item.collectedOrHit = true
      applyItemEffect(next, item.kind)
    }
  }

  if (next.progress >= COURSE_LENGTH) {
    next.finished = true
    next.finishTimeMs = next.elapsedMs
    next.progress = COURSE_LENGTH
    next.sheep.score += Math.max(0, Math.round(1500 - next.elapsedMs / 60))
    addEvent(next, 'finish')
  }

  return next
}

function applyItemEffect(state: GameState, kind: GameItemKind): void {
  if (kind === 'fence') {
    state.sheep.tumbleMs = 700
    state.sheep.stunnedMs = Math.max(state.sheep.stunnedMs, 450)
    state.sheep.combo = 0
    state.sheep.score = Math.max(0, state.sheep.score - 25)
    addEvent(state, 'fence-hit')
    return
  }

  if (kind === 'mud') {
    state.sheep.slowedMs = Math.max(state.sheep.slowedMs, 1700)
    state.sheep.combo = 0
    addEvent(state, 'mud-hit')
    return
  }

  if (kind === 'wolf') {
    state.sheep.stunnedMs = Math.max(state.sheep.stunnedMs, 900)
    state.sheep.tumbleMs = 450
    state.progress = Math.max(0, state.progress - 35)
    state.sheep.combo = 0
    addEvent(state, 'wolf-hit')
    return
  }

  if (kind === 'bell') {
    state.sheep.combo += 1
    state.sheep.score += 100 + state.sheep.combo * 10
    addEvent(state, 'bell')
    return
  }

  if (kind === 'hay') {
    state.sheep.boostMs = Math.max(state.sheep.boostMs, 1800)
    state.sheep.score += 35
    addEvent(state, 'hay')
    return
  }

  state.sheep.combo += 1
  state.sheep.score += 60 + state.sheep.combo * 15
  addEvent(state, 'flower')
}

function addEvent(state: GameState, kind: GameEventKind): void {
  const event: GameEvent = {
    id: `${kind}-${state.elapsedMs}-${state.events.length}`,
    kind,
    message: eventMessages[kind],
    createdAtMs: state.elapsedMs,
  }

  state.events = [...state.events, event]
}
