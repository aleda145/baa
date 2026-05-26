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
    private readonly analyser: AnalyserNode,
    private readonly detector: PitchDetector<Float32Array<ArrayBuffer>>,
    private readonly buffer: Float32Array<ArrayBuffer>,
  ) {}

  static async create(): Promise<MicrophonePitchController> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone input is not available in this browser.')
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })

    const audioContext = new AudioContext()
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = FFT_SIZE
    analyser.smoothingTimeConstant = 0

    const source = audioContext.createMediaStreamSource(stream)
    source.connect(analyser)

    const buffer: Float32Array<ArrayBuffer> = new Float32Array(
      new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
    )
    const detector = PitchDetector.forFloat32Array(buffer.length)

    return new MicrophonePitchController(stream, audioContext, analyser, detector, buffer)
  }

  async resume(): Promise<void> {
    if (this.audioContext.state !== 'running') {
      await this.audioContext.resume()
    }
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
    this.stream.getTracks().forEach((track) => track.stop())
    if (this.audioContext.state !== 'closed') {
      await this.audioContext.close()
    }
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
