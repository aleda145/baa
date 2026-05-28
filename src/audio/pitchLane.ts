import type { InputState, Lane } from '../types'

export const MIN_CONFIDENCE = 0.72
export const LOW_THRESHOLD_SEMITONES = -1.5
export const HIGH_THRESHOLD_SEMITONES = 3
export const MIN_PITCH_HZ = 70
export const MAX_PITCH_HZ = 700
export const SOUND_GRACE_MS = 180
export const PITCH_SMOOTHING = 0.55
export const VOLUME_SMOOTHING = 0.28
export const MIN_METER_CHARGE_PER_SECOND = 2.4
export const MAX_METER_CHARGE_PER_SECOND = 7.2
export const METER_DECAY_PER_SECOND = 3.6

type LaneMeters = {
  bottom: number
  middle: number
  top: number
}

export type PitchFrame = {
  pitchHz: number | null
  rawPitchHz?: number | null
  confidence: number
  rawConfidence?: number
  pitchStatus?: InputState['pitchStatus']
  volume: number
  rms: number
}

export type PitchLaneFilterState = {
  measuredBaseHz: number
  voicedThresholdRms: number
  lane: Lane
  intentLane: Lane
  laneMeters: LaneMeters
  soundGraceMs: number
  smoothedPitchHz: number | null
  smoothedVolume: number
}

export function createPitchLaneFilter(
  measuredBaseHz: number,
  voicedThresholdRms: number,
): PitchLaneFilterState {
  return {
    measuredBaseHz,
    voicedThresholdRms,
    lane: 0,
    intentLane: 0,
    laneMeters: {
      bottom: 0,
      middle: 0,
      top: 0,
    },
    soundGraceMs: 0,
    smoothedPitchHz: null,
    smoothedVolume: 0,
  }
}

export function laneLabel(lane: Lane, voiced: boolean): InputState['label'] {
  if (!voiced) return '?'
  if (lane === 1) return '↑'
  if (lane === -1) return '↓'
  return '-'
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
  const semitones = semitonesFromCenter(freqHz, measuredBaseHz)

  if (semitones <= LOW_THRESHOLD_SEMITONES) return -1
  if (semitones >= HIGH_THRESHOLD_SEMITONES) return 1
  return 0
}

export function semitonesFromCenter(freqHz: number, measuredBaseHz: number): number {
  return semitonesFrom(freqHz, measuredBaseHz)
}

export type PitchIntent = {
  lane: Lane
  strength: number
  semitones: number
}

