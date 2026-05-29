import { MicrophonePitchController } from "./microphone";
import {
  MAX_PITCH_HZ,
  MIN_CONFIDENCE,
  MIN_PITCH_HZ,
  pitchInRange,
  type PitchFrame,
} from "./pitchLane";

export type BaaSample = {
  id: string;
  audioBuffer: AudioBuffer;
  blob?: Blob;
  basePitchHz: number;
  midiNote: number;
  durationMs: number;
  rms: number;
  confidence: number;
  createdAt: number;
};

export type MelodyNote = {
  midi: number;
  beats: number;
};

export const MIN_BAA_DURATION_MS = 250;
export const MAX_BAA_DURATION_MS = 2500;
export const MIN_VALID_FRAME_RATIO = 0.5;
export const MIN_SAMPLES_FOR_BAATHOVEN = 5;

const MIN_VALID_PITCH_FRAMES = 1;
const SAMPLE_END_GRACE_MS = 180;
const CLOSE_SAMPLE_WINDOW_SEMITONES = 1;

export const odeToJoy: MelodyNote[] = [
  { midi: 64, beats: 1 },
  { midi: 64, beats: 1 },
  { midi: 65, beats: 1 },
  { midi: 67, beats: 1 },

  { midi: 67, beats: 1 },
  { midi: 65, beats: 1 },
  { midi: 64, beats: 1 },
  { midi: 62, beats: 1 },

  { midi: 60, beats: 1 },
  { midi: 60, beats: 1 },
  { midi: 62, beats: 1 },
  { midi: 64, beats: 1 },

  { midi: 64, beats: 1.5 },
  { midi: 62, beats: 0.5 },
  { midi: 62, beats: 2 },
];

export class BaaSampleBank {
  private samples: BaaSample[] = [];

  add(sample: BaaSample): BaaSample[] {
    this.samples = [...this.samples, sample];
    return this.list();
  }

  list(): BaaSample[] {
    return [...this.samples];
  }

  clear(): void {
    this.samples = [];
  }

  findClosest(targetMidi: number): BaaSample {
    return findClosestBaa(this.samples, targetMidi);
  }

  groupByPitch(): Record<"low" | "medium" | "high", BaaSample[]> {
    return groupSamplesByPitch(this.samples);
  }
}

type CaptureOptions = {
  voicedThresholdRms: number;
  onSample: (sample: BaaSample) => void;
  onRejected?: (reason: string, summary: BaaCaptureSummary) => void;
};

type ActiveCapture = {
  recorder: MediaRecorder;
  startedAt: number;
  lastSoundAt: number;
  frames: PitchFrame[];
  chunks: Blob[];
};

type BaaCaptureSummary = {
  durationMs: number;
  frameCount: number;
  validFrameCount: number;
  validFrameRatio: number;
  medianPitchHz: number;
  medianConfidence: number;
  medianRms: number;
};

export class BaaSampleCapture {
  private activeCapture: ActiveCapture | null = null;
  private disposed = false;

  constructor(
    private readonly mic: MicrophonePitchController,
    private readonly options: CaptureOptions,
  ) {}

  observeFrame(frame: PitchFrame, now = performance.now()): void {
    if (this.disposed || !this.isSupported()) return;

    const validPitch = isValidPitchFrame(frame);
    const soundPresent = frame.rms >= this.options.voicedThresholdRms || validPitch;

    if (!this.activeCapture && validPitch && frame.rms >= this.options.voicedThresholdRms) {
      this.startCapture(now);
    }

    if (!this.activeCapture) return;

    this.activeCapture.frames.push(frame);

    if (soundPresent) {
      this.activeCapture.lastSoundAt = now;
    }

    const durationMs = now - this.activeCapture.startedAt;
    const silenceMs = now - this.activeCapture.lastSoundAt;
    if (durationMs >= MAX_BAA_DURATION_MS || silenceMs >= SAMPLE_END_GRACE_MS) {
      this.stopCapture(now);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.activeCapture) {
      this.stopCapture(performance.now());
    }
  }

  private isSupported(): boolean {
    return typeof MediaRecorder !== "undefined";
  }

