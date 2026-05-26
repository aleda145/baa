import { PitchDetector } from 'pitchy'
import {
  MAX_PITCH_HZ,
  MIN_CONFIDENCE,
  MIN_CONTROL_VOLUME,
  MIN_PITCH_HZ,
  type PitchFrame,
} from './pitchLane'

const FFT_SIZE = 2048
const CALIBRATION_HOLD_MS = 500
const CALIBRATION_TIMEOUT_MS = 9000

type CalibrationOptions = {
  holdMs?: number
  timeoutMs?: number
  onProgress?: (progress: number) => void
}

type AudioContextConstructor = typeof AudioContext

export function calculateVolumeLevel(buffer: Float32Array): number {
  let sumSquares = 0

  for (const sample of buffer) {
    sumSquares += sample * sample
  }

  const rms = Math.sqrt(sumSquares / buffer.length)
  return Math.min(1, Math.max(0, (rms - 0.005) * 7))
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

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    })

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

  samplePitch(): PitchFrame {
    this.analyser.getFloatTimeDomainData(this.buffer)
    const [pitchHz, confidence] = this.detector.findPitch(this.buffer, this.audioContext.sampleRate)
    const volume = calculateVolumeLevel(this.buffer)

    if (
      !Number.isFinite(pitchHz) ||
      pitchHz < MIN_PITCH_HZ ||
      pitchHz > MAX_PITCH_HZ ||
      confidence < MIN_CONFIDENCE
    ) {
      return { pitchHz: null, confidence, volume }
    }

    return { pitchHz, confidence, volume }
  }

  async calibrate({
    holdMs = CALIBRATION_HOLD_MS,
    timeoutMs = CALIBRATION_TIMEOUT_MS,
    onProgress,
  }: CalibrationOptions = {}): Promise<number | null> {
    await this.resume()

    return new Promise((resolve) => {
      const startedAt = performance.now()
      let lastTickAt = startedAt
      let heldMs = 0
      let pitches: number[] = []

      const tick = () => {
        const now = performance.now()
        const dtMs = now - lastTickAt
        lastTickAt = now
        const frame = this.samplePitch()

        if (frame.pitchHz !== null && frame.volume >= MIN_CONTROL_VOLUME) {
          heldMs += dtMs
          pitches.push(frame.pitchHz)
        } else {
          heldMs = 0
          pitches = []
        }

        onProgress?.(Math.min(1, heldMs / holdMs))

        if (heldMs >= holdMs) {
          resolve(median(pitches))
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
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
