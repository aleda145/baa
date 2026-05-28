import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Volume2 } from 'lucide-react'
import notoSheepUrl from '../assets/noto-sheep.svg'
import notoWolfUrl from '../assets/noto-wolf.svg'
import { MicrophonePitchController } from '../audio/microphone'
import { createPitchLaneFilter, updatePitchLaneFilter } from '../audio/pitchLane'
import {
  COURSE_LENGTH,
  createInitialGameState,
  distanceToScreenX,
  getCourseItems,
  lanePositionToPercent,
  laneToPercent,
  updateGameState,
} from '../game/engine'
import type { GameState, InputState } from '../types'

type Screen = 'intro' | 'calibrating' | 'running' | 'results' | 'error'

const idleInput: InputState = {
  voiced: false,
  pitchHz: null,
  rawPitchHz: null,
  confidence: 0,
  rawConfidence: 0,
  pitchStatus: 'none',
  volume: 0,
  lane: 0,
  intentLane: 0,
  intentProgress: 0,
  pitchOffsetSemitones: null,
  label: '?',
}

const CONTROL_TICK_MS = 100

export function App() {
  const micRef = useRef<MicrophonePitchController | null>(null)
  const previewGameRef = useRef<GameState>(createInitialGameState())
  const [screen, setScreen] = useState<Screen>('intro')
  const [measuredBaseHz, setMeasuredBaseHz] = useState<number | null>(null)
  const [voicedThresholdRms, setVoicedThresholdRms] = useState<number | null>(null)
  const [calibrationProgress, setCalibrationProgress] = useState(0)
  const [message, setMessage] = useState('')
  const retryTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current)
      }
      void micRef.current?.close()
    }
  }, [])

  const requestMic = async () => {
    setMessage('')
    try {
      const mic = await MicrophonePitchController.create()
      micRef.current = mic
      await calibrate(mic)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not open the microphone.')
      setScreen('error')
    }
  }

  const calibrate = async (mic = micRef.current) => {
    if (!mic) return

    setMessage('')
    setCalibrationProgress(0)
    setScreen('calibrating')

    const calibration = await mic.calibrate({
      onProgress: setCalibrationProgress,
    })
    if (calibration === null) {
      setCalibrationProgress(0)
      setMessage('Could not hear baaah')
      retryTimerRef.current = window.setTimeout(() => {
        void calibrate(mic)
      }, 700)
      return
    }

    setMessage('')
    setCalibrationProgress(1)
    setMeasuredBaseHz(calibration.measuredBaseHz)
    setVoicedThresholdRms(calibration.voicedThresholdRms)
    setScreen('running')
  }

  const retry = () => {
    if (measuredBaseHz === null) {
      void calibrate()
      return
    }

    setScreen('running')
  }

  const isRunning =
    screen === 'running' &&
    micRef.current !== null &&
    measuredBaseHz !== null &&
    voicedThresholdRms !== null

  return (
    <main className="app-shell">
      {isRunning ? (
        <RunningGame
          key={`${measuredBaseHz}-${screen}`}
          measuredBaseHz={measuredBaseHz!}
          voicedThresholdRms={voicedThresholdRms!}
          mic={micRef.current!}
          onResetBaseline={() => {
            void calibrate(micRef.current)
          }}
          onFinish={() => {
            setScreen('results')
          }}
        />
      ) : (
        <GameScene
          game={previewGameRef.current}
          input={idleInput}
          measuredBaseHz={measuredBaseHz}
          preview
        />
      )}

      {!isRunning && (
        <div className="screen-overlay">
          {screen === 'intro' && (
            <SetupPanel
              title="Baaah"
              eyebrow={<img className="setup-emoji-asset" src={notoSheepUrl} alt="" draggable={false} />}
              buttonLabel="Use microphone"
              onPrimary={requestMic}
            >
              <p>Say baaah</p>
            </SetupPanel>
          )}

          {screen === 'calibrating' && (
            <SetupPanel title="Say baaah" eyebrow="👂" buttonLabel="..." disabled secondaryText={message}>
              <p>Say baaah</p>
              <HoldMeter progress={calibrationProgress} />
            </SetupPanel>
          )}

          {screen === 'results' && (
            <SetupPanel title="Barn reached" eyebrow="🏠" buttonLabel="Retry" onPrimary={retry}>
              <p>The sheep made it home.</p>
            </SetupPanel>
          )}

          {screen === 'error' && (
            <SetupPanel title="Mic blocked" eyebrow="🎙️" buttonLabel="Try again" onPrimary={requestMic}>
              <p>{message || 'The microphone is unavailable.'}</p>
              <p>Use localhost or HTTPS and allow microphone access.</p>
            </SetupPanel>
          )}
        </div>
      )}
    </main>
  )
}

