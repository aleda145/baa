import { PitchDetector } from 'pitchy'
import {
  MAX_PITCH_HZ,
  MIN_CONFIDENCE,
  MIN_PITCH_HZ,
  type PitchFrame,
} from './pitchLane'
import { FerriteNoiseReducer } from './ferriteNoise'

const FFT_SIZE = 2048
const CALIBRATION_HOLD_MS = 500
const CALIBRATION_TIMEOUT_MS = 9000
const CALIBRATION_SAMPLE_PREROLL_MS = 200
const CALIBRATION_SAMPLE_TAIL_MS = 220
const MIN_VOICED_THRESHOLD_RMS = 0.003
const MAX_VOICED_THRESHOLD_RMS = 0.03

type CalibrationOptions = {
  holdMs?: number
  timeoutMs?: number
  onProgress?: (progress: number) => void
  onFrame?: (frame: PitchFrame) => void
}

type NoiseLearningOptions = {
  durationMs?: number
  onProgress?: (progress: number) => void
  onFrame?: (frame: PitchFrame) => void
}

export type CalibrationResult = {
  measuredBaseHz: number
  voicedThresholdRms: number
  noiseFloorRms: number
  baaahRms: number
  confidence: number
  audioBuffer?: AudioBuffer
  blob?: Blob
}

type RecordedAudio = {
  audioBuffer: AudioBuffer
  blob: Blob
}

type ActiveRecording = {
  recorder: MediaRecorder
  chunks: Blob[]
}

