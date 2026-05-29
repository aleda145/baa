import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Mic, Music, Volume2 } from "lucide-react";
import notoHeartUrl from "../assets/noto-heart.svg";
import notoSheepUrl from "../assets/noto-sheep.svg";
import notoWheatUrl from "../assets/noto-wheat.svg";
import notoWolfUrl from "../assets/noto-wolf.svg";
import {
  BaaSampleBank,
  BaaSampleCapture,
  MIN_SAMPLES_FOR_BAATHOVEN,
  logBaathovenStats,
  playBaathoven,
  type BaaSample,
} from "../audio/baathoven";
import { MicrophonePitchController } from "../audio/microphone";
import {
  HIGH_THRESHOLD_SEMITONES,
  LOW_THRESHOLD_SEMITONES,
  createPitchLaneFilter,
  updatePitchLaneFilter,
  type PitchFrame,
} from "../audio/pitchLane";
import {
  COURSE_LENGTH,
  createInitialGameState,
  createPracticeGameState,
  distanceToScreenX,
  getCourseItems,
  lanePositionToPercent,
  laneToPercent,
  updateGameState,
  updatePracticeGameState,
} from "../game/engine";
import { getLevel, getNextLevel, type LevelDefinition } from "../game/levels";
import type { GameState, InputState, Lane } from "../types";

type Screen =
  | "intro"
  | "learning-noise"
  | "calibrating"
  | "onboarding"
  | "running"
  | "results"
  | "error";
type OnboardingStep = "low" | "high" | "ready";

const idleInput: InputState = {
  voiced: false,
  pitchHz: null,
  rawPitchHz: null,
  confidence: 0,
  rawConfidence: 0,
  pitchStatus: "none",
  volume: 0,
  lane: 0,
  intentLane: 0,
  intentProgress: 0,
  pitchOffsetSemitones: null,
  label: "?",
};

const CONTROL_TICK_MS = 100;
const ONBOARDING_HINT_MS = 5200;
const ONBOARDING_HOLD_MS = 500;
const ONBOARDING_READY_MS = 1000;
const LEVEL_FINISH_DELAY_MS = 750;

function inputFromPitchFrame(frame: PitchFrame): InputState {
  const voiced = frame.pitchHz !== null;

  return {
    voiced,
    pitchHz: frame.pitchHz,
    rawPitchHz: frame.rawPitchHz ?? frame.pitchHz,
    confidence: frame.confidence,
    rawConfidence: frame.rawConfidence ?? frame.confidence,
    pitchStatus: frame.pitchStatus ?? (frame.pitchHz === null ? "none" : "ok"),
    volume: frame.volume,
    lane: 0,
    intentLane: 0,
    intentProgress: 0,
    pitchOffsetSemitones: null,
    label: voiced ? "-" : "?",
  };
}

