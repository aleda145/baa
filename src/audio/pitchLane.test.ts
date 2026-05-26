import { describe, expect, it } from 'vitest'
import {
  classifyPitch,
  createPitchLaneFilter,
  pitchInRange,
  pitchToLane,
  shiftHzBySemitones,
  updatePitchLaneFilter,
} from './pitchLane'

describe('pitch lane classification', () => {
  it('classifies pitch relative to a semitone-shifted center', () => {
    const measuredBaseHz = 100
    const centerHz = shiftHzBySemitones(measuredBaseHz, 2)

    expect(centerHz).toBeCloseTo(112.25, 2)
    expect(pitchToLane(100, measuredBaseHz)).toBe(-1)
    expect(pitchToLane(112, measuredBaseHz)).toBe(0)
    expect(pitchToLane(134, measuredBaseHz)).toBe(1)
  })

  it('keeps the previous lane when pitch confidence is low', () => {
    expect(classifyPitch(100, 160, 0.2, -1)).toBe(-1)
    expect(classifyPitch(100, null, 0, 1)).toBe(1)
  })

  it('ignores pitches outside the usable range', () => {
    expect(pitchInRange(70)).toBe(true)
    expect(pitchInRange(700)).toBe(true)
    expect(pitchInRange(69)).toBe(false)
    expect(pitchInRange(701)).toBe(false)
  })

  it('requires a lane to stay stable before switching', () => {
    const filter = createPitchLaneFilter(100)

    const highTooSoon = updatePitchLaneFilter(filter, { pitchHz: 150, confidence: 0.95, volume: 0.4 }, 50)
    expect(highTooSoon.lane).toBe(0)

    const highStable = updatePitchLaneFilter(filter, { pitchHz: 150, confidence: 0.95, volume: 0.4 }, 50)
    expect(highStable.lane).toBe(1)
  })

  it('reports smoothed volume without changing pitch classification rules', () => {
    const filter = createPitchLaneFilter(200)
    const quiet = updatePitchLaneFilter(filter, { pitchHz: null, confidence: 0, volume: 0.5 }, 16)

    expect(quiet.lane).toBe(0)
    expect(quiet.volume).toBeGreaterThan(0)
  })

  it('does not change lanes when loudness is too low', () => {
    const filter = createPitchLaneFilter(100)
    filter.lane = -1
    filter.candidateLane = -1

    const quietHigh = updatePitchLaneFilter(filter, { pitchHz: 150, confidence: 0.96, volume: 0.02 }, 200)

    expect(quietHigh.lane).toBe(-1)
    expect(quietHigh.voiced).toBe(false)
    expect(quietHigh.label).toBe('?')
  })
})