export function getPitchIntent(freqHz: number, measuredBaseHz: number): PitchIntent {
  const semitones = semitonesFromCenter(freqHz, measuredBaseHz)

  if (semitones >= HIGH_THRESHOLD_SEMITONES) {
    return {
      lane: 1,
      strength: clamp(0.35 + (semitones - HIGH_THRESHOLD_SEMITONES) / 4, 0.35, 1),
      semitones,
    }
  }

  if (semitones <= LOW_THRESHOLD_SEMITONES) {
    return {
      lane: -1,
      strength: clamp(0.35 + (LOW_THRESHOLD_SEMITONES - semitones) / 4, 0.35, 1),
      semitones,
    }
  }

  const lowSpan = Math.abs(LOW_THRESHOLD_SEMITONES)
  const highSpan = Math.abs(HIGH_THRESHOLD_SEMITONES)
  const span = semitones < 0 ? lowSpan : highSpan

  return {
    lane: 0,
    strength: clamp(1 - Math.abs(semitones) / span, 0.35, 1),
    semitones,
  }
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
  const previousLane = state.lane
  const validPitch = pitchInRange(frame.pitchHz)
  const confidentPitch = validPitch && frame.confidence >= MIN_CONFIDENCE
  const soundDetected = frame.rms >= state.voicedThresholdRms || confidentPitch
  state.soundGraceMs = soundDetected ? SOUND_GRACE_MS : Math.max(0, state.soundGraceMs - dtMs)
  const soundPresent = soundDetected || state.soundGraceMs > 0
  const voiced = confidentPitch && soundPresent
  let smoothedPitchHz = state.smoothedPitchHz
  let pitchOffsetSemitones: number | null = null
  const smoothedVolume =
    state.smoothedVolume * (1 - VOLUME_SMOOTHING) + frame.volume * VOLUME_SMOOTHING

  if (voiced && frame.pitchHz !== null) {
    smoothedPitchHz =
      smoothedPitchHz === null
        ? frame.pitchHz
        : smoothedPitchHz * (1 - PITCH_SMOOTHING) + frame.pitchHz * PITCH_SMOOTHING
  }

  let lane = state.lane
  let intentLane = state.intentLane
  let intentProgress = getMeter(state.laneMeters, intentLane)

  if (voiced && smoothedPitchHz !== null) {
    const intent = getPitchIntent(smoothedPitchHz, state.measuredBaseHz)
    intentLane = resolveStepwiseIntentLane(state.lane, intent.lane)
    pitchOffsetSemitones = intent.semitones

    chargeMeter(state.laneMeters, intentLane, intent.strength, dtMs)
    decayOtherMeters(state.laneMeters, intentLane, dtMs)
    intentProgress = getMeter(state.laneMeters, intentLane)

    if (intentProgress >= 1) {
      lane = intentLane
      resetMeters(state.laneMeters)
      intentProgress = 0
    }
  } else {
    decayOtherMeters(state.laneMeters, null, dtMs)
    intentProgress = 0
  }

  state.lane = lane
  state.intentLane = intentLane
  state.smoothedPitchHz = smoothedPitchHz
  state.smoothedVolume = smoothedVolume

  return {
    voiced,
    pitchHz: smoothedPitchHz,
    rawPitchHz: frame.rawPitchHz ?? frame.pitchHz,
    confidence: frame.confidence,
    rawConfidence: frame.rawConfidence ?? frame.confidence,
    pitchStatus: frame.pitchStatus ?? (frame.pitchHz === null ? 'none' : 'ok'),
    volume: smoothedVolume,
    lane,
    intentLane,
    intentProgress,
    pitchOffsetSemitones,
    label: movementLabel(previousLane, intentLane, voiced),
  }
}

function movementLabel(currentLane: Lane, intentLane: Lane, voiced: boolean): InputState['label'] {
  if (!voiced) return '?'
  if (intentLane > currentLane) return '↑'
  if (intentLane < currentLane) return '↓'
  return '-'
}

function chargeMeter(meters: LaneMeters, lane: Lane, strength: number, dtMs: number): void {
  const chargePerSecond =
    MIN_METER_CHARGE_PER_SECOND +
    (MAX_METER_CHARGE_PER_SECOND - MIN_METER_CHARGE_PER_SECOND) * strength
  setMeter(meters, lane, getMeter(meters, lane) + (chargePerSecond * dtMs) / 1000)
}

function resolveStepwiseIntentLane(currentLane: Lane, pitchIntentLane: Lane): Lane {
  if (pitchIntentLane === currentLane) return currentLane
  if (pitchIntentLane > currentLane) return (currentLane + 1) as Lane
  return (currentLane - 1) as Lane
}

function decayOtherMeters(meters: LaneMeters, exceptLane: Lane | null, dtMs: number): void {
  for (const lane of [-1, 0, 1] as const) {
    if (lane === exceptLane) continue
    setMeter(meters, lane, getMeter(meters, lane) - (METER_DECAY_PER_SECOND * dtMs) / 1000)
  }
}

function resetMeters(meters: LaneMeters): void {
  meters.bottom = 0
  meters.middle = 0
  meters.top = 0
}

function getMeter(meters: LaneMeters, lane: Lane): number {
  if (lane === -1) return meters.bottom
  if (lane === 1) return meters.top
  return meters.middle
}

function setMeter(meters: LaneMeters, lane: Lane, value: number): void {
  const clampedValue = clamp(value, 0, 1)
  if (lane === -1) {
    meters.bottom = clampedValue
    return
  }

  if (lane === 1) {
    meters.top = clampedValue
    return
  }

  meters.middle = clampedValue
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