export function App() {
  const micRef = useRef<MicrophonePitchController | null>(null);
  const previewGameRef = useRef<GameState>(createPracticeGameState());
  const [screen, setScreen] = useState<Screen>("intro");
  const [measuredBaseHz, setMeasuredBaseHz] = useState<number | null>(null);
  const [lowBaaHz, setLowBaaHz] = useState<number | null>(null);
  const [highBaaHz, setHighBaaHz] = useState<number | null>(null);
  const [voicedThresholdRms, setVoicedThresholdRms] = useState<number | null>(
    null,
  );
  const [setupInput, setSetupInput] = useState<InputState>(idleInput);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [currentLevelId, setCurrentLevelId] = useState(1);
  const [message, setMessage] = useState("");
  const retryTimerRef = useRef<number | null>(null);
  const autoMicStartedRef = useRef(false);
  const baaSampleBankRef = useRef(new BaaSampleBank());
  const [baaSamples, setBaaSamples] = useState<BaaSample[]>([]);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
      void micRef.current?.close();
    };
  }, []);

  const requestMic = async () => {
    setMessage("");
    setSetupInput(idleInput);
    setLowBaaHz(null);
    setHighBaaHz(null);
    try {
      const mic = await MicrophonePitchController.create();
      micRef.current = mic;
      await learnNoise(mic);
      await calibrate(mic);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not open the microphone.",
      );
      setScreen("error");
    }
  };

  const onBaaSample = useCallback((sample: BaaSample) => {
    const samples = baaSampleBankRef.current.add(sample);
    setBaaSamples(samples);
    console.log("Baathoven accepted baa sample", {
      id: sample.id,
      pitchHz: Math.round(sample.basePitchHz),
      midiNote: sample.midiNote,
      durationMs: Math.round(sample.durationMs),
      confidence: Number(sample.confidence.toFixed(3)),
      rms: Number(sample.rms.toFixed(4)),
      sampleCount: samples.length,
      unlocked: samples.length >= MIN_SAMPLES_FOR_BAATHOVEN,
    });
    logBaathovenStats(samples);
  }, []);

  const playCollectedBaathoven = useCallback(async () => {
    const mic = micRef.current;
    const samples = baaSampleBankRef.current.list();

    console.log("Baathoven button pressed", {
      sampleCount: samples.length,
      screen,
    });
    logBaathovenStats(samples);

    if (!mic) {
      console.warn("Baathoven cannot play before microphone setup.");
      return;
    }

    try {
      await mic.resume();
      await playBaathoven(mic.getAudioContext(), samples);
    } catch (error) {
      console.warn("Baathoven playback failed", error);
    }
  }, [screen]);

  const learnNoise = async (mic = micRef.current) => {
    if (!mic) return;

    setMessage("Stay quiet");
    setCalibrationProgress(0);
    setSetupInput(idleInput);
    setScreen("learning-noise");

    const learnedNoise = await mic.learnNoiseProfile({
      onProgress: setCalibrationProgress,
      onFrame: (frame) => {
        setSetupInput(inputFromPitchFrame(frame));
      },
    });

    console.log("Ferrite quiet-room intro complete", { learnedNoise });
    setCalibrationProgress(1);
    setMessage("");
  };

  const calibrate = async (mic = micRef.current) => {
    if (!mic) return;

    setMessage("");
    setCalibrationProgress(0);
    setLowBaaHz(null);
    setHighBaaHz(null);
    setScreen("calibrating");

    const calibration = await mic.calibrate({
      onProgress: setCalibrationProgress,
      onFrame: (frame) => {
        setSetupInput(inputFromPitchFrame(frame));
      },
    });
    if (calibration === null) {
      setCalibrationProgress(0);
      setMessage("Could not hear baaah");
      retryTimerRef.current = window.setTimeout(() => {
        void calibrate(mic);
      }, 700);
      return;
    }

    setMessage("");
    setCalibrationProgress(1);
    setMeasuredBaseHz(calibration.measuredBaseHz);
    setVoicedThresholdRms(calibration.voicedThresholdRms);
    setScreen("onboarding");
  };

  useEffect(() => {
    if (screen !== "intro" || autoMicStartedRef.current || micRef.current) {
      return;
    }

    autoMicStartedRef.current = true;
    void requestMic();
  }, [screen]);

  const isRunning =
    screen === "running" &&
    micRef.current !== null &&
    measuredBaseHz !== null &&
    voicedThresholdRms !== null;
  const isOnboarding =
    screen === "onboarding" &&
    micRef.current !== null &&
    measuredBaseHz !== null &&
    voicedThresholdRms !== null;
  const activeLevel = getLevel(
    isRunning || screen === "results" ? currentLevelId : 0,
  );

  return (
    <main className="app-shell">
      <header className="page-title">
        <h1>Baa</h1>
        <p>A pitch game</p>
      </header>

      {isRunning ? (
        <RunningGame
          key={`${measuredBaseHz}-${screen}-${activeLevel.id}`}
          measuredBaseHz={measuredBaseHz!}
          lowBaaHz={lowBaaHz}
          highBaaHz={highBaaHz}
          voicedThresholdRms={voicedThresholdRms!}
          mic={micRef.current!}
          level={activeLevel}
          baathovenSampleCount={baaSamples.length}
          onBaaSample={onBaaSample}
          onPlayBaathoven={playCollectedBaathoven}
          onResetBaseline={() => {
            void calibrate(micRef.current);
          }}
          onFinish={() => {
            const nextLevel = getNextLevel(activeLevel.id);
            if (nextLevel) {
              setCurrentLevelId(nextLevel.id);
            } else {
              setCurrentLevelId(1);
              setScreen("running");
            }
          }}
        />
      ) : isOnboarding ? (
        <OnboardingGame
          key={`${measuredBaseHz}-${screen}`}
          measuredBaseHz={measuredBaseHz!}
          lowBaaHz={lowBaaHz}
          highBaaHz={highBaaHz}
          voicedThresholdRms={voicedThresholdRms!}
          mic={micRef.current!}
          level={activeLevel}
          baathovenSampleCount={baaSamples.length}
          onBaaSample={onBaaSample}
          onPlayBaathoven={playCollectedBaathoven}
          onResetBaseline={() => {
            void calibrate(micRef.current);
          }}
          onComplete={() => {
            setCurrentLevelId(1);
            setScreen("running");
          }}
          onLowBaa={setLowBaaHz}
          onHighBaa={setHighBaaHz}
        />
      ) : (
        <GameScene
          game={previewGameRef.current}
          input={setupInput}
          measuredBaseHz={measuredBaseHz}
          lowBaaHz={lowBaaHz}
          highBaaHz={highBaaHz}
          level={activeLevel}
          visibleLanes={
            screen === "intro" ||
            screen === "learning-noise" ||
            screen === "calibrating"
              ? [0]
              : [1, 0, -1]
          }
          showBarn={
            screen !== "intro" &&
            screen !== "learning-noise" &&
            screen !== "calibrating"
          }
          showItems={
            screen !== "intro" &&
            screen !== "learning-noise" &&
            screen !== "calibrating"
          }
          prompt={
            screen === "intro"
              ? "Use microphone"
              : screen === "learning-noise"
                ? "Stay quiet"
              : screen === "calibrating"
                ? "Say baaah"
                : ""
          }
          promptHint={
            screen === "learning-noise"
              ? "Learning room noise"
              : screen === "calibrating"
                ? message
                : ""
          }
          promptProgress={
            screen === "learning-noise" || screen === "calibrating"
              ? calibrationProgress
              : null
          }
          promptAction={screen === "intro" ? requestMic : undefined}
          sheepBubble={
            screen === "intro" ? (
              <span className="mic-question">
                <Mic size={14} strokeWidth={3} aria-hidden="true" />?
              </span>
            ) : undefined
          }
          preview
        />
      )}

      {screen === "error" && (
        <div className="screen-overlay">
          <SetupPanel
            title="Mic blocked"
            eyebrow="🎙️"
            buttonLabel="Try again"
            onPrimary={requestMic}
          >
            <p>{message || "The microphone is unavailable."}</p>
            <p>Use localhost or HTTPS and allow microphone access.</p>
          </SetupPanel>
        </div>
      )}

      <footer className="page-footer">
        <span>Built by Alex</span>
        <a href="https://dahl.dev" target="_blank" rel="noreferrer">
          dahl.dev
        </a>
        <a href="https://x.com/alexdahl145" target="_blank" rel="noreferrer">
          X
        </a>
        <a
          href="https://www.linkedin.com/in/dahlalexander/"
          target="_blank"
          rel="noreferrer"
        >
          LinkedIn
        </a>
      </footer>
    </main>
  );
}