  private startCapture(now: number): void {
    try {
      const recorder = this.mic.createMediaRecorder();
      const capture: ActiveCapture = {
        recorder,
        startedAt: now,
        lastSoundAt: now,
        frames: [],
        chunks: [],
      };

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          capture.chunks.push(event.data);
        }
      });

      recorder.addEventListener(
        "stop",
        () => {
          void this.finishCapture(capture, performance.now());
        },
        { once: true },
      );

      recorder.start();
      this.activeCapture = capture;
    } catch (error) {
      console.warn("Baathoven sample capture could not start", error);
    }
  }

  private stopCapture(endedAt: number): void {
    const capture = this.activeCapture;
    if (!capture) return;

    this.activeCapture = null;
    capture.frames.push({
      pitchHz: null,
      confidence: 0,
      volume: 0,
      rms: 0,
    });

    try {
      if (capture.recorder.state !== "inactive") {
        capture.recorder.stop();
      } else {
        void this.finishCapture(capture, endedAt);
      }
    } catch (error) {
      console.warn("Baathoven sample capture could not stop", error);
    }
  }

  private async finishCapture(capture: ActiveCapture, endedAt: number): Promise<void> {
    try {
      const sample = await buildBaaSample(
        this.mic.getAudioContext(),
        capture,
        endedAt,
        this.options.voicedThresholdRms,
      );

      if (sample.result === "accepted") {
        this.options.onSample(sample.sample);
      } else {
        this.options.onRejected?.(sample.reason, sample.summary);
      }
    } catch (error) {
      console.warn("Baathoven sample capture could not decode", error);
    }
  }
}

export function hzToMidi(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440));
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function findClosestBaa(samples: BaaSample[], targetMidi: number): BaaSample {
  if (samples.length === 0) {
    throw new Error("No baa samples available.");
  }

  const bestDistance = samples.reduce(
    (distance, sample) => Math.min(distance, Math.abs(sample.midiNote - targetMidi)),
    Number.POSITIVE_INFINITY,
  );
  const candidates = samples.filter(
    (sample) =>
      Math.abs(sample.midiNote - targetMidi) <=
      bestDistance + CLOSE_SAMPLE_WINDOW_SEMITONES,
  );

  return candidates[Math.floor(Math.random() * candidates.length)];
}

export function playBaaNote(
  audioContext: AudioContext,
  sample: BaaSample,
  targetMidi: number,
  startTime: number,
  durationSeconds: number,
): void {
  const source = audioContext.createBufferSource();
  const gain = audioContext.createGain();
  const playbackRate = 2 ** ((targetMidi - sample.midiNote) / 12);
  const detuneCents = Math.random() * 14 - 7;

  source.buffer = sample.audioBuffer;
  source.playbackRate.value = playbackRate;
  source.detune.value = detuneCents;

  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.95, startTime + 0.02);
  gain.gain.setValueAtTime(0.95, Math.max(startTime + 0.02, startTime + durationSeconds - 0.04));
  gain.gain.linearRampToValueAtTime(0, startTime + durationSeconds);

  source.connect(gain);
  gain.connect(audioContext.destination);

  source.start(startTime);
  source.stop(startTime + durationSeconds + 0.1);
}

export async function playBaathoven(
  audioContext: AudioContext,
  samples: BaaSample[],
  melody: MelodyNote[] = odeToJoy,
  bpm = 120,
): Promise<void> {
  if (samples.length === 0) {
    throw new Error("No baa samples available.");
  }

  if (audioContext.state !== "running") {
    await audioContext.resume();
  }

  logBaathovenStats(samples);

  const beatSeconds = 60 / bpm;
  const playableMelody = transposeMelodyToSampleRange(melody, samples);
  let time = audioContext.currentTime + 0.2;

  console.log("Baathoven playback", {
    notes: playableMelody.length,
    bpm,
    beatSeconds,
    firstStartTime: time,
  });

  for (const note of playableMelody) {
    const sample = findClosestBaa(samples, note.midi);
    const durationSeconds = note.beats * beatSeconds;

    console.log("Baathoven note", {
      targetMidi: note.midi,
      targetHz: Math.round(midiToHz(note.midi)),
      sampleId: sample.id,
      sampleMidi: sample.midiNote,
      sampleHz: Math.round(sample.basePitchHz),
      semitoneShift: note.midi - sample.midiNote,
      durationSeconds,
    });

    playBaaNote(audioContext, sample, note.midi, time, durationSeconds);

    time += durationSeconds;
  }
}

