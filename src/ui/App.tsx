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

type Screen = 'intro' | 'calibrate' | 'calibrating' | 'running' | 'results' | 'error'

const idleInput: InputState = {
  voiced: false,
  pitchHz: null,
  confidence: 0,
  volume: 0,
  lane: 0,
  label: '?',
}

export function App() {
  const micRef = useRef<MicrophonePitchController | null>(null)
  const [screen, setScreen] = useState<Screen>('intro')
  const [measuredBaseHz, setMeasuredBaseHz] = useState<number | null>(null)
  const [calibrationProgress, setCalibrationProgress] = useState(0)
  const [message, setMessage] = useState('')

  useEffect(() => {
    return () => {
      void micRef.current?.close()
    }
  }, [])

  const requestMic = async () => {
    setMessage('')
    try {
      micRef.current = await MicrophonePitchController.create()
      setScreen('calibrate')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not open the microphone.')
      setScreen('error')
    }
  }

  const calibrate = async () => {
    if (!micRef.current) return

    setMessage('')
    setCalibrationProgress(0)
    setScreen('calibrating')

    const baseHz = await micRef.current.calibrate({
      onProgress: setCalibrationProgress,
    })
    if (baseHz === null) {
      setCalibrationProgress(0)
      setMessage('Say baaah')
      setScreen('calibrate')
      return
    }

    setCalibrationProgress(1)
    setMeasuredBaseHz(baseHz)
    setScreen('running')
  }

  const retry = () => {
    if (measuredBaseHz === null) {
      setScreen('calibrate')
      return
    }

    setScreen('running')
  }

  return (
    <main className="app-shell">
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

      {screen === 'calibrate' && (
        <SetupPanel
          title="Say baaah"
          eyebrow="🎙️"
          buttonLabel="Start"
          onPrimary={calibrate}
          secondaryText={message}
        >
          <p>Say baaah</p>
        </SetupPanel>
      )}

      {screen === 'calibrating' && (
        <SetupPanel title="Say baaah" eyebrow="👂" buttonLabel="..." disabled>
          <p>Say baaah</p>
          <HoldMeter progress={calibrationProgress} />
        </SetupPanel>
      )}

      {screen === 'running' && micRef.current && measuredBaseHz !== null && (
        <RunningGame
          key={`${measuredBaseHz}-${screen}`}
          measuredBaseHz={measuredBaseHz}
          mic={micRef.current}
          onFinish={() => {
            setScreen('results')
          }}
        />
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
  mic,
  onFinish,
}: {
  measuredBaseHz: number
  mic: MicrophonePitchController
  onFinish: () => void
}) {
  const gameRef = useRef<GameState>(createInitialGameState())
  const filterRef = useRef(createPitchLaneFilter(measuredBaseHz))
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
}: {
  game: GameState
  input: InputState
  measuredBaseHz: number
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
    <section className="game-screen">
      <div className="hud">
        <div>
          <span>Baseline</span>
          <strong>{Math.round(measuredBaseHz)} Hz</strong>
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
