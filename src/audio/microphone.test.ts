import { describe, expect, it } from 'vitest'
import { calculateVolumeLevel } from './microphone'

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
})