export function logBaathovenStats(samples: BaaSample[]): void {
  const mids = samples.map((sample) => sample.midiNote);
  const pitches = samples.map((sample) => sample.basePitchHz);
  const durations = samples.map((sample) => sample.durationMs);
  const groups = groupSamplesByPitch(samples);
  const midiDistribution = mids.reduce<Record<string, number>>((distribution, midi) => {
    distribution[midi] = (distribution[midi] ?? 0) + 1;
    return distribution;
  }, {});

  console.log("Baathoven sample bank", {
    sampleCount: samples.length,
    unlocked: samples.length >= MIN_SAMPLES_FOR_BAATHOVEN,
    midiDistribution,
    lanes: {
      low: groups.low.length,
      medium: groups.medium.length,
      high: groups.high.length,
    },
    pitchHz: describeValues(pitches),
    midi: describeValues(mids),
    durationMs: describeValues(durations),
  });

  console.table(
    samples.map((sample) => ({
      id: sample.id,
      hz: Math.round(sample.basePitchHz),
      midi: sample.midiNote,
      durationMs: Math.round(sample.durationMs),
      confidence: Number(sample.confidence.toFixed(3)),
      rms: Number(sample.rms.toFixed(4)),
    })),
  );
}

function isValidPitchFrame(frame: PitchFrame): boolean {
  return (
    pitchInRange(frame.pitchHz) &&
    frame.confidence >= MIN_CONFIDENCE
  );
}

async function buildBaaSample(
  audioContext: AudioContext,
  capture: ActiveCapture,
  endedAt: number,
  voicedThresholdRms: number,
): Promise<
  | { result: "accepted"; sample: BaaSample }
  | { result: "rejected"; reason: string; summary: BaaCaptureSummary }
> {
  const validFrames = capture.frames.filter(
    (frame) => isValidPitchFrame(frame) && frame.rms >= voicedThresholdRms,
  );
  const summary = summarizeCapture(capture.frames, validFrames, endedAt - capture.startedAt);

  const rejectedReason = getRejectionReason(summary);
  if (rejectedReason) {
    return { result: "rejected", reason: rejectedReason, summary };
  }

  const blob = new Blob(capture.chunks, {
    type: capture.recorder.mimeType || "audio/webm",
  });

  if (blob.size === 0) {
    return { result: "rejected", reason: "empty-audio-blob", summary };
  }

  const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
  const audioBuffer = trimAudioBuffer(audioContext, decoded, voicedThresholdRms);
  const durationMs = audioBuffer.duration * 1000;

  if (durationMs < MIN_BAA_DURATION_MS) {
    return { result: "rejected", reason: "decoded-audio-too-short", summary };
  }

  return {
    result: "accepted",
    sample: {
      id: createSampleId(),
      audioBuffer,
      blob,
      basePitchHz: summary.medianPitchHz,
      midiNote: hzToMidi(summary.medianPitchHz),
      durationMs,
      rms: summary.medianRms,
      confidence: summary.medianConfidence,
      createdAt: Date.now(),
    },
  };
}

function getRejectionReason(summary: BaaCaptureSummary): string | null {
  if (summary.durationMs < MIN_BAA_DURATION_MS) return "too-short";
  if (summary.validFrameCount < MIN_VALID_PITCH_FRAMES) return "not-enough-valid-pitch";
  if (summary.medianConfidence < MIN_CONFIDENCE) return "low-confidence";
  if (summary.medianPitchHz < MIN_PITCH_HZ) return "pitch-too-low";
  if (summary.medianPitchHz > MAX_PITCH_HZ) return "pitch-too-high";
  return null;
}