function SetupPanel({
  title,
  eyebrow,
  buttonLabel,
  onPrimary,
  disabled = false,
  secondaryText = '',
  children,
}: {
  title: string
  eyebrow: ReactNode
  buttonLabel: string
  onPrimary?: () => void
  disabled?: boolean
  secondaryText?: string
  children: ReactNode
}) {
  return (
    <section className="setup-screen">
      <div className="setup-mark" aria-hidden="true">
        {eyebrow}
      </div>
      <h1>{title}</h1>
      <div className="setup-copy">{children}</div>
      <button className="primary-button" disabled={disabled} onClick={onPrimary}>
        {buttonLabel}
      </button>
      {secondaryText && <p className="setup-note">{secondaryText}</p>}
    </section>
  )
}

function HoldMeter({ progress }: { progress: number }) {
  return (
    <div className="hold-meter" aria-label="baaah hold progress">
      <div className="hold-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
    </div>
  )
}

function RunningGame({
  measuredBaseHz,
  voicedThresholdRms,
  mic,
  onResetBaseline,
  onFinish,
}: {
  measuredBaseHz: number
  voicedThresholdRms: number
  mic: MicrophonePitchController
  onResetBaseline: () => void
  onFinish: () => void
}) {
  const gameRef = useRef<GameState>(createInitialGameState())
  const filterRef = useRef(createPitchLaneFilter(measuredBaseHz, voicedThresholdRms))
  const inputRef = useRef<InputState>(idleInput)
  const controlAccumulatorRef = useRef(CONTROL_TICK_MS)
  const lastTimeRef = useRef<number | null>(null)
  const finishedRef = useRef(false)
  const [game, setGame] = useState(gameRef.current)
  const [input, setInput] = useState<InputState>(idleInput)

  useEffect(() => {
    let animationFrame = 0

    const tick = (now: number) => {
      const last = lastTimeRef.current ?? now
      const dtMs = Math.min(50, now - last)
      lastTimeRef.current = now

      controlAccumulatorRef.current += dtMs
      if (controlAccumulatorRef.current >= CONTROL_TICK_MS) {
        const controlDtMs = controlAccumulatorRef.current
        controlAccumulatorRef.current = 0

        const pitchFrame = mic.samplePitch()
        const nextInput = updatePitchLaneFilter(filterRef.current, pitchFrame, controlDtMs)
        inputRef.current = nextInput
        setInput(nextInput)
      }

      const nextGame = updateGameState(gameRef.current, inputRef.current.lane, dtMs)

      gameRef.current = nextGame
      setGame(nextGame)

      if (nextGame.finished && !finishedRef.current) {
        finishedRef.current = true
        onFinish()
        return
      }

      animationFrame = requestAnimationFrame(tick)
    }

    animationFrame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animationFrame)
  }, [mic, onFinish])

  return (
    <GameScene
      game={game}
      input={input}
      measuredBaseHz={measuredBaseHz}
      onResetBaseline={onResetBaseline}
    />
  )
}

