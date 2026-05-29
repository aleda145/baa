import { useEffect, useRef, useState, type ReactNode } from "react";
import { Volume2 } from "lucide-react";
import notoSheepUrl from "../assets/noto-sheep.svg";
import notoWolfUrl from "../assets/noto-wolf.svg";
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
import type { GameState, InputState, Lane } from "../types";

type Screen =
  | "intro"
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
  const previewGameRef = useRef<GameState>(createInitialGameState());
  const [screen, setScreen] = useState<Screen>("intro");
  const [measuredBaseHz, setMeasuredBaseHz] = useState<number | null>(null);
  const [voicedThresholdRms, setVoicedThresholdRms] = useState<number | null>(
    null,
  );
  const [setupInput, setSetupInput] = useState<InputState>(idleInput);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [message, setMessage] = useState("");
  const retryTimerRef = useRef<number | null>(null);

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
    try {
      const mic = await MicrophonePitchController.create();
      micRef.current = mic;
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

  const calibrate = async (mic = micRef.current) => {
    if (!mic) return;

    setMessage("");
    setCalibrationProgress(0);
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

  const retry = () => {
    if (measuredBaseHz === null) {
      void calibrate();
      return;
    }

    setScreen("running");
  };

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

  return (
    <main className="app-shell">
      <header className="page-title">
        <h1>Baa</h1>
        <p>A pitch game</p>
      </header>

      {isRunning ? (
        <RunningGame
          key={`${measuredBaseHz}-${screen}`}
          measuredBaseHz={measuredBaseHz!}
          voicedThresholdRms={voicedThresholdRms!}
          mic={micRef.current!}
          onResetBaseline={() => {
            void calibrate(micRef.current);
          }}
          onFinish={() => {
            setScreen("results");
          }}
        />
      ) : isOnboarding ? (
        <OnboardingGame
          key={`${measuredBaseHz}-${screen}`}
          measuredBaseHz={measuredBaseHz!}
          voicedThresholdRms={voicedThresholdRms!}
          mic={micRef.current!}
          onResetBaseline={() => {
            void calibrate(micRef.current);
          }}
          onComplete={() => {
            setScreen("running");
          }}
        />
      ) : (
        <GameScene
          game={previewGameRef.current}
          input={setupInput}
          measuredBaseHz={measuredBaseHz}
          visibleLanes={screen === "calibrating" ? [0] : [1, 0, -1]}
          showBarn={screen !== "calibrating"}
          showItems={screen !== "calibrating"}
          prompt={screen === "calibrating" ? "Say baaah" : ""}
          promptHint={screen === "calibrating" ? message : ""}
          promptProgress={screen === "calibrating" ? calibrationProgress : null}
          preview
        />
      )}

      {!isRunning && !isOnboarding && screen !== "calibrating" && (
        <div className="screen-overlay">
          {screen === "intro" && (
            <SetupPanel
              title="Baa"
              eyebrow={
                <img
                  className="setup-emoji-asset"
                  src={notoSheepUrl}
                  alt=""
                  draggable={false}
                />
              }
              buttonLabel="Use microphone"
              onPrimary={requestMic}
            >
              <p>Say baaah</p>
            </SetupPanel>
          )}

          {screen === "results" && (
            <SetupPanel
              title="Barn reached"
              eyebrow="🏠"
              buttonLabel="Retry"
              onPrimary={retry}
            >
              <p>The sheep made it home.</p>
            </SetupPanel>
          )}

          {screen === "error" && (
            <SetupPanel
              title="Mic blocked"
              eyebrow="🎙️"
              buttonLabel="Try again"
              onPrimary={requestMic}
            >
              <p>{message || "The microphone is unavailable."}</p>
              <p>Use localhost or HTTPS and allow microphone access.</p>
            </SetupPanel>
          )}
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
  voicedThresholdRms,
  mic,
  onResetBaseline,
  onComplete,
}: {
  measuredBaseHz: number;
  voicedThresholdRms: number;
  mic: MicrophonePitchController;
  onResetBaseline: () => void;
  onComplete: () => void;
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
          onComplete();
          return;
        }
      }

      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [mic, onComplete]);

  return (
    <GameScene
      game={game}
      input={input}
      measuredBaseHz={measuredBaseHz}
      onResetBaseline={onResetBaseline}
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
  return "Avoid the wolves!";
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
  voicedThresholdRms,
  mic,
  onResetBaseline,
  onFinish,
}: {
  measuredBaseHz: number;
  voicedThresholdRms: number;
  mic: MicrophonePitchController;
  onResetBaseline: () => void;
  onFinish: () => void;
}) {
  const gameRef = useRef<GameState>(createInitialGameState());
  const filterRef = useRef(
    createPitchLaneFilter(measuredBaseHz, voicedThresholdRms),
  );
  const inputRef = useRef<InputState>(idleInput);
  const controlAccumulatorRef = useRef(CONTROL_TICK_MS);
  const lastTimeRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const [game, setGame] = useState(gameRef.current);
  const [input, setInput] = useState<InputState>(idleInput);

  useEffect(() => {
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
      );

      gameRef.current = nextGame;
      setGame(nextGame);

      if (nextGame.finished && !finishedRef.current) {
        finishedRef.current = true;
        onFinish();
        return;
      }

      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [mic, onFinish]);

  return (
    <GameScene
      game={game}
      input={input}
      measuredBaseHz={measuredBaseHz}
      onResetBaseline={onResetBaseline}
    />
  );
}

function GameScene({
  game,
  input,
  measuredBaseHz,
  onResetBaseline,
  visibleLanes = [1, 0, -1],
  showBarn = true,
  showItems = true,
  prompt = "",
  promptHint = "",
  promptProgress = null,
  preview = false,
}: {
  game: GameState;
  input: InputState;
  measuredBaseHz: number | null;
  onResetBaseline?: () => void;
  visibleLanes?: Lane[];
  showBarn?: boolean;
  showItems?: boolean;
  prompt?: string;
  promptHint?: string;
  promptProgress?: number | null;
  preview?: boolean;
}) {
  const courseRef = useRef<HTMLDivElement | null>(null);
  const [courseSize, setCourseSize] = useState({ width: 0, height: 0 });
  const sheepTop = lanePositionToPercent(game.sheep.lanePosition);
  const courseItems = showItems ? getCourseItems(game) : [];
  const sheepX = distanceToScreenX(game.progress);
  const barnX = distanceToScreenX(COURSE_LENGTH);
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
            <span>Your baa</span>
            <strong>
              {measuredBaseHz ? `${Math.round(measuredBaseHz)} Hz` : "- Hz"}
            </strong>
            <em>Reset</em>
          </button>
        </div>

        <div className="course-audio-status">
          <AudioMeter input={input} measuredBaseHz={measuredBaseHz} />
        </div>

        {prompt && (
          <div className="onboarding-prompt">
            <strong>{prompt}</strong>
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

        {showBarn && (
          <div className="barn" style={{ left: `${barnX}%` }} aria-label="barn">
            🏠
          </div>
        )}

        <div className="sheep-x" style={sheepXStyle}>
          <div className="baa-bubble-wrap" style={sheepYStyle}>
            <span className="baa-bubble">{input.label}</span>
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
