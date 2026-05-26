import type { InputState, Lane } from '../types'

export const MIN_CONFIDENCE = 0.72
export const CENTER_SHIFT_SEMITONES = 2
export const LOW_THRESHOLD_SEMITONES = -2
export const HIGH_THRESHOLD_SEMITONES = 3
export const MIN_PITCH_HZ = 70
export const MAX_PITCH_HZ = 700
export const LANE_STABILITY_MS = 100
export const PITCH_SMOOTHING = 0.35
export const VOLUME_SMOOTHING = 0.28
export const MIN_CONTROL_VOLUME = 0.08

export type PitchFrame = {
  pitchHz: number | null
  confidence: number
  volume: number
}

export type PitchLaneFilterState = {
  measuredBaseHz: number
  lane: Lane
  candidateLane: Lane
  candidateStableMs: number
  smoothedPitchHz: number | null
  smoothedVolume: number
}

export function createPitchLaneFilter(measuredBaseHz: number): PitchLaneFilterState {
  return {
    measuredBaseHz,
    lane: 0,
    candidateLane: 0,
    candidateStableMs: 0,
    smoothedPitchHz: null,
    smoothedVolume: 0,
  }
}

export function laneLabel(lane: Lane, voiced: boolean): InputState['label'] {
  if (!voiced) return '?'
  if (lane === 1) return 'BAA↑'
  if (lane === -1) return 'BAA↓'
  return 'baa'
}

export function shiftHzBySemitones(hz: number, semitones: number): number {
  return hz * Math.pow(2, semitones / 12)
}

export function semitonesFrom(freqHz: number, refHz: number): number {
  return 12 * Math.log2(freqHz / refHz)
}

export function pitchInRange(freqHz: number | null): freqHz is number {
  return freqHz !== null && freqHz >= MIN_PITCH_HZ && freqHz <= MAX_PITCH_HZ
}

export function pitchToLane(freqHz: number, measuredBaseHz: number): Lane {
  const centerHz = shiftHzBySemitones(measuredBaseHz, CENTER_SHIFT_SEMITONES)
  const semitones = semitonesFrom(freqHz, centerHz)

  if (semitones <= LOW_THRESHOLD_SEMITONES) return -1
  if (semitones >= HIGH_THRESHOLD_SEMITONES) return 1
  return 0
}

export function classifyPitch(
  measuredBaseHz: number,
  pitchHz: number | null,
  confidence: number,
  previousLane: Lane,
): Lane {
  if (!pitchInRange(pitchHz) || confidence < MIN_CONFIDENCE) return previousLane
  return pitchToLane(pitchHz, measuredBaseHz)
}

export function updatePitchLaneFilter(
  state: PitchLaneFilterState,
  frame: PitchFrame,
  dtMs: number,
): InputState {
  const loudEnough = frame.volume >= MIN_CONTROL_VOLUME
  const validPitch = pitchInRange(frame.pitchHz)
  const voiced = validPitch && frame.confidence >= MIN_CONFIDENCE && loudEnough
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
  const candidateLane = voiced
    ? classifyPitch(state.measuredBaseHz, smoothedPitchHz, frame.confidence, state.lane)
    : state.lane

  if (candidateLane !== state.candidateLane) {
    state.candidateLane = candidateLane
    state.candidateStableMs = dtMs
  } else {
    state.candidateStableMs += dtMs
  }

  if (candidateLane !== state.lane && state.candidateStableMs >= LANE_STABILITY_MS) {
    lane = candidateLane
  }

  state.lane = lane
  state.smoothedPitchHz = smoothedPitchHz
  state.smoothedVolume = smoothedVolume

  return {
    voiced,
    pitchHz: smoothedPitchHz,
    confidence: frame.confidence,
    volume: smoothedVolume,
    lane,
    label: laneLabel(lane, voiced),
  }
}
