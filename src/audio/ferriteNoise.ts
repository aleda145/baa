type FerriteNoiseReducerModule = {
  default: (wasmUrl?: string) => Promise<unknown>;
  NoiseReducer: new (sampleRate: number) => FerriteNoiseReducerInstance;
};

type FerriteNoiseReducerInstance = {
  free?: () => void;
  learn_noise: (noiseSamples: Float32Array) => void;
  process: (input: Float32Array) => Float32Array;
  set_bypass?: (bypass: boolean) => void;
  set_gate_enabled?: (enabled: boolean) => void;
  set_reduction_amount?: (amount: number) => void;
  set_spectral_enabled?: (enabled: boolean) => void;
  set_wiener_filter_mode?: (enabled: boolean) => void;
};

const FERRITE_WASM_URL = "/wasm/wasm_audio_ferrite_bg.wasm";
const LIVE_DENOISE_AMOUNT = 1;
const SAMPLE_DENOISE_WET_MIX = 1;

let ferriteModulePromise: Promise<FerriteNoiseReducerModule> | null = null;

export class FerriteNoiseReducer {
  private learnedNoise = false;

  private constructor(private readonly reducer: FerriteNoiseReducerInstance) {}

  static async create(sampleRate: number): Promise<FerriteNoiseReducer> {
    const module = await loadFerriteModule();
    const reducer = new module.NoiseReducer(sampleRate);

    reducer.set_bypass?.(false);
    reducer.set_spectral_enabled?.(true);
    reducer.set_gate_enabled?.(false);
    reducer.set_wiener_filter_mode?.(true);
    reducer.set_reduction_amount?.(LIVE_DENOISE_AMOUNT);

    return new FerriteNoiseReducer(reducer);
  }

  learnNoise(noiseSamples: Float32Array): void {
    if (noiseSamples.length === 0) return;

    this.reducer.learn_noise(noiseSamples);
    this.learnedNoise = true;
    console.log("Ferrite learned noise profile", {
      samples: noiseSamples.length,
      rms: Number(calculateRms(noiseSamples).toFixed(5)),
    });
  }

  processFrame(input: Float32Array): Float32Array {
    if (!this.learnedNoise) return input;

    try {
      return this.reducer.process(input);
    } catch (error) {
      console.warn("Ferrite frame processing failed; using raw audio", error);
      return input;
    }
  }

  processAudioBuffer(audioContext: AudioContext, inputBuffer: AudioBuffer): AudioBuffer {
    if (!this.learnedNoise) return inputBuffer;

    const outputBuffer = audioContext.createBuffer(
      inputBuffer.numberOfChannels,
      inputBuffer.length,
      inputBuffer.sampleRate,
    );

    for (let channel = 0; channel < inputBuffer.numberOfChannels; channel += 1) {
      const input = inputBuffer.getChannelData(channel);
      const denoised = this.processFrame(input);
      const output = blendSignals(input, denoised, SAMPLE_DENOISE_WET_MIX);
      outputBuffer.copyToChannel(new Float32Array(output), channel);
    }

    return outputBuffer;
  }

  dispose(): void {
    this.reducer.free?.();
  }
}

function blendSignals(
  dry: Float32Array,
  wet: Float32Array,
  wetMix: number,
): Float32Array {
  const output = new Float32Array(dry.length);
  const dryMix = 1 - wetMix;

  for (let index = 0; index < output.length; index += 1) {
    output[index] = dry[index] * dryMix + (wet[index] ?? 0) * wetMix;
  }

  return output;
}

async function loadFerriteModule(): Promise<FerriteNoiseReducerModule> {
  if (!ferriteModulePromise) {
    ferriteModulePromise = import("./vendor/wasm_audio_ferrite.js").then(
      async (module: FerriteNoiseReducerModule) => {
        await module.default(FERRITE_WASM_URL);
        return module;
      },
    );
  }

  return ferriteModulePromise;
}

function calculateRms(buffer: Float32Array): number {
  let sumSquares = 0;

  for (const sample of buffer) {
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / buffer.length);
}
