import { describe, expect, it } from 'vitest'
import {
  COURSE_END_X,
  COURSE_LENGTH,
  COURSE_START_X,
  createInitialGameState,
  createPracticeGameState,
  distanceToScreenX,
  getCourseItems,
  HIT_WINDOW,
  lanePositionToPercent,
  updateGameState,
  updatePracticeGameState,
} from './engine'
import { getLevel } from './levels'
import type { GameState, Lane } from '../types'

const levelOne = getLevel(1)
const levelTwo = getLevel(2)

function stateAtWolf(lane: Lane = 0): GameState {
  const state = createInitialGameState()
  state.progress = 100
  state.sheep.lane = lane
  state.sheep.lanePosition = lane
  state.sheep.targetLane = lane
  state.items = [
    {
      id: 'wolf',
      kind: 'wolf',
      lane,
      distance: state.progress + HIT_WINDOW - 1,
      collectedOrHit: false,
      missed: false,
    },
  ]
  return state
}

describe('runner engine', () => {
  it('maps the whole course into fixed screen coordinates', () => {
    expect(distanceToScreenX(0)).toBe(COURSE_START_X)
    expect(distanceToScreenX(COURSE_LENGTH)).toBe(COURSE_END_X)
    expect(distanceToScreenX(COURSE_LENGTH / 2)).toBe((COURSE_START_X + COURSE_END_X) / 2)
  })

  it('maps continuous lane positions into continuous screen Y coordinates', () => {
    expect(lanePositionToPercent(1)).toBe(32)
    expect(lanePositionToPercent(0)).toBe(50)
    expect(lanePositionToPercent(-1)).toBe(68)
    expect(lanePositionToPercent(0.5)).toBe(41)
  })

  it('keeps level one item-free', () => {
    expect(levelOne.createItems()).toHaveLength(0)
  })

  it('generates wolves for level two', () => {
    const items = levelTwo.createItems()

    expect(items).toHaveLength(3)
    expect(items.every((item) => item.kind === 'wolf')).toBe(true)
    expect(items.map((item) => item.lane).sort()).toEqual([-1, 0, 1])
  })

  it('moves the sheep toward the requested target lane', () => {
    const state = createInitialGameState()
    const next = updateGameState(state, 1, 100, levelOne)

    expect(next.sheep.targetLane).toBe(1)
    expect(next.sheep.lanePosition).toBeGreaterThan(0)
    expect(next.progress).toBeGreaterThan(0)
  })

  it('loops practice runs without finishing or adding wolves', () => {
    const state = createPracticeGameState()
    state.progress = COURSE_LENGTH - 1
    state.sheep.lane = -1
    state.sheep.lanePosition = -1

    const next = updatePracticeGameState(state, -1, 1000)

    expect(next.finished).toBe(false)
    expect(next.items).toHaveLength(0)
    expect(next.progress).toBeLessThan(COURSE_LENGTH)
    expect(next.sheep.lane).toBe(-1)
  })

  it('only collides with items in the sheep lane', () => {
    const state = stateAtWolf(1)
    state.sheep.lane = 0
    state.sheep.lanePosition = 0

    const next = updateGameState(state, 0, 16, levelTwo)

    expect(next.items[0].collectedOrHit).toBe(false)
    expect(next.finished).toBe(false)
  })

  it('keeps passed wolves visible on the course', () => {
    const state = stateAtWolf(1)
    state.items[0].distance = state.progress - HIT_WINDOW - 1
    state.items[0].missed = true

    const visibleItems = getCourseItems(state)

    expect(visibleItems).toHaveLength(1)
    expect(visibleItems[0].id).toBe('wolf')
  })

  it('resets to the start when the sheep hits a wolf', () => {
    const next = updateGameState(stateAtWolf(), 0, 16, levelTwo)

    expect(next.finished).toBe(false)
    expect(next.outcome).toBe('running')
    expect(next.progress).toBe(0)
    expect(next.sheep.lane).toBe(0)
    expect(next.sheep.blinkMs).toBeGreaterThan(0)
    expect(next.items).toHaveLength(3)
  })

  it('wins when the sheep reaches the wheat', () => {
    const state = createInitialGameState()
    state.progress = COURSE_LENGTH - 1
    state.sheep.lane = 1
    state.sheep.lanePosition = 1
    state.sheep.targetLane = 1
    state.items = []

    const next = updateGameState(state, 1, 1000, levelOne)

    expect(next.finished).toBe(true)
    expect(next.outcome).toBe('won')
    expect(next.finishTimeMs).not.toBeNull()
    expect(next.progress).toBe(COURSE_LENGTH)
  })

  it('loops when the sheep reaches the end outside the wheat lane', () => {
    const state = createInitialGameState()
    state.progress = COURSE_LENGTH - 1
    state.sheep.lane = 0
    state.sheep.lanePosition = 0
    state.sheep.targetLane = 0
    state.items = state.items.map((item) => ({ ...item, missed: true }))

    const next = updateGameState(state, 0, 1000, levelOne)

    expect(next.finished).toBe(false)
    expect(next.outcome).toBe('running')
    expect(next.progress).toBeLessThan(COURSE_LENGTH)
    expect(next.sheep.lane).toBe(0)
    expect(next.items.every((item) => !item.missed)).toBe(true)
  })
})