type AudioCrop = {
  startMs: number
  endMs: number
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
  private noiseReducer: FerriteNoiseReducer | null = null

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

  getNoiseReducer(): FerriteNoiseReducer | null {
    return this.noiseReducer
  }

  async learnNoiseProfile({
    durationMs = 1200,
    onProgress,
    onFrame,
  }: NoiseLearningOptions = {}): Promise<boolean> {
    await resumeAudioContext(this.audioContext)

    try {
      this.noiseReducer?.dispose()
      this.noiseReducer = await FerriteNoiseReducer.create(this.audioContext.sampleRate)
    } catch (error) {
      console.warn('Ferrite noise reduction could not initialize', error)
      return false
    }

    const startedAt = performance.now()
    const chunks: Float32Array[] = []
    let totalLength = 0

    return new Promise((resolve) => {
      const tick = () => {
        this.analyser.getFloatTimeDomainData(this.buffer)
        const chunk = new Float32Array(this.buffer)
        chunks.push(chunk)
        totalLength += chunk.length

        const [pitchHz, confidence] = this.detector.findPitch(this.buffer, this.audioContext.sampleRate)
        const rawPitchHz = Number.isFinite(pitchHz) ? pitchHz : null
        const rawConfidence = Number.isFinite(confidence) ? confidence : 0
        onFrame?.({
          pitchHz: null,
          rawPitchHz,
          confidence: rawConfidence,
          rawConfidence,
          pitchStatus: getPitchStatus(rawPitchHz, rawConfidence),
          volume: calculateVolumeLevel(this.buffer),
          rms: calculateRms(this.buffer),
        })

        const elapsedMs = performance.now() - startedAt
        onProgress?.(Math.min(1, elapsedMs / durationMs))

        if (elapsedMs >= durationMs) {
          const noiseSamples = mergeChunks(chunks, totalLength)
          this.noiseReducer?.learnNoise(noiseSamples)
          resolve(true)
          return
        }

        requestAnimationFrame(tick)
      }

      tick()
    })
  }

  samplePitch(): PitchFrame {
    this.analyser.getFloatTimeDomainData(this.buffer)
    const analysisBuffer = this.noiseReducer?.processFrame(this.buffer) ?? this.buffer
    const [pitchHz, confidence] = this.detector.findPitch(analysisBuffer, this.audioContext.sampleRate)
    const rawPitchHz = Number.isFinite(pitchHz) ? pitchHz : null
    const rawConfidence = Number.isFinite(confidence) ? confidence : 0
    const rms = calculateRms(analysisBuffer)
    const volume = calculateVolumeLevel(analysisBuffer)
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
      const recording = this.startRecording()
      let settled = false
      let lastTickAt = startedAt
      let heldMs = 0
      let pitches: number[] = []
      const noiseRmsSamples: number[] = []
      let baaahRmsSamples: number[] = []
      let confidenceSamples: number[] = []
      let baaahStartedAt: number | null = null

      const finish = async (
        result: Omit<CalibrationResult, 'audioBuffer' | 'blob'> | null,
        crop?: AudioCrop,
      ) => {
        if (settled) return
        settled = true

        if (result !== null) {
          await sleep(CALIBRATION_SAMPLE_TAIL_MS)
        }

        const recordedAudio = await this.stopRecording(recording, crop)
        if (result === null) {
          resolve(null)
          return
        }

        resolve(recordedAudio === null ? result : { ...result, ...recordedAudio })
      }

      const tick = () => {
        if (settled) return

        const now = performance.now()
        const dtMs = now - lastTickAt
        lastTickAt = now
        const frame = this.samplePitch()
        onFrame?.(frame)
        const validBaaahPitch = frame.pitchHz

        if (validBaaahPitch) {
          if (heldMs === 0) {
            baaahStartedAt = now
          }
          heldMs += dtMs
          pitches.push(validBaaahPitch)
          baaahRmsSamples.push(frame.rms)
          confidenceSamples.push(frame.confidence)
        } else {
          heldMs = 0
          pitches = []
          baaahRmsSamples = []
          confidenceSamples = []
          baaahStartedAt = null
          noiseRmsSamples.push(frame.rms)
        }

        onProgress?.(Math.min(1, heldMs / holdMs))

        if (heldMs >= holdMs) {
          const noiseFloorRms = percentile(noiseRmsSamples, 0.5)
          const baaahRms = median(baaahRmsSamples)
          const cropStartMs = Math.max(
            0,
            (baaahStartedAt ?? now) - startedAt - CALIBRATION_SAMPLE_PREROLL_MS,
          )
          void finish(
            {
              measuredBaseHz: median(pitches),
              voicedThresholdRms: calculateVoicedThresholdRms(noiseFloorRms, baaahRms),
              noiseFloorRms,
              baaahRms,
              confidence: median(confidenceSamples),
            },
            {
              startMs: cropStartMs,
              endMs: now - startedAt + CALIBRATION_SAMPLE_TAIL_MS,
            },
          )
          return
        }

        if (now - startedAt >= timeoutMs) {
          void finish(null)
          return
        }

        requestAnimationFrame(tick)
      }

      tick()
    })
  }

  private startRecording(): ActiveRecording | null {
    try {
      const recorder = this.createMediaRecorder()
      const chunks: Blob[] = []

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data)
        }
      })

      recorder.start(100)
      return { recorder, chunks }
    } catch (error) {
      console.warn('Calibration baa recording could not start', error)
      return null
    }
  }

  private async stopRecording(
    recording: ActiveRecording | null,
    crop?: AudioCrop,
  ): Promise<RecordedAudio | null> {
    if (recording === null) return null

    const { recorder, chunks } = recording

    return new Promise((resolve) => {
      recorder.addEventListener(
        'stop',
        () => {
          void this.decodeRecording(chunks, recorder.mimeType, crop).then(resolve)
        },
        { once: true },
      )

      try {
        if (recorder.state !== 'inactive') {
          recorder.requestData()
          recorder.stop()
        } else {
          void this.decodeRecording(chunks, recorder.mimeType, crop).then(resolve)
        }
      } catch (error) {
        console.warn('Calibration baa recording could not stop', error)
        resolve(null)
      }
    })
  }

  private async decodeRecording(
    chunks: Blob[],
    mimeType: string,
    crop?: AudioCrop,
  ): Promise<RecordedAudio | null> {
    const blob = new Blob(chunks, { type: mimeType || 'audio/webm' })
    if (blob.size === 0) return null

    try {
      const decoded = await this.audioContext.decodeAudioData(await blob.arrayBuffer())
      return {
        blob,
        audioBuffer: crop ? cropAudioBuffer(this.audioContext, decoded, crop) : decoded,
      }
    } catch (error) {
      console.warn('Calibration baa recording could not decode', error)
      return null
    }
  }

  async close(): Promise<void> {
    this.source.disconnect()
    this.analyser.disconnect()
    this.silentOutput.disconnect()
    this.stream.getTracks().forEach((track) => track.stop())
    this.noiseReducer?.dispose()
    this.noiseReducer = null
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

function mergeChunks(chunks: Float32Array[], totalLength: number): Float32Array {
  const merged = new Float32Array(totalLength)
  let offset = 0

  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }

  return merged
}

function cropAudioBuffer(
  audioContext: AudioContext,
  audioBuffer: AudioBuffer,
  crop: AudioCrop,
): AudioBuffer {
  const startFrame = Math.max(
    0,
    Math.floor((crop.startMs / 1000) * audioBuffer.sampleRate),
  )
  const endFrame = Math.min(
    audioBuffer.length,
    Math.ceil((crop.endMs / 1000) * audioBuffer.sampleRate),
  )
  const length = Math.max(1, endFrame - startFrame)
  const cropped = audioContext.createBuffer(
    audioBuffer.numberOfChannels,
    length,
    audioBuffer.sampleRate,
  )

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    cropped.copyToChannel(
      audioBuffer.getChannelData(channel).subarray(startFrame, endFrame),
      channel,
    )
  }

  return cropped
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
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
