import type { GameEvent, GameEventKind, GameItem, GameState, Lane } from '../types'

export const COURSE_LENGTH = 3000
export const COURSE_START_X = 7
export const COURSE_END_X = 93
export const BASE_SPEED = 600
export const HIT_WINDOW = 24
export const LANE_EASE_MS = 210

const laneOrder: Lane[] = [1, 0, -1]

const eventMessages: Record<GameEventKind, string> = {
  'wolf-hit': 'Again!',
  finish: 'barn!',
}

export function laneToPercent(lane: Lane | number): number {
  if (lane >= 0.5) return 32
  if (lane <= -0.5) return 68
  return 50
}

export function lanePositionToPercent(lanePosition: number): number {
  return Math.min(68, Math.max(32, 50 - lanePosition * 18))
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
  const wolves: Array<{ id: string; lane: Lane; distance: number }> = [
    { id: 'wolf-top', lane: 1, distance: 920 },
    { id: 'wolf-bottom', lane: -1, distance: 1700 },
    { id: 'wolf-middle', lane: 0, distance: 2440 },
  ]

  return wolves.map((wolf) => ({
    ...wolf,
    kind: 'wolf',
    collectedOrHit: false,
    missed: false,
  }))
}

export function createInitialGameState(): GameState {
  return {
    elapsedMs: 0,
    progress: 0,
    finished: false,
    outcome: 'running',
    finishTimeMs: null,
    sheep: {
      lane: 0,
      targetLane: 0,
      lanePosition: 0,
      speed: BASE_SPEED,
      tumbleMs: 0,
      blinkMs: 0,
    },
    items: makeCourseItems(),
    events: [],
  }
}

export function createPracticeGameState(): GameState {
  return {
    ...createInitialGameState(),
    items: [],
  }
}

export function getCourseItems(state: GameState): Array<GameItem & { screenXPercent: number }> {
  return state.items
    .filter((item) => !item.collectedOrHit)
    .map((item) => ({
      ...item,
      screenXPercent: distanceToScreenX(item.distance),
    }))
}

export function updatePracticeGameState(state: GameState, targetLane: Lane, dtMs: number): GameState {
  const next: GameState = {
    ...state,
    elapsedMs: state.elapsedMs + dtMs,
    sheep: { ...state.sheep, targetLane },
    items: [],
    events: [],
    finished: false,
    outcome: 'running',
    finishTimeMs: null,
  }

  next.sheep.tumbleMs = Math.max(0, next.sheep.tumbleMs - dtMs)
  next.sheep.blinkMs = Math.max(0, next.sheep.blinkMs - dtMs)

  const laneEase = 1 - Math.exp(-dtMs / LANE_EASE_MS)
  next.sheep.lanePosition += (targetLane - next.sheep.lanePosition) * laneEase
  next.sheep.lane = nearestLane(next.sheep.lanePosition)
  next.sheep.speed = BASE_SPEED

  next.progress += (BASE_SPEED * dtMs) / 1000
  if (next.progress >= COURSE_LENGTH) {
    next.progress %= COURSE_LENGTH
  }

  return next
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

  next.sheep.tumbleMs = Math.max(0, next.sheep.tumbleMs - dtMs)
  next.sheep.blinkMs = Math.max(0, next.sheep.blinkMs - dtMs)

  const laneEase = 1 - Math.exp(-dtMs / LANE_EASE_MS)
  next.sheep.lanePosition += (targetLane - next.sheep.lanePosition) * laneEase
  next.sheep.lane = nearestLane(next.sheep.lanePosition)

  next.sheep.speed = BASE_SPEED
  next.progress += (BASE_SPEED * dtMs) / 1000

  for (const item of next.items) {
    const passed = item.distance < next.progress - HIT_WINDOW
    if (!item.collectedOrHit && !item.missed && passed) {
      item.missed = true
    }

    const canCollide =
      !item.collectedOrHit &&
      !item.missed &&
      item.lane === next.sheep.lane &&
      Math.abs(item.distance - next.progress) <= HIT_WINDOW

    if (canCollide) {
      next.progress = 0
      next.items = makeCourseItems()
      next.sheep.lane = 0
      next.sheep.targetLane = 0
      next.sheep.lanePosition = 0
      next.sheep.tumbleMs = 900
      next.sheep.blinkMs = 1200
      addEvent(next, 'wolf-hit')
      return next
    }
  }

  if (next.progress >= COURSE_LENGTH) {
    next.finished = true
    next.outcome = 'won'
    next.finishTimeMs = next.elapsedMs
    next.progress = COURSE_LENGTH
    addEvent(next, 'finish')
  }

  return next
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
