import { PitchDetector } from 'pitchy'
import { MIN_CONFIDENCE, type PitchFrame, medianPitch } from './pitchLane'

const FFT_SIZE = 2048
const MIN_PITCH_HZ = 65
const MAX_PITCH_HZ = 1000

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

  async calibrate(durationMs = 1400): Promise<number | null> {
    await this.resume()

    return new Promise((resolve) => {
      const pitches: number[] = []
      const startedAt = performance.now()

      const tick = () => {
        const frame = this.samplePitch()
        if (frame.pitchHz !== null) {
          pitches.push(frame.pitchHz)
        }

        if (performance.now() - startedAt >= durationMs) {
          resolve(medianPitch(pitches))
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
