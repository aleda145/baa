import { describe, expect, it } from 'vitest'
import { calculateVoicedThresholdRms, calculateVolumeLevel } from './microphone'

describe('microphone volume', () => {
  it('maps silence to zero loudness', () => {
    expect(calculateVolumeLevel(new Float32Array([0, 0, 0, 0]))).toBe(0)
  })

  it('maps stronger waveforms to higher loudness', () => {
    const quiet = calculateVolumeLevel(new Float32Array([0.01, -0.01, 0.01, -0.01]))
    const loud = calculateVolumeLevel(new Float32Array([0.4, -0.4, 0.4, -0.4]))

    expect(loud).toBeGreaterThan(quiet)
    expect(loud).toBeLessThanOrEqual(1)
  })

  it('lifts low RMS levels for mobile-friendly display', () => {
    const mobileLevel = calculateVolumeLevel(new Float32Array([0.012, -0.012, 0.012, -0.012]))

    expect(mobileLevel).toBeGreaterThan(0.2)
  })

  it('calculates and clamps adaptive voiced thresholds', () => {
    expect(calculateVoicedThresholdRms(0.002, 0.022)).toBeCloseTo(0.009)
    expect(calculateVoicedThresholdRms(0, 0.001)).toBe(0.003)
    expect(calculateVoicedThresholdRms(0.02, 0.2)).toBe(0.03)
  })
})
