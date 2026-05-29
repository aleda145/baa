import type { FerriteNoiseReducer } from "./ferriteNoise";

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

export type CalibrationBaaSource = {
  audioBuffer: AudioBuffer;
  blob?: Blob;
  basePitchHz: number;
  rms: number;
  confidence: number;
  voicedThresholdRms: number;
};

export const MIN_SAMPLES_FOR_BAATHOVEN = 1;

const NOTE_FADE_IN_SECONDS = 0.025;
const NOTE_FADE_OUT_SECONDS = 0.08;
const TRIM_THRESHOLD_RMS_MULTIPLIER = 0.08;
const TRIM_PRE_ROLL_SECONDS = 0.28;
const TRIM_TAIL_SECONDS = 0.16;

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

export function createCalibrationBaaSample(
  audioContext: AudioContext,
  noiseReducer: FerriteNoiseReducer | null,
  source: CalibrationBaaSource,
): BaaSample {
  const denoised =
    noiseReducer?.processAudioBuffer(audioContext, source.audioBuffer) ??
    source.audioBuffer;
  const audioBuffer = trimCalibrationBaa(
    audioContext,
    denoised,
    source.voicedThresholdRms,
  );

  return {
    id: createSampleId(),
    audioBuffer,
    blob: source.blob,
    basePitchHz: source.basePitchHz,
    midiNote: hzToMidi(source.basePitchHz),
    durationMs: audioBuffer.duration * 1000,
    rms: source.rms,
    confidence: source.confidence,
    createdAt: Date.now(),
  };
}

export function hzToMidi(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440));
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
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
  const shiftedSampleSeconds = sample.audioBuffer.duration / playbackRate;
  const audibleDurationSeconds = Math.min(
    shiftedSampleSeconds,
    Math.max(durationSeconds * 1.08, durationSeconds + 0.06),
  );
  const fadeOutSeconds = Math.min(NOTE_FADE_OUT_SECONDS, audibleDurationSeconds * 0.3);
  const fadeOutStart = Math.max(
    startTime + NOTE_FADE_IN_SECONDS,
    startTime + audibleDurationSeconds - fadeOutSeconds,
  );

  source.buffer = sample.audioBuffer;
  source.playbackRate.value = playbackRate;

  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.95, startTime + NOTE_FADE_IN_SECONDS);
  gain.gain.setValueAtTime(0.95, fadeOutStart);
  gain.gain.linearRampToValueAtTime(0, startTime + audibleDurationSeconds);

  source.connect(gain);
  gain.connect(audioContext.destination);

  source.start(startTime);
  source.stop(startTime + audibleDurationSeconds + 0.05);
}

export async function playBaathoven(
  audioContext: AudioContext,
  samples: BaaSample[],
  melody: MelodyNote[] = odeToJoy,
  bpm = 112,
): Promise<void> {
  if (samples.length === 0) {
    throw new Error("No baa sample available.");
  }

  if (audioContext.state !== "running") {
    await audioContext.resume();
  }

  const sample = findBestSingleBaa(samples);
  const beatSeconds = 60 / bpm;
  const playableMelody = transposeMelodyToBaa(sample, melody);
  let time = audioContext.currentTime + 0.2;

  logBaathovenStats([sample]);
  console.log("Baathoven playback", {
    mode: "single-calibration-baa",
    sampleId: sample.id,
    sampleMidi: sample.midiNote,
    sampleHz: Math.round(sample.basePitchHz),
    sampleDurationMs: Math.round(sample.durationMs),
    notes: playableMelody.length,
    bpm,
  });

  for (const note of playableMelody) {
    const durationSeconds = note.beats * beatSeconds;
    const playbackRate = 2 ** ((note.midi - sample.midiNote) / 12);

    console.log("Baathoven note", {
      targetMidi: note.midi,
      targetHz: Math.round(midiToHz(note.midi)),
      semitoneShift: note.midi - sample.midiNote,
      playbackRate: Number(playbackRate.toFixed(3)),
      durationSeconds,
    });

    playBaaNote(audioContext, sample, note.midi, time, durationSeconds);
    time += durationSeconds;
  }
}

export function logBaathovenStats(samples: BaaSample[]): void {
  console.log("Baathoven sample bank", {
    sampleCount: samples.length,
    unlocked: samples.length >= MIN_SAMPLES_FOR_BAATHOVEN,
    pitchHz: describeValues(samples.map((sample) => sample.basePitchHz)),
    midi: describeValues(samples.map((sample) => sample.midiNote)),
    durationMs: describeValues(samples.map((sample) => sample.durationMs)),
    bestSingleBaa: samples.length > 0 ? samples[0].id : null,
  });

  console.table(
    samples.map((sample) => ({
      id: sample.id,
      hz: Math.round(sample.basePitchHz),
      midi: sample.midiNote,
      durationMs: Math.round(sample.durationMs),
      confidence: Number(sample.confidence.toFixed(3)),
      rms: Number(sample.rms.toFixed(4)),
      best: true,
    })),
  );
}

function transposeMelodyToBaa(
  sample: BaaSample,
  melody: MelodyNote[],
): MelodyNote[] {
  const firstMelodyMidi = melody[0]?.midi ?? sample.midiNote;
  const transposition = sample.midiNote - firstMelodyMidi;
  const transposedMelody = melody.map((note) => ({
    ...note,
    midi: note.midi + transposition,
  }));

  console.log("Baathoven melody mapping", {
    mode: "first-note-to-calibration-baa",
    originalRange: describeValues(melody.map((note) => note.midi)),
    transposition,
    transposedRange: describeValues(transposedMelody.map((note) => note.midi)),
  });

  return transposedMelody;
}

function trimCalibrationBaa(
  audioContext: AudioContext,
  audioBuffer: AudioBuffer,
  voicedThresholdRms: number,
): AudioBuffer {
  const threshold = Math.max(0.00035, voicedThresholdRms * TRIM_THRESHOLD_RMS_MULTIPLIER);
  let start = 0;
  let end = audioBuffer.length - 1;

  while (start < end && framePeak(audioBuffer, start) < threshold) {
    start += 1;
  }

  while (end > start && framePeak(audioBuffer, end) < threshold) {
    end -= 1;
  }

  start = Math.max(0, start - Math.round(audioBuffer.sampleRate * TRIM_PRE_ROLL_SECONDS));
  end = Math.min(
    audioBuffer.length - 1,
    end + Math.round(audioBuffer.sampleRate * TRIM_TAIL_SECONDS),
  );

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

function findBestSingleBaa(samples: BaaSample[]): BaaSample {
  return samples.reduce((best, sample) =>
    scoreSingleBaa(sample) > scoreSingleBaa(best) ? sample : best,
  );
}

function scoreSingleBaa(sample: BaaSample): number {
  const confidenceScore = clamp((sample.confidence - 0.72) / 0.28, 0, 1);
  const durationScore = clamp(
    1 - Math.abs(Math.log2(sample.durationMs / 1700)) / 1.3,
    0,
    1,
  );
  const pitchScore = clamp(1 - Math.abs(sample.midiNote - 52) / 24, 0, 1);

  return confidenceScore * 0.48 + durationScore * 0.38 + pitchScore * 0.14;
}

function framePeak(audioBuffer: AudioBuffer, index: number): number {
  let peak = 0;
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    peak = Math.max(peak, Math.abs(audioBuffer.getChannelData(channel)[index]));
  }
  return peak;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createSampleId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `baa-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
