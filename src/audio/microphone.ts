import { PitchDetector } from 'pitchy'
import {
  MAX_PITCH_HZ,
  MIN_CONFIDENCE,
  MIN_PITCH_HZ,
  type PitchFrame,
} from './pitchLane'

const FFT_SIZE = 2048
const CALIBRATION_HOLD_MS = 500
const CALIBRATION_TIMEOUT_MS = 9000
const MIN_VOICED_THRESHOLD_RMS = 0.003
const MAX_VOICED_THRESHOLD_RMS = 0.03

type CalibrationOptions = {
  holdMs?: number
  timeoutMs?: number
  onProgress?: (progress: number) => void
  onFrame?: (frame: PitchFrame) => void
}

export type CalibrationResult = {
  measuredBaseHz: number
  voicedThresholdRms: number
  noiseFloorRms: number
  baaahRms: number
}

type AudioContextConstructor = typeof AudioContext

export function calculateRms(buffer: Float32Array): number {
  let sumSquares = 0

  for (const sample of buffer) {
    sumSquares += sample * sample
  }

  return Math.sqrt(sumSquares / buffer.length)
}

export function calculateVolumeLevel(buffer: Float32Array): number {
  const rms = calculateRms(buffer)
  const linearLevel = Math.min(1, Math.max(0, (rms - 0.005) * 7))
  return Math.sqrt(linearLevel)
}

export function calculateVoicedThresholdRms(noiseFloorRms: number, baaahRms: number): number {
  const threshold = noiseFloorRms + (baaahRms - noiseFloorRms) * 0.35
  return Math.min(MAX_VOICED_THRESHOLD_RMS, Math.max(MIN_VOICED_THRESHOLD_RMS, threshold))
}

export class MicrophonePitchController {
  private constructor(
    private readonly stream: MediaStream,
    private readonly audioContext: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly analyser: AnalyserNode,
    private readonly silentOutput: GainNode,
    private readonly detector: PitchDetector<Float32Array<ArrayBuffer>>,
    private readonly buffer: Float32Array<ArrayBuffer>,
  ) {}

