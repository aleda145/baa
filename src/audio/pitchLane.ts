import type { InputState, Lane } from '../types'

export const MIN_CONFIDENCE = 0.72
export const HIGH_PITCH_RATIO = 1.18
export const LOW_PITCH_RATIO = 0.85
export const LANE_CHANGE_COOLDOWN_MS = 120
export const PITCH_SMOOTHING = 0.35
export const VOLUME_SMOOTHING = 0.28

export type PitchFrame = {
  pitchHz: number | null
  confidence: number
  volume: number
}

export type PitchLaneFilterState = {
  baselineHz: number
  lane: Lane
  smoothedPitchHz: number | null
  smoothedVolume: number
  cooldownMs: number
}

export function createPitchLaneFilter(baselineHz: number): PitchLaneFilterState {
  return {
    baselineHz,
    lane: 0,
    smoothedPitchHz: null,
    smoothedVolume: 0,
    cooldownMs: 0,
  }
}

export function laneLabel(lane: Lane, voiced: boolean): InputState['label'] {
  if (!voiced) return '?'
  if (lane === 1) return 'BAA↑'
  if (lane === -1) return 'BAA↓'
  return 'baa'
}

export function classifyPitch(
  baselineHz: number,
  pitchHz: number | null,
  confidence: number,
  previousLane: Lane,
): Lane {
  if (pitchHz === null || confidence < MIN_CONFIDENCE) return previousLane

  if (pitchHz >= baselineHz * HIGH_PITCH_RATIO) return 1
  if (pitchHz <= baselineHz * LOW_PITCH_RATIO) return -1
  return 0
}

export function updatePitchLaneFilter(
  state: PitchLaneFilterState,
  frame: PitchFrame,
  dtMs: number,
): InputState {
  const previousLane = state.lane
  const voiced = frame.pitchHz !== null && frame.confidence >= MIN_CONFIDENCE
  const nextCooldownMs = Math.max(0, state.cooldownMs - dtMs)
  let smoothedPitchHz = state.smoothedPitchHz
  const smoothedVolume =
    state.smoothedVolume * (1 - VOLUME_SMOOTHING) + frame.volume * VOLUME_SMOOTHING

  if (voiced && frame.pitchHz !== null) {
    smoothedPitchHz =
      smoothedPitchHz === null
        ? frame.pitchHz
        : smoothedPitchHz * (1 - PITCH_SMOOTHING) + frame.pitchHz * PITCH_SMOOTHING
  }

  let lane = state.lane
  const candidateLane = classifyPitch(state.baselineHz, smoothedPitchHz, frame.confidence, state.lane)

  if (nextCooldownMs === 0 && candidateLane !== state.lane) {
    lane = candidateLane
  }

  state.lane = lane
  state.smoothedPitchHz = smoothedPitchHz
  state.smoothedVolume = smoothedVolume
  state.cooldownMs = lane !== previousLane ? LANE_CHANGE_COOLDOWN_MS : nextCooldownMs

  return {
    voiced,
    pitchHz: smoothedPitchHz,
    confidence: frame.confidence,
    volume: smoothedVolume,
    lane,
    label: laneLabel(lane, voiced),
  }
}

export function medianPitch(pitches: number[]): number | null {
  if (pitches.length === 0) return null
  const sorted = [...pitches].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