function summarizeCapture(
  frames: PitchFrame[],
  validFrames: PitchFrame[],
  durationMs: number,
): BaaCaptureSummary {
  const voicedFrames = frames.filter((frame) => frame.rms > 0);
  const validFrameRatio =
    voicedFrames.length === 0 ? 0 : validFrames.length / voicedFrames.length;

  return {
    durationMs,
    frameCount: frames.length,
    validFrameCount: validFrames.length,
    validFrameRatio,
    medianPitchHz: median(validFrames.map((frame) => frame.pitchHz ?? 0)),
    medianConfidence: median(validFrames.map((frame) => frame.confidence)),
    medianRms: median(validFrames.map((frame) => frame.rms)),
  };
}

function transposeMelodyToSampleRange(
  melody: MelodyNote[],
  samples: BaaSample[],
): MelodyNote[] {
  const melodyCenter = median(melody.map((note) => note.midi));
  const sampleCenter = median(samples.map((sample) => sample.midiNote));
  const transposition = Math.round(sampleCenter - melodyCenter);
  const transposedMelody = melody.map((note) => ({
    ...note,
    midi: note.midi + transposition,
  }));
  const originalRange = describeValues(melody.map((note) => note.midi));
  const transposedRange = describeValues(transposedMelody.map((note) => note.midi));

  console.log("Baathoven melody mapping", {
    originalRange,
    sampleMidiCenter: sampleCenter,
    transposition,
    transposedRange,
  });

  return transposedMelody;
}

function trimAudioBuffer(
  audioContext: AudioContext,
  audioBuffer: AudioBuffer,
  voicedThresholdRms: number,
): AudioBuffer {
  const threshold = Math.max(0.002, voicedThresholdRms * 0.45);
  let start = 0;
  let end = audioBuffer.length - 1;

  while (start < end && framePeak(audioBuffer, start) < threshold) {
    start += 1;
  }

  while (end > start && framePeak(audioBuffer, end) < threshold) {
    end -= 1;
  }

  const paddingFrames = Math.round(audioBuffer.sampleRate * 0.025);
  start = Math.max(0, start - paddingFrames);
  end = Math.min(audioBuffer.length - 1, end + paddingFrames);

  const trimmedLength = Math.max(1, end - start + 1);
  const trimmedBuffer = audioContext.createBuffer(
    audioBuffer.numberOfChannels,
    trimmedLength,
    audioBuffer.sampleRate,
  );

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const source = audioBuffer.getChannelData(channel).subarray(start, end + 1);
    trimmedBuffer.copyToChannel(source, channel);
  }

  return trimmedBuffer;
}

function framePeak(audioBuffer: AudioBuffer, index: number): number {
  let peak = 0;
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    peak = Math.max(peak, Math.abs(audioBuffer.getChannelData(channel)[index]));
  }
  return peak;
}

function groupSamplesByPitch(samples: BaaSample[]): Record<"low" | "medium" | "high", BaaSample[]> {
  if (samples.length === 0) {
    return { low: [], medium: [], high: [] };
  }

  const midiNotes = samples.map((sample) => sample.midiNote);
  const minMidi = Math.min(...midiNotes);
  const maxMidi = Math.max(...midiNotes);
  const span = Math.max(1, maxMidi - minMidi);
  const lowCutoff = minMidi + span / 3;
  const highCutoff = minMidi + (span * 2) / 3;

  return samples.reduce<Record<"low" | "medium" | "high", BaaSample[]>>(
    (groups, sample) => {
      if (sample.midiNote <= lowCutoff) {
        groups.low.push(sample);
      } else if (sample.midiNote >= highCutoff) {
        groups.high.push(sample);
      } else {
        groups.medium.push(sample);
      }

      return groups;
    },
    { low: [], medium: [], high: [] },
  );
}

function describeValues(values: number[]): { min: number; median: number; max: number } | null {
  if (values.length === 0) return null;

  return {
    min: Math.round(Math.min(...values)),
    median: Math.round(median(values)),
    max: Math.round(Math.max(...values)),
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.5)];
}

function createSampleId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `baa-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