function SetupPanel({
  title,
  eyebrow,
  buttonLabel,
  onPrimary,
  disabled = false,
  secondaryText = "",
  children,
}: {
  title: string;
  eyebrow: ReactNode;
  buttonLabel: string;
  onPrimary?: () => void;
  disabled?: boolean;
  secondaryText?: string;
  children: ReactNode;
}) {
  return (
    <section className="setup-screen">
      <div className="setup-mark" aria-hidden="true">
        {eyebrow}
      </div>
      <h1>{title}</h1>
      <div className="setup-copy">{children}</div>
      <button
        className="primary-button"
        disabled={disabled}
        onClick={onPrimary}
      >
        {buttonLabel}
      </button>
      {secondaryText && <p className="setup-note">{secondaryText}</p>}
    </section>
  );
}

function OnboardingGame({
  measuredBaseHz,
  lowBaaHz,
  highBaaHz,
  voicedThresholdRms,
  mic,
  level,
  baathovenSampleCount,
  onBaaSample,
  onPlayBaathoven,
  onResetBaseline,
  onComplete,
  onLowBaa,
  onHighBaa,
}: {
  measuredBaseHz: number;
  lowBaaHz: number | null;
  highBaaHz: number | null;
  voicedThresholdRms: number;
  mic: MicrophonePitchController;
  level: LevelDefinition;
  baathovenSampleCount: number;
  onBaaSample: (sample: BaaSample) => void;
  onPlayBaathoven: () => void;
  onResetBaseline: () => void;
  onComplete: () => void;
  onLowBaa: (hz: number) => void;
  onHighBaa: (hz: number) => void;
}) {
  const gameRef = useRef<GameState>(createPracticeGameState());
  const filterRef = useRef(
    createPitchLaneFilter(measuredBaseHz, voicedThresholdRms),
  );
  const inputRef = useRef<InputState>(idleInput);
  const controlAccumulatorRef = useRef(CONTROL_TICK_MS);
  const lastTimeRef = useRef<number | null>(null);
  const stepStartedAtRef = useRef(0);
  const lowPitchRef = useRef<number | null>(null);
  const highPitchRef = useRef<number | null>(null);
  const baaCaptureRef = useRef<BaaSampleCapture | null>(null);
  const onCompleteRef = useRef(onComplete);
  const onLowBaaRef = useRef(onLowBaa);
  const onHighBaaRef = useRef(onHighBaa);
  const completedRef = useRef(false);
  const readyStartedAtRef = useRef<number | null>(null);
  const holdMsRef = useRef(0);
  const [step, setStep] = useState<OnboardingStep>("low");
  const stepRef = useRef<OnboardingStep>("low");
  const [showHint, setShowHint] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0);
  const [game, setGame] = useState(gameRef.current);
  const [input, setInput] = useState<InputState>(idleInput);

  useEffect(() => {
    onCompleteRef.current = onComplete;
    onLowBaaRef.current = onLowBaa;
    onHighBaaRef.current = onHighBaa;
  }, [onComplete, onHighBaa, onLowBaa]);

  useEffect(() => {
    const capture = new BaaSampleCapture(mic, {
      voicedThresholdRms,
      onSample: onBaaSample,
      onRejected: (reason, summary) => {
        console.debug("Baathoven rejected onboarding baa", { reason, summary });
      },
    });
    baaCaptureRef.current = capture;
    let animationFrame = 0;

    const tick = (now: number) => {
      const last = lastTimeRef.current ?? now;
      const dtMs = Math.min(50, now - last);
      lastTimeRef.current = now;

      if (stepStartedAtRef.current === 0) {
        stepStartedAtRef.current = now;
      }

      controlAccumulatorRef.current += dtMs;
      if (controlAccumulatorRef.current >= CONTROL_TICK_MS) {
        const controlDtMs = controlAccumulatorRef.current;
        controlAccumulatorRef.current = 0;

        const pitchFrame = mic.samplePitch();
        baaCaptureRef.current?.observeFrame(pitchFrame, now);
        const nextInput = updatePitchLaneFilter(
          filterRef.current,
          pitchFrame,
          controlDtMs,
        );
        inputRef.current = nextInput;
        setInput(nextInput);
      }

      const targetLane = onboardingTargetLane(
        stepRef.current,
        inputRef.current,
      );
      const nextGame = updatePracticeGameState(
        gameRef.current,
        targetLane,
        dtMs,
      );
      gameRef.current = nextGame;
      setGame(nextGame);

      if (now - stepStartedAtRef.current >= ONBOARDING_HINT_MS) {
        setShowHint(true);
      }

      const holdingPitch = onboardingPitchHeld(
        stepRef.current,
        inputRef.current,
        lowPitchRef.current,
      );
      if (stepRef.current === "low" || stepRef.current === "high") {
        holdMsRef.current = holdingPitch
          ? Math.min(ONBOARDING_HOLD_MS, holdMsRef.current + dtMs)
          : 0;
        setHoldProgress(holdMsRef.current / ONBOARDING_HOLD_MS);
      }

      if (
        stepRef.current === "low" &&
        holdMsRef.current >= ONBOARDING_HOLD_MS &&
        completedLowPitch(inputRef.current, nextGame)
      ) {
        lowPitchRef.current = inputRef.current.pitchHz;
        if (inputRef.current.pitchHz !== null) {
          onLowBaaRef.current(inputRef.current.pitchHz);
        }
        stepRef.current = "high";
        setStep("high");
        setShowHint(false);
        holdMsRef.current = 0;
        setHoldProgress(0);
        stepStartedAtRef.current = now;
      } else if (
        stepRef.current === "high" &&
        holdMsRef.current >= ONBOARDING_HOLD_MS &&
        completedHighPitch(inputRef.current, nextGame, lowPitchRef.current) &&
        !completedRef.current
      ) {
        highPitchRef.current = inputRef.current.pitchHz;
        if (inputRef.current.pitchHz !== null) {
          onHighBaaRef.current(inputRef.current.pitchHz);
        }
        stepRef.current = "ready";
        setStep("ready");
        setShowHint(false);
        holdMsRef.current = 0;
        setHoldProgress(0);
        stepStartedAtRef.current = now;
        readyStartedAtRef.current = now;
      } else if (stepRef.current === "ready") {
        if (
          readyStartedAtRef.current !== null &&
          now - readyStartedAtRef.current >= ONBOARDING_READY_MS &&
          !completedRef.current
        ) {
          completedRef.current = true;
          onCompleteRef.current();
          return;
        }
      }

      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(animationFrame);
      capture.dispose();
      baaCaptureRef.current = null;
    };
  }, [mic, onBaaSample, voicedThresholdRms]);

  return (
    <GameScene
      game={game}
      input={input}
      measuredBaseHz={measuredBaseHz}
      lowBaaHz={lowBaaHz}
      highBaaHz={highBaaHz}
      level={level}
      onResetBaseline={onResetBaseline}
      baathovenSampleCount={baathovenSampleCount}
      onPlayBaathoven={onPlayBaathoven}
      visibleLanes={step === "low" ? [0, -1] : [1, 0, -1]}
      showBarn={false}
      showItems={false}
      prompt={onboardingPrompt(step)}
      promptHint={showHint ? "Try a bigger pitch change, or tap Reset." : ""}
      promptProgress={step === "ready" ? null : holdProgress}
    />
  );
}