  static async create(): Promise<MicrophonePitchController> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone input is not available in this browser.')
    }

    const AudioContextClass = getAudioContextConstructor()
    const audioContext = new AudioContextClass()
    await resumeAudioContext(audioContext)

    const supportedConstraints = navigator.mediaDevices.getSupportedConstraints()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: makeAudioConstraints(supportedConstraints),
    })
    const [track] = stream.getAudioTracks()
    console.info('Baaah supported media constraints', supportedConstraints)
    console.info('Baaah microphone track settings', track?.getSettings())

    const analyser = audioContext.createAnalyser()
    analyser.fftSize = FFT_SIZE
    analyser.smoothingTimeConstant = 0

    const source = audioContext.createMediaStreamSource(stream)
    const silentOutput = audioContext.createGain()
    silentOutput.gain.value = 0

    source.connect(analyser)
    analyser.connect(silentOutput)
    silentOutput.connect(audioContext.destination)
    await resumeAudioContext(audioContext)

    const buffer: Float32Array<ArrayBuffer> = new Float32Array(
      new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
    )
    const detector = PitchDetector.forFloat32Array(buffer.length)

    return new MicrophonePitchController(
      stream,
      audioContext,
      source,
      analyser,
      silentOutput,
      detector,
      buffer,
    )
  }

  async resume(): Promise<void> {
    await resumeAudioContext(this.audioContext)
  }

  getAudioContext(): AudioContext {
    return this.audioContext
  }

  createMediaRecorder(): MediaRecorder {
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('Audio recording is not available in this browser.')
    }

    const mimeType = getPreferredRecordingMimeType()
    return new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
  }

  samplePitch(): PitchFrame {
    this.analyser.getFloatTimeDomainData(this.buffer)
    const [pitchHz, confidence] = this.detector.findPitch(this.buffer, this.audioContext.sampleRate)
    const rawPitchHz = Number.isFinite(pitchHz) ? pitchHz : null
    const rawConfidence = Number.isFinite(confidence) ? confidence : 0
    const rms = calculateRms(this.buffer)
    const volume = calculateVolumeLevel(this.buffer)
    const pitchStatus = getPitchStatus(rawPitchHz, rawConfidence)

    if (pitchStatus !== 'ok') {
      return {
        pitchHz: null,
        rawPitchHz,
        confidence: rawConfidence,
        rawConfidence,
        pitchStatus,
        volume,
        rms,
      }
    }

    return {
      pitchHz: rawPitchHz,
      rawPitchHz,
      confidence: rawConfidence,
      rawConfidence,
      pitchStatus,
      volume,
      rms,
    }
  }

  async calibrate({
    holdMs = CALIBRATION_HOLD_MS,
    timeoutMs = CALIBRATION_TIMEOUT_MS,
    onProgress,
    onFrame,
  }: CalibrationOptions = {}): Promise<CalibrationResult | null> {
    await this.resume()

    return new Promise((resolve) => {
      const startedAt = performance.now()
      let lastTickAt = startedAt
      let heldMs = 0
      let pitches: number[] = []
      const noiseRmsSamples: number[] = []
      let baaahRmsSamples: number[] = []

      const tick = () => {
        const now = performance.now()
        const dtMs = now - lastTickAt
        lastTickAt = now
        const frame = this.samplePitch()
        onFrame?.(frame)
        const validBaaahPitch = frame.pitchHz

        if (validBaaahPitch) {
          heldMs += dtMs
          pitches.push(validBaaahPitch)
          baaahRmsSamples.push(frame.rms)
        } else {
          heldMs = 0
          pitches = []
          baaahRmsSamples = []
          noiseRmsSamples.push(frame.rms)
        }

        onProgress?.(Math.min(1, heldMs / holdMs))

        if (heldMs >= holdMs) {
          const noiseFloorRms = percentile(noiseRmsSamples, 0.5)
          const baaahRms = median(baaahRmsSamples)
          resolve({
            measuredBaseHz: median(pitches),
            voicedThresholdRms: calculateVoicedThresholdRms(noiseFloorRms, baaahRms),
            noiseFloorRms,
            baaahRms,
          })
          return
        }

        if (now - startedAt >= timeoutMs) {
          resolve(null)
          return
        }

        requestAnimationFrame(tick)
      }

      tick()
    })
  }

  async close(): Promise<void> {
    this.source.disconnect()
    this.analyser.disconnect()
    this.silentOutput.disconnect()
    this.stream.getTracks().forEach((track) => track.stop())
    if (this.audioContext.state !== 'closed') {
      await this.audioContext.close()
    }
  }
}

function getPitchStatus(
  pitchHz: number | null,
  confidence: number,
): PitchFrame['pitchStatus'] {
  if (pitchHz === null) return 'none'
  if (pitchHz < MIN_PITCH_HZ) return 'too-low'
  if (pitchHz > MAX_PITCH_HZ) return 'too-high'
  if (confidence < MIN_CONFIDENCE) return 'low-confidence'
  return 'ok'
}

function makeAudioConstraints(supportedConstraints: MediaTrackSupportedConstraints): MediaTrackConstraints {
  return {
    ...(supportedConstraints.echoCancellation ? { echoCancellation: false } : {}),
    ...(supportedConstraints.noiseSuppression ? { noiseSuppression: false } : {}),
    ...(supportedConstraints.autoGainControl ? { autoGainControl: false } : {}),
  }
}

function getPreferredRecordingMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ]

  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType))
}

async function resumeAudioContext(audioContext: AudioContext): Promise<void> {
  if (audioContext.state !== 'running') {
    await audioContext.resume()
  }
}

function getAudioContextConstructor(): AudioContextConstructor {
  const audioWindow = window as typeof window & {
    webkitAudioContext?: AudioContextConstructor
  }

  const AudioContextClass = audioWindow.AudioContext ?? audioWindow.webkitAudioContext
  if (!AudioContextClass) {
    throw new Error('Web Audio is not available in this browser.')
  }

  return AudioContextClass
}

function median(values: number[]): number {
  return percentile(values, 0.5)
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) * ratio)]
}
