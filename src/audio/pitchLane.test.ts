import { describe, expect, it } from 'vitest'
import { classifyPitch, createPitchLaneFilter, updatePitchLaneFilter } from './pitchLane'

describe('pitch lane classification', () => {
  it('classifies pitch relative to the calibrated baseline', () => {
    expect(classifyPitch(200, 240, 0.9, 0)).toBe(1)
    expect(classifyPitch(200, 200, 0.9, 1)).toBe(0)
    expect(classifyPitch(200, 160, 0.9, 0)).toBe(-1)
  })

  it('keeps the previous lane when pitch confidence is low', () => {
    expect(classifyPitch(200, 260, 0.2, -1)).toBe(-1)
    expect(classifyPitch(200, null, 0, 1)).toBe(1)
  })

  it('smooths and rate limits lane changes', () => {
    const filter = createPitchLaneFilter(200)

    const high = updatePitchLaneFilter(filter, { pitchHz: 255, confidence: 0.95, volume: 0.4 }, 200)
    expect(high.lane).toBe(1)

    const lowTooSoon = updatePitchLaneFilter(filter, { pitchHz: 130, confidence: 0.95, volume: 0.4 }, 16)
    expect(lowTooSoon.lane).toBe(1)
  })

  it('reports smoothed volume without changing pitch classification rules', () => {
    const filter = createPitchLaneFilter(200)
    const quiet = updatePitchLaneFilter(filter, { pitchHz: null, confidence: 0, volume: 0.5 }, 16)

    expect(quiet.lane).toBe(0)
    expect(quiet.volume).toBeGreaterThan(0)
  })
})