function onboardingPitchHeld(
  step: OnboardingStep,
  input: InputState,
  lowPitchHz: number | null,
): boolean {
  if (step === "low") {
    return lowPitchHeld(input);
  }

  if (step === "high") {
    return highPitchHeld(input, lowPitchHz);
  }

  return false;
}

function lowPitchHeld(input: InputState): boolean {
  return (
    input.voiced &&
    input.pitchHz !== null &&
    input.pitchOffsetSemitones !== null &&
    input.pitchOffsetSemitones <= LOW_THRESHOLD_SEMITONES
  );
}

function highPitchHeld(input: InputState, lowPitchHz: number | null): boolean {
  return (
    input.voiced &&
    input.pitchHz !== null &&
    lowPitchHz !== null &&
    input.pitchHz > lowPitchHz &&
    input.pitchOffsetSemitones !== null &&
    input.pitchOffsetSemitones >= HIGH_THRESHOLD_SEMITONES
  );
}

function onboardingTargetLane(step: OnboardingStep, input: InputState): Lane {
  if (step === "ready") {
    return input.lane;
  }

  if (step === "low") {
    return input.pitchOffsetSemitones !== null &&
      input.pitchOffsetSemitones <= LOW_THRESHOLD_SEMITONES
      ? -1
      : 0;
  }

  if (
    input.pitchOffsetSemitones !== null &&
    input.pitchOffsetSemitones >= HIGH_THRESHOLD_SEMITONES
  ) {
    return 1;
  }

  if (
    input.pitchOffsetSemitones !== null &&
    input.pitchOffsetSemitones <= LOW_THRESHOLD_SEMITONES
  ) {
    return -1;
  }

  return 0;
}

