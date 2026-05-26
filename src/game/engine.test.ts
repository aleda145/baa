import { describe, expect, it } from 'vitest'
import {
  COURSE_END_X,
  COURSE_LENGTH,
  COURSE_START_X,
  createInitialGameState,
  distanceToScreenX,
  HIT_WINDOW,
  makeCourseItems,
  updateGameState,
} from './engine'
import type { GameState, Lane } from '../types'

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

  it('generates wolves only', () => {
    const items = makeCourseItems()

    expect(items).toHaveLength(3)
    expect(items.every((item) => item.kind === 'wolf')).toBe(true)
    expect(items.map((item) => item.lane).sort()).toEqual([-1, 0, 1])
  })

  it('moves the sheep toward the requested target lane', () => {
    const state = createInitialGameState()
    const next = updateGameState(state, 1, 100)

    expect(next.sheep.targetLane).toBe(1)
    expect(next.sheep.lanePosition).toBeGreaterThan(0)
    expect(next.progress).toBeGreaterThan(0)
  })

  it('only collides with items in the sheep lane', () => {
    const state = stateAtWolf(1)
    state.sheep.lane = 0
    state.sheep.lanePosition = 0

    const next = updateGameState(state, 0, 16)

    expect(next.items[0].collectedOrHit).toBe(false)
    expect(next.finished).toBe(false)
  })

  it('resets to the start when the sheep hits a wolf', () => {
    const next = updateGameState(stateAtWolf(), 0, 16)

    expect(next.finished).toBe(false)
    expect(next.outcome).toBe('running')
    expect(next.progress).toBe(0)
    expect(next.sheep.lane).toBe(0)
    expect(next.sheep.blinkMs).toBeGreaterThan(0)
    expect(next.items).toHaveLength(3)
  })

  it('wins when the sheep reaches the barn', () => {
    const state = createInitialGameState()
    state.progress = COURSE_LENGTH - 1
    state.items = []

    const next = updateGameState(state, 0, 1000)

    expect(next.finished).toBe(true)
    expect(next.outcome).toBe('won')
    expect(next.finishTimeMs).not.toBeNull()
    expect(next.progress).toBe(COURSE_LENGTH)
  })
})