function GameScene({
  game,
  input,
  measuredBaseHz,
  onResetBaseline,
  preview = false,
}: {
  game: GameState
  input: InputState
  measuredBaseHz: number | null
  onResetBaseline?: () => void
  preview?: boolean
}) {
  const courseRef = useRef<HTMLDivElement | null>(null)
  const [courseSize, setCourseSize] = useState({ width: 0, height: 0 })
  const sheepTop = lanePositionToPercent(game.sheep.lanePosition)
  const courseItems = getCourseItems(game)
  const sheepX = distanceToScreenX(game.progress)
  const barnX = distanceToScreenX(COURSE_LENGTH)
  const sheepClass = [
    'sheep',
    game.sheep.tumbleMs > 0 ? 'sheep-tumble' : '',
    game.sheep.blinkMs > 0 ? 'sheep-blink' : '',
    !input.voiced ? 'sheep-confused' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const sheepXStyle =
    courseSize.width > 0 && courseSize.height > 0
      ? {
          transform: `translate3d(${(sheepX / 100) * courseSize.width}px, 0, 0)`,
        }
      : undefined
  const sheepYStyle =
    courseSize.width > 0 && courseSize.height > 0
      ? {
          transform: `translate3d(0, ${(sheepTop / 100) * courseSize.height}px, 0) translate(-50%, -50%)`,
        }
      : undefined

  useEffect(() => {
    const course = courseRef.current
    if (!course) return

    const updateSize = () => {
      const rect = course.getBoundingClientRect()
      setCourseSize({ width: rect.width, height: rect.height })
    }

    updateSize()

    const observer = new ResizeObserver(updateSize)
    observer.observe(course)

    return () => observer.disconnect()
  }, [])

  return (
    <section className={preview ? 'game-screen game-screen-preview' : 'game-screen'}>
      <div ref={courseRef} className="course" aria-label="Baaah runner course">
        <div className="course-top-status">
          {onResetBaseline && (
            <button className="voice-control" type="button" onClick={onResetBaseline}>
              <span>Your baa</span>
              <strong>{measuredBaseHz ? `${Math.round(measuredBaseHz)} Hz` : '...'}</strong>
              <em>Reset</em>
            </button>
          )}
        </div>

        <div className="course-audio-status">
          <AudioMeter input={input} measuredBaseHz={measuredBaseHz} />
        </div>

        <dl className="raw-debug" aria-label="raw pitch debug">
          <div>
            <dt>Raw</dt>
            <dd>{input.rawPitchHz ? `${Math.round(input.rawPitchHz)} Hz` : '...'}</dd>
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
        <LaneGuide top={23} />
        <LaneGuide top={50} />
        <LaneGuide top={77} />

        {courseItems.map((item) => (
          <div
            key={item.id}
            className={`item item-${item.kind}`}
            style={{ left: `${item.screenXPercent}%`, top: `${laneToPercent(item.lane)}%` }}
            aria-label={item.kind}
          >
            <img className="emoji-asset" src={notoWolfUrl} alt="" draggable={false} />
          </div>
        ))}

        <div className="barn" style={{ left: `${barnX}%` }} aria-label="barn">
          🏠
        </div>

        <div className="sheep-x" style={sheepXStyle}>
          <div className="baa-bubble-wrap" style={sheepYStyle}>
            <span className="baa-bubble">{input.label}</span>
          </div>
          <div className={sheepClass} style={sheepYStyle}>
            <img className="sheep-emoji emoji-asset" src={notoSheepUrl} alt="" draggable={false} />
          </div>
        </div>

        <div className="events">
          {game.events.map((event) => (
            <span key={event.id}>{event.message}</span>
          ))}
        </div>
      </div>
    </section>
  )
}

function AudioMeter({
  input,
  measuredBaseHz,
}: {
  input: InputState
  measuredBaseHz: number | null
}) {
  const points = getPitchWavePoints(input, measuredBaseHz)
  const waveClass = ['pitch-wave-line', input.voiced ? 'pitch-wave-line-active' : '']
    .filter(Boolean)
    .join(' ')
  const currentHz = input.pitchHz ? `${Math.round(input.pitchHz)} Hz` : '- Hz'
  const loudnessPercent = Math.round(input.volume * 100)

  return (
    <div className="audio-meter">
      <strong className="audio-meter-frequency">{currentHz}</strong>
      <div className="pitch-wave-wrap">
        <svg className="pitch-wave" viewBox="0 0 144 46" role="img" aria-label="pitch wave">
          <line className="pitch-wave-center" x1="0" y1="23" x2="144" y2="23" />
          <polyline className={waveClass} points={points} />
        </svg>
      </div>
      <div className="volume-meter" aria-label="baaah loudness">
        <div className="volume-fill" style={{ width: `${loudnessPercent}%` }} />
        <Volume2 className="volume-icon" aria-hidden="true" size={12} strokeWidth={3} />
        <span>{loudnessPercent}%</span>
      </div>
    </div>
  )
}

function formatPitchStatus(status: InputState['pitchStatus']): string {
  if (status === 'ok') return 'OK'
  if (status === 'none') return 'none'
  if (status === 'low-confidence') return 'weak'
  if (status === 'too-low') return 'low'
  if (status === 'too-high') return 'high'
  return status
}

function getPitchWavePoints(input: InputState, measuredBaseHz: number | null): string {
  const width = 144
  const height = 46
  const centerY = height / 2
  const sampleCount = 72
  const fallbackCycles = 2
  const baselineRatio =
    input.pitchHz !== null && measuredBaseHz !== null ? input.pitchHz / measuredBaseHz : 1
  const offsetCycles =
    input.pitchOffsetSemitones !== null ? 3 + input.pitchOffsetSemitones * 0.22 : fallbackCycles
  const cycles = clamp(
    input.voiced ? (input.pitchOffsetSemitones === null ? 3 * baselineRatio : offsetCycles) : fallbackCycles,
    1.4,
    6,
  )
  const amplitude = input.voiced ? clamp(5 + input.volume * 24, 6, 17) : 3

  return Array.from({ length: sampleCount }, (_, index) => {
    const t = index / (sampleCount - 1)
    const x = t * width
    const y = centerY + Math.sin(t * cycles * Math.PI * 2) * amplitude
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function LaneGuide({ top }: { top: number }) {
  return <div className="lane-guide" style={{ top: `${top}%` }} />
}