function onboardingPrompt(step: OnboardingStep): string {
  if (step === "low") return "Make a lower pitch";
  if (step === "high") return "Make a higher pitch";
  return "Reach the wheat!";
}

function completedLowPitch(input: InputState, game: GameState): boolean {
  return lowPitchHeld(input) && game.sheep.lane === -1;
}

function completedHighPitch(
  input: InputState,
  game: GameState,
  lowPitchHz: number | null,
): boolean {
  return highPitchHeld(input, lowPitchHz) && game.sheep.lane === 1;
}

function RunningGame({
  measuredBaseHz,
  lowBaaHz,
  highBaaHz,
  voicedThresholdRms,
  mic,
  level,
  baathovenSampleCount,
  onBaaSample,
  onPlayBaathoven,
  onResetBaseline,
  onFinish,
}: {
  measuredBaseHz: number;
  lowBaaHz: number | null;
  highBaaHz: number | null;
  voicedThresholdRms: number;
  mic: MicrophonePitchController;
  level: LevelDefinition;
  baathovenSampleCount: number;
  onBaaSample: (sample: BaaSample) => void;
  onPlayBaathoven: () => void;
  onResetBaseline: () => void;
  onFinish: () => void;
}) {
  const gameRef = useRef<GameState>(
    createInitialGameState(level.createItems()),
  );
  const filterRef = useRef(
    createPitchLaneFilter(measuredBaseHz, voicedThresholdRms),
  );
  const inputRef = useRef<InputState>(idleInput);
  const controlAccumulatorRef = useRef(CONTROL_TICK_MS);
  const lastTimeRef = useRef<number | null>(null);
  const baaCaptureRef = useRef<BaaSampleCapture | null>(null);
  const onFinishRef = useRef(onFinish);
  const finishedRef = useRef(false);
  const finishTimerRef = useRef<number | null>(null);
  const [game, setGame] = useState(gameRef.current);
  const [input, setInput] = useState<InputState>(idleInput);
  const [isCelebrating, setIsCelebrating] = useState(false);

  useEffect(() => {
    onFinishRef.current = onFinish;
  }, [onFinish]);

  useEffect(() => {
    const capture = new BaaSampleCapture(mic, {
      voicedThresholdRms,
      onSample: onBaaSample,
      onRejected: (reason, summary) => {
        console.debug("Baathoven rejected gameplay baa", { reason, summary });
      },
    });
    baaCaptureRef.current = capture;
    let animationFrame = 0;

    const tick = (now: number) => {
      const last = lastTimeRef.current ?? now;
      const dtMs = Math.min(50, now - last);
      lastTimeRef.current = now;

      controlAccumulatorRef.current += dtMs;
      if (controlAccumulatorRef.current >= CONTROL_TICK_MS) {
        const controlDtMs = controlAccumulatorRef.current;
        controlAccumulatorRef.current = 0;

        const pitchFrame = mic.samplePitch();
        baaCaptureRef.current?.observeFrame(pitchFrame, now);
        const nextInput = updatePitchLaneFilter(
          filterRef.current,
          pitchFrame,
          controlDtMs,
        );
        inputRef.current = nextInput;
        setInput(nextInput);
      }

      const nextGame = updateGameState(
        gameRef.current,
        inputRef.current.lane,
        dtMs,
        level,
      );

      gameRef.current = nextGame;
      setGame(nextGame);

      if (nextGame.finished && !finishedRef.current) {
        finishedRef.current = true;
        setIsCelebrating(true);
        finishTimerRef.current = window.setTimeout(() => {
          onFinishRef.current();
        }, LEVEL_FINISH_DELAY_MS);
        return;
      }

      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(animationFrame);
      capture.dispose();
      baaCaptureRef.current = null;
      if (finishTimerRef.current !== null) {
        window.clearTimeout(finishTimerRef.current);
      }
    };
  }, [level, mic, onBaaSample, voicedThresholdRms]);

  return (
    <GameScene
      game={game}
      input={input}
      measuredBaseHz={measuredBaseHz}
      lowBaaHz={lowBaaHz}
      highBaaHz={highBaaHz}
      level={level}
      onResetBaseline={onResetBaseline}
      baathovenSampleCount={baathovenSampleCount}
      onPlayBaathoven={onPlayBaathoven}
      sheepBubble={
        isCelebrating ? (
          <img
            className="bubble-emoji-asset"
            src={notoHeartUrl}
            alt="heart"
            draggable={false}
          />
        ) : undefined
      }
    />
  );
}

