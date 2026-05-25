import { describe, expect, it } from 'vitest'
import { COURSE_LENGTH, createInitialGameState, HIT_WINDOW, updateGameState } from './engine'
import type { GameItemKind, GameState, Lane } from '../types'

function stateAtItem(kind: GameItemKind, lane: Lane = 0): GameState {
  const state = createInitialGameState()
  state.progress = 100
  state.sheep.lane = lane
  state.sheep.lanePosition = lane
  state.sheep.targetLane = lane
  state.items = [
    {
      id: kind,
      kind,
      lane,
      distance: state.progress + HIT_WINDOW - 1,
      collectedOrHit: false,
      missed: false,
    },
  ]
  return state
}

describe('runner engine', () => {
  it('moves the sheep toward the requested target lane', () => {
    const state = createInitialGameState()
    const next = updateGameState(state, 1, 100)

    expect(next.sheep.targetLane).toBe(1)
    expect(next.sheep.lanePosition).toBeGreaterThan(0)
    expect(next.progress).toBeGreaterThan(0)
  })

  it('only collides with items in the sheep lane', () => {
    const state = stateAtItem('fence', 1)
    state.sheep.lane = 0
    state.sheep.lanePosition = 0

    const next = updateGameState(state, 0, 16)

    expect(next.items[0].collectedOrHit).toBe(false)
    expect(next.sheep.tumbleMs).toBe(0)
  })

  it('applies obstacle penalties and collectible rewards', () => {
    const fence = updateGameState(stateAtItem('fence'), 0, 16)
    expect(fence.items[0].collectedOrHit).toBe(true)
    expect(fence.sheep.stunnedMs).toBeGreaterThan(0)

    const bell = updateGameState(stateAtItem('bell'), 0, 16)
    expect(bell.sheep.score).toBeGreaterThanOrEqual(100)

    const hay = updateGameState(stateAtItem('hay'), 0, 16)
    expect(hay.sheep.boostMs).toBeGreaterThan(0)
  })

  it('finishes at the barn and awards a completion bonus', () => {
    const state = createInitialGameState()
    state.progress = COURSE_LENGTH - 1
    state.items = []

    const next = updateGameState(state, 0, 1000)

    expect(next.finished).toBe(true)
    expect(next.finishTimeMs).not.toBeNull()
    expect(next.progress).toBe(COURSE_LENGTH)
    expect(next.sheep.score).toBeGreaterThan(0)
  })
})
