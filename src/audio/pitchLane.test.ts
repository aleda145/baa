import { describe, expect, it } from 'vitest'
import {
  classifyPitch,
  createPitchLaneFilter,
  getPitchIntent,
  pitchInRange,
  pitchToLane,
  updatePitchLaneFilter,
} from './pitchLane'

describe('pitch lane classification', () => {
  const voicedThresholdRms = 0.01

  it('classifies pitch relative to the measured baseline', () => {
    const measuredBaseHz = 100

    expect(pitchToLane(91, measuredBaseHz)).toBe(-1)
    expect(pitchToLane(100, measuredBaseHz)).toBe(0)
    expect(pitchToLane(112, measuredBaseHz)).toBe(0)
    expect(pitchToLane(120, measuredBaseHz)).toBe(1)
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

  it('charges the lane meter faster for stronger pitch differences', () => {
    const filter = createPitchLaneFilter(100, voicedThresholdRms)

    const moderateHigh = updatePitchLaneFilter(
      filter,
      { pitchHz: 125, confidence: 0.95, volume: 0.4, rms: 0.05 },
      100,
    )

    const strongerFilter = createPitchLaneFilter(100, voicedThresholdRms)
    const strongerHigh = updatePitchLaneFilter(
      strongerFilter,
      { pitchHz: 220, confidence: 0.95, volume: 0.4, rms: 0.05 },
      100,
    )

    expect(strongerHigh.intentProgress).toBeGreaterThan(moderateHigh.intentProgress)
    expect(strongerHigh.label).toBe('↑')
  })

  it('switches lanes when the pitch intent meter fills', () => {
    const filter = createPitchLaneFilter(100, voicedThresholdRms)

    const highStable = updatePitchLaneFilter(
      filter,
      { pitchHz: 220, confidence: 0.95, volume: 0.4, rms: 0.05 },
      150,
    )
    expect(highStable.lane).toBe(1)
  })

  it('keeps moderate pitch from switching instantly', () => {
    const filter = createPitchLaneFilter(100, voicedThresholdRms)

    const highNotInstant = updatePitchLaneFilter(
      filter,
      { pitchHz: 150, confidence: 0.95, volume: 0.4, rms: 0.05 },
      100,
    )

    expect(highNotInstant.lane).toBe(0)
    expect(highNotInstant.intentProgress).toBeGreaterThan(0)
  })

  it('moves from bottom toward high pitch through the middle lane first', () => {
    const filter = createPitchLaneFilter(100, voicedThresholdRms)
    filter.lane = -1
    filter.intentLane = -1

    const highFromBottom = updatePitchLaneFilter(
      filter,
      { pitchHz: 220, confidence: 0.95, volume: 0.4, rms: 0.05 },
      150,
    )

    expect(highFromBottom.intentLane).toBe(0)
    expect(highFromBottom.lane).toBe(0)
  })

  it('moves from top toward low pitch through the middle lane first', () => {
    const filter = createPitchLaneFilter(100, voicedThresholdRms)
    filter.lane = 1
    filter.intentLane = 1

    const lowFromTop = updatePitchLaneFilter(
      filter,
      { pitchHz: 70, confidence: 0.95, volume: 0.4, rms: 0.05 },
      150,
    )

    expect(lowFromTop.intentLane).toBe(0)
    expect(lowFromTop.lane).toBe(0)
  })

  it('shows down when middle pitch moves from top toward middle', () => {
    const filter = createPitchLaneFilter(100, voicedThresholdRms)
    filter.lane = 1
    filter.intentLane = 1

    const middleFromTop = updatePitchLaneFilter(
      filter,
      { pitchHz: 112, confidence: 0.95, volume: 0.4, rms: 0.05 },
      150,
    )

    expect(middleFromTop.intentLane).toBe(0)
    expect(middleFromTop.label).toBe('↓')
  })

  it('shows dash only when staying in the middle lane', () => {
    const filter = createPitchLaneFilter(100, voicedThresholdRms)

    const middle = updatePitchLaneFilter(
      filter,
      { pitchHz: 112, confidence: 0.95, volume: 0.4, rms: 0.05 },
      150,
    )

    expect(middle.intentLane).toBe(0)
    expect(middle.label).toBe('-')
  })

  it('charges middle fastest when pitch is near the measured baseline', () => {
    const centered = getPitchIntent(100, 100)
    const nearEdge = getPitchIntent(112, 100)

    expect(centered.lane).toBe(0)
    expect(nearEdge.lane).toBe(0)
    expect(centered.strength).toBeGreaterThan(nearEdge.strength)
  })

  it('reports smoothed volume without changing pitch classification rules', () => {
    const filter = createPitchLaneFilter(200, voicedThresholdRms)
    const quiet = updatePitchLaneFilter(filter, { pitchHz: null, confidence: 0, volume: 0.5, rms: 0.05 }, 16)

    expect(quiet.lane).toBe(0)
    expect(quiet.pitchHz).toBeNull()
    expect(quiet.volume).toBeGreaterThan(0)
  })

  it('does not expose stale current pitch when input stops being valid', () => {
    const filter = createPitchLaneFilter(100, voicedThresholdRms)

    const voiced = updatePitchLaneFilter(
      filter,
      { pitchHz: 100, confidence: 0.95, volume: 0.5, rms: 0.05 },
      100,
    )
    const silent = updatePitchLaneFilter(
      filter,
      { pitchHz: null, confidence: 0, volume: 0, rms: 0 },
      250,
    )

    expect(voiced.pitchHz).toBeGreaterThan(0)
    expect(silent.pitchHz).toBeNull()
  })

  it('still reacts to confident pitch when RMS is below the adaptive threshold', () => {
    const filter = createPitchLaneFilter(100, voicedThresholdRms)
    filter.lane = -1
    filter.intentLane = -1

    const lowRmsHigh = updatePitchLaneFilter(
      filter,
      { pitchHz: 150, confidence: 0.96, volume: 0.8, rms: 0.002 },
      200,
    )

    expect(lowRmsHigh.intentLane).toBe(0)
    expect(lowRmsHigh.voiced).toBe(true)
    expect(lowRmsHigh.label).toBe('↑')
  })

  it('does not react when both RMS and pitch confidence are low', () => {
    const filter = createPitchLaneFilter(100, voicedThresholdRms)

    const unclear = updatePitchLaneFilter(
      filter,
      { pitchHz: 150, confidence: 0.2, volume: 0.8, rms: 0.002 },
      200,
    )

    expect(unclear.voiced).toBe(false)
    expect(unclear.label).toBe('?')
  })

  it('keeps sound active briefly after RMS drops', () => {
    const filter = createPitchLaneFilter(100, voicedThresholdRms)

    updatePitchLaneFilter(filter, { pitchHz: 150, confidence: 0.96, volume: 0.5, rms: 0.05 }, 100)
    const graceFrame = updatePitchLaneFilter(
      filter,
      { pitchHz: 150, confidence: 0.96, volume: 0.2, rms: 0.001 },
      100,
    )

    expect(graceFrame.voiced).toBe(true)
  })
})
