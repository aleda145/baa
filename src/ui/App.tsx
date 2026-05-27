import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MicrophonePitchController } from '../audio/microphone'
import { createPitchLaneFilter, updatePitchLaneFilter } from '../audio/pitchLane'
import {
  COURSE_LENGTH,
  createInitialGameState,
  distanceToScreenX,
  getCourseItems,
  laneToPercent,
  updateGameState,
} from '../game/engine'
import type { GameState, InputState } from '../types'

type Screen = 'intro' | 'calibrating' | 'running' | 'results' | 'error'

const idleInput: InputState = {
  voiced: false,
  pitchHz: null,
  confidence: 0,
  volume: 0,
  lane: 0,
  intentLane: 0,
  intentProgress: 0,
  pitchOffsetSemitones: null,
  label: '?',
}

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
              eyebrow="🐑"
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
  eyebrow: string
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
  onFinish,
}: {
  measuredBaseHz: number
  voicedThresholdRms: number
  mic: MicrophonePitchController
  onFinish: () => void
}) {
  const gameRef = useRef<GameState>(createInitialGameState())
  const filterRef = useRef(createPitchLaneFilter(measuredBaseHz, voicedThresholdRms))
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

      const pitchFrame = mic.samplePitch()
      const nextInput = updatePitchLaneFilter(filterRef.current, pitchFrame, dtMs)
      const nextGame = updateGameState(gameRef.current, nextInput.lane, dtMs)

      gameRef.current = nextGame
      setInput(nextInput)
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

  return <GameScene game={game} input={input} measuredBaseHz={measuredBaseHz} />
}

function GameScene({
  game,
  input,
  measuredBaseHz,
  preview = false,
}: {
  game: GameState
  input: InputState
  measuredBaseHz: number | null
  preview?: boolean
}) {
  const sheepTop = laneToPercent(game.sheep.lanePosition)
  const courseItems = getCourseItems(game)
  const sheepX = distanceToScreenX(game.progress)
  const barnX = distanceToScreenX(COURSE_LENGTH)
  const progressPercent = Math.min(100, (game.progress / COURSE_LENGTH) * 100)
  const sheepClass = [
    'sheep',
    input.lane === 1 ? 'sheep-high' : '',
    input.lane === -1 ? 'sheep-low' : '',
    game.sheep.tumbleMs > 0 ? 'sheep-tumble' : '',
    game.sheep.blinkMs > 0 ? 'sheep-blink' : '',
    !input.voiced ? 'sheep-confused' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section className={preview ? 'game-screen game-screen-preview' : 'game-screen'}>
      <div className="hud">
        <div>
          <span>Baseline</span>
          <strong>{measuredBaseHz ? `${Math.round(measuredBaseHz)} Hz` : '...'}</strong>
        </div>
        <div>
          <span>Current</span>
          <strong>{input.pitchHz ? `${Math.round(input.pitchHz)} Hz` : '...'}</strong>
        </div>
        <div className="volume-card">
          <span>Loudness</span>
          <strong>{Math.round(input.volume * 100)}%</strong>
          <div className="volume-meter" aria-label="baaah loudness">
            <div className="volume-fill" style={{ width: `${Math.round(input.volume * 100)}%` }} />
          </div>
        </div>
        <div className="intent-card">
          <span>Move</span>
          <strong>{input.voiced ? input.label : '?'}</strong>
          <div className="intent-meter" aria-label="lane intent">
            <div className="intent-fill" style={{ width: `${Math.round(input.intentProgress * 100)}%` }} />
          </div>
        </div>
      </div>

      <div className="course" aria-label="Baaah runner course">
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
            {item.emoji}
          </div>
        ))}

        <div className="barn" style={{ left: `${barnX}%` }} aria-label="barn">
          🏠
        </div>

        <div className={sheepClass} style={{ left: `${sheepX}%`, top: `${sheepTop}%` }}>
          <span className="baa-bubble">{input.label}</span>
          <span className="sheep-emoji">🐑</span>
        </div>

        <div className="events">
          {game.events.map((event) => (
            <span key={event.id}>{event.message}</span>
          ))}
        </div>
      </div>

      <div className="progress-shell" aria-label="course progress">
        <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
      </div>
    </section>
  )
}

function LaneGuide({ top }: { top: number }) {
  return <div className="lane-guide" style={{ top: `${top}%` }} />
}