function GameScene({
  game,
  input,
  measuredBaseHz,
  lowBaaHz,
  highBaaHz,
  level,
  onResetBaseline,
  baathovenSampleCount,
  onPlayBaathoven,
  visibleLanes = [1, 0, -1],
  showBarn = true,
  showItems = true,
  prompt = "",
  promptHint = "",
  promptProgress = null,
  promptAction,
  sheepBubble,
  preview = false,
}: {
  game: GameState;
  input: InputState;
  measuredBaseHz: number | null;
  lowBaaHz?: number | null;
  highBaaHz?: number | null;
  level: LevelDefinition;
  onResetBaseline?: () => void;
  baathovenSampleCount?: number;
  onPlayBaathoven?: () => void;
  visibleLanes?: Lane[];
  showBarn?: boolean;
  showItems?: boolean;
  prompt?: string;
  promptHint?: string;
  promptProgress?: number | null;
  promptAction?: () => void;
  sheepBubble?: ReactNode;
  preview?: boolean;
}) {
  const courseRef = useRef<HTMLDivElement | null>(null);
  const [courseSize, setCourseSize] = useState({ width: 0, height: 0 });
  const sheepTop = lanePositionToPercent(game.sheep.lanePosition);
  const courseItems = showItems ? getCourseItems(game) : [];
  const sheepX = distanceToScreenX(game.progress);
  const finishX = distanceToScreenX(COURSE_LENGTH);
  const finishTop = laneToPercent(level.finish?.lane ?? 0);
  const sheepClass = [
    "sheep",
    game.sheep.tumbleMs > 0 ? "sheep-tumble" : "",
    game.sheep.blinkMs > 0 ? "sheep-blink" : "",
    !input.voiced ? "sheep-confused" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const sheepXStyle =
    courseSize.width > 0 && courseSize.height > 0
      ? {
          transform: `translate3d(${(sheepX / 100) * courseSize.width}px, 0, 0)`,
        }
      : undefined;
  const sheepYStyle =
    courseSize.width > 0 && courseSize.height > 0
      ? {
          transform: `translate3d(0, ${(sheepTop / 100) * courseSize.height}px, 0) translate(-50%, -50%)`,
        }
      : undefined;

  useEffect(() => {
    const course = courseRef.current;
    if (!course) return;

    const updateSize = () => {
      const rect = course.getBoundingClientRect();
      setCourseSize({ width: rect.width, height: rect.height });
    };

    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(course);

    return () => observer.disconnect();
  }, []);

  return (
    <section
      className={preview ? "game-screen game-screen-preview" : "game-screen"}
    >
      <div ref={courseRef} className="course" aria-label="Baaah runner course">
        <div className="course-top-status">
          <button
            className="voice-control"
            type="button"
            disabled={!onResetBaseline}
            onClick={onResetBaseline}
          >
            <span>Your Baas</span>
            <div className="voice-values" aria-hidden="true">
              <strong>{formatHz(lowBaaHz)}</strong>
              <strong>{formatHz(measuredBaseHz)}</strong>
              <strong>{formatHz(highBaaHz)}</strong>
            </div>
            <div className="voice-labels">
              <span>Low</span>
              <span>Base</span>
              <span>High</span>
            </div>
            <em>Reset</em>
          </button>
          {onPlayBaathoven && (
            <button
              className={[
                "baathoven-button",
                (baathovenSampleCount ?? 0) >= MIN_SAMPLES_FOR_BAATHOVEN
                  ? "baathoven-button-unlocked"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              type="button"
              onClick={onPlayBaathoven}
              title="Play Baathoven"
            >
              <Music size={15} strokeWidth={3} aria-hidden="true" />
              <span>Baathoven</span>
              <strong>{baathovenSampleCount ?? 0}</strong>
            </button>
          )}
        </div>

        <div
          className="level-badge"
          aria-label={`Level ${level.id}: ${level.name}`}
        >
          <span>Level {level.id}</span>
          <strong>{level.shortName}</strong>
          <em>{level.description}</em>
        </div>

        <div className="course-audio-status">
          <AudioMeter input={input} measuredBaseHz={measuredBaseHz} />
        </div>

        {prompt && (
          <div className="onboarding-prompt">
            {promptAction ? (
              <button
                className="onboarding-prompt-button"
                type="button"
                onClick={promptAction}
              >
                {prompt}
              </button>
            ) : (
              <strong>{prompt}</strong>
            )}
            {promptProgress !== null && (
              <div
                className="onboarding-hold-meter"
                aria-label="pitch hold progress"
              >
                <div
                  style={{ width: `${Math.round(promptProgress * 100)}%` }}
                />
              </div>
            )}
            {promptHint && <span>{promptHint}</span>}
          </div>
        )}

        <dl className="raw-debug" aria-label="raw pitch debug">
          <div>
            <dt>Raw</dt>
            <dd>
              {input.rawPitchHz ? `${Math.round(input.rawPitchHz)} Hz` : "- Hz"}
            </dd>
          </div>
          <div>
            <dt>Conf</dt>
            <dd>{Math.round(input.rawConfidence * 100)}%</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{formatPitchStatus(input.pitchStatus)}</dd>
          </div>
        </dl>

        <div className="skyline">☁️ ☁️ ☁️</div>
        {visibleLanes.map((lane) => (
          <LaneGuide key={lane} top={laneToPercent(lane)} />
        ))}

        {courseItems.map((item) => (
          <div
            key={item.id}
            className={`item item-${item.kind}`}
            style={{
              left: `${item.screenXPercent}%`,
              top: `${laneToPercent(item.lane)}%`,
            }}
            aria-label={item.kind}
          >
            <img
              className="emoji-asset"
              src={notoWolfUrl}
              alt=""
              draggable={false}
            />
          </div>
        ))}

        {showBarn && level.finish?.kind === "wheat" && (
          <div
            className="barn"
            style={{ left: `${finishX}%`, top: `${finishTop}%` }}
            aria-label="wheat"
          >
            <img
              className="emoji-asset"
              src={notoWheatUrl}
              alt=""
              draggable={false}
            />
          </div>
        )}

        <div className="sheep-x" style={sheepXStyle}>
          <div className="baa-bubble-wrap" style={sheepYStyle}>
            <span className="baa-bubble">{sheepBubble ?? input.label}</span>
          </div>
          <div className={sheepClass} style={sheepYStyle}>
            <img
              className="sheep-emoji emoji-asset"
              src={notoSheepUrl}
              alt=""
              draggable={false}
            />
          </div>
        </div>

        <div className="events">
          {game.events.map((event) => (
            <span key={event.id}>{event.message}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function AudioMeter({
  input,
  measuredBaseHz,
}: {
  input: InputState;
  measuredBaseHz: number | null;
}) {
  const points = getPitchWavePoints(input, measuredBaseHz);
  const waveClass = [
    "pitch-wave-line",
    input.voiced ? "pitch-wave-line-active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const currentHz = input.pitchHz ? `${Math.round(input.pitchHz)} Hz` : "- Hz";
  const loudnessPercent = Math.round(input.volume * 100);

  return (
    <div className="audio-meter">
      <div className="pitch-wave-row">
        <strong className="audio-meter-frequency">{currentHz}</strong>
        <div className="pitch-wave-wrap">
          <svg
            className="pitch-wave"
            viewBox="0 0 144 46"
            role="img"
            aria-label="pitch wave"
          >
            <line
              className="pitch-wave-center"
              x1="0"
              y1="23"
              x2="144"
              y2="23"
            />
            <polyline className={waveClass} points={points} />
          </svg>
        </div>
      </div>
      <div className="volume-meter" aria-label="baaah loudness">
        <div className="volume-fill" style={{ width: `${loudnessPercent}%` }} />
        <Volume2
          className="volume-icon"
          aria-hidden="true"
          size={12}
          strokeWidth={3}
        />
        <span>{loudnessPercent}%</span>
      </div>
    </div>
  );
}

function formatPitchStatus(status: InputState["pitchStatus"]): string {
  if (status === "ok") return "OK";
  if (status === "none") return "none";
  if (status === "low-confidence") return "weak";
  if (status === "too-low") return "low";
  if (status === "too-high") return "high";
  return status;
}

function formatHz(hz: number | null | undefined): string {
  return hz ? `${Math.round(hz)} Hz` : "- Hz";
}

function getPitchWavePoints(
  input: InputState,
  measuredBaseHz: number | null,
): string {
  const width = 144;
  const height = 46;
  const centerY = height / 2;
  const sampleCount = 72;
  const fallbackCycles = 2;
  const fallbackPitchRatio = input.pitchHz !== null ? input.pitchHz / 220 : 1;
  const baselineRatio =
    input.pitchHz !== null && measuredBaseHz !== null
      ? input.pitchHz / measuredBaseHz
      : fallbackPitchRatio;
  const offsetCycles =
    input.pitchOffsetSemitones !== null
      ? 3 + input.pitchOffsetSemitones * 0.22
      : fallbackCycles;
  const cycles = clamp(
    input.voiced
      ? input.pitchOffsetSemitones === null
        ? 3 * baselineRatio
        : offsetCycles
      : fallbackCycles,
    1.4,
    6,
  );
  const amplitude = input.voiced ? clamp(5 + input.volume * 24, 6, 17) : 3;

  return Array.from({ length: sampleCount }, (_, index) => {
    const t = index / (sampleCount - 1);
    const x = t * width;
    const y = centerY + Math.sin(t * cycles * Math.PI * 2) * amplitude;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function LaneGuide({ top }: { top: number }) {
  return <div className="lane-guide" style={{ top: `${top}%` }} />;
}
