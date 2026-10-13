import { spawn } from 'node:child_process'
import { execa } from 'execa'
import type { Capability, Json } from '../../shared/schema'
import { abortError } from '../../runtime/data'
export class ResourceLocks {
  private tails = new Map<string, Promise<void>>()
  async use<T>(key: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const ticket = new Promise<void>((r) => (release = r))
    const tail = previous.then(() => ticket)
    this.tails.set(key, tail)
    await previous
    try {
      abortError(signal)
      return await fn()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}
export const locks = new ResourceLocks()
export async function command(
  executable: string,
  args: string[],
  signal: AbortSignal
): Promise<Json> {
  abortError(signal)
  // Detached POSIX process group: abort kills grandchildren as well as the shell.
  const child = execa(executable, args, {
    detached: true,
    maxBuffer: 65536,
    timeout: 300000,
    reject: false,
    stdin: 'ignore'
  })
  const kill = () => {
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {}
    const hard = setTimeout(() => {
      if (child.pid)
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
    }, 500)
    hard.unref()
  }
  signal.addEventListener('abort', kill, { once: true })
  if (signal.aborted) kill()
  try {
    const result = await child
    abortError(signal)
    if (result.exitCode !== 0)
      throw new Error(
        `${executable}: ${String(result.stderr).slice(0, 4096) || result.shortMessage || 'command failed'}`
      )
    return {
      stdout: String(result.stdout).slice(0, 16384),
      stderr: String(result.stderr).slice(0, 4096),
      exitCode: result.exitCode ?? 0
    }
  } finally {
    signal.removeEventListener('abort', kill)
  }
}
async function probe(executable: string, args: string[]): Promise<boolean> {
  try {
    await command(executable, args, AbortSignal.timeout(3000))
    return true
  } catch {
    return false
  }
}
export async function capabilities(): Promise<Capability[]> {
  const [keyboard, pulse, pipewire, media] = await Promise.all([
    process.env.XDG_SESSION_TYPE !== 'wayland' && probe('xdotool', ['version']),
    probe('pactl', ['info']),
    probe('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']),
    probe('gdbus', [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.DBus',
      '--object-path',
      '/org/freedesktop/DBus',
      '--method',
      'org.freedesktop.DBus.ListNames'
    ])
  ])
  return [
    {
      id: 'keyboard',
      available: keyboard,
      detail: keyboard
        ? 'X11 / xdotool'
        : 'Requires X11 and xdotool; Wayland injection is unavailable'
    },
    {
      id: 'audio',
      available: pulse || pipewire,
      detail: pipewire
        ? 'PipeWire / wpctl'
        : pulse
          ? 'PulseAudio / pactl'
          : 'No reachable audio service; install wpctl or pactl'
    },
    {
      id: 'media',
      available: media,
      detail: media
        ? 'MPRIS over session D-Bus (gdbus)'
        : 'No session D-Bus; install GLib gdbus and start a media player'
    },
    {
      id: 'command',
      available: true,
      detail: 'Argument-array subprocesses; shell only for explicit scripts'
    },
    { id: 'launch', available: true, detail: 'Executable or gtk-launch desktop entry' },
    { id: 'http', available: true, detail: 'HTTP(S) with bounded response and cancellation' },
    { id: 'desktop', available: true, detail: 'Electron shell, clipboard and notifications' },
    { id: 'deck', available: true, detail: 'Hardware adapter and software simulator' },
    { id: 'obs', available: true, detail: 'Configure an OBS WebSocket connection in Settings' }
  ]
}
export async function audio(c: Record<string, Json>, signal: AbortSignal): Promise<Json> {
  return locks.use('audio', signal, async () => {
    const target = c.target === 'source' ? '@DEFAULT_AUDIO_SOURCE@' : '@DEFAULT_AUDIO_SINK@'
    const wp = await probe('wpctl', ['get-volume', target])
    if (c.operation === 'device') {
      if (wp) return command('wpctl', ['set-default', String(c.device)], signal)
      return command(
        'pactl',
        [c.target === 'source' ? 'set-default-source' : 'set-default-sink', String(c.device)],
        signal
      )
    }
    if (c.operation === 'volume') {
      const v = Number(c.value)
      if (!Number.isFinite(v) || v < 0 || v > 150) throw new Error('Volume must be 0–150 percent')
      if (wp) await command('wpctl', ['set-volume', target, `${v}%`], signal)
      else
        await command(
          'pactl',
          [
            `set-${c.target}-volume`,
            c.target === 'source' ? '@DEFAULT_SOURCE@' : '@DEFAULT_SINK@',
            `${v}%`
          ],
          signal
        )
    } else {
      if (typeof c.value !== 'boolean') throw new Error('Mute state must be a boolean')
      if (wp) await command('wpctl', ['set-mute', target, c.value ? '1' : '0'], signal)
      else
        await command(
          'pactl',
          [
            `set-${c.target}-mute`,
            c.target === 'source' ? '@DEFAULT_SOURCE@' : '@DEFAULT_SINK@',
            c.value ? '1' : '0'
          ],
          signal
        )
    }
    return wp
      ? command('wpctl', ['get-volume', target], signal)
      : command(
          'pactl',
          [`get-${c.target}-mute`, c.target === 'source' ? '@DEFAULT_SOURCE@' : '@DEFAULT_SINK@'],
          signal
        )
  })
}
export async function media(c: Record<string, Json>, signal: AbortSignal): Promise<Json> {
  const listed = (await command(
    'gdbus',
    [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.DBus',
      '--object-path',
      '/org/freedesktop/DBus',
      '--method',
      'org.freedesktop.DBus.ListNames'
    ],
    signal
  )) as { stdout: string }
  const names = listed.stdout.match(/org\.mpris\.MediaPlayer2\.[\w.-]+/g) ?? []
  const requested = String(c.player || '')
  const name = requested
    ? names.find((n) => n === requested || n.endsWith('.' + requested))
    : names[0]
  if (!name) throw new Error('No matching MPRIS player is running')
  await command(
    'gdbus',
    [
      'call',
      '--session',
      '--dest',
      name,
      '--object-path',
      '/org/mpris/MediaPlayer2',
      '--method',
      `org.mpris.MediaPlayer2.Player.${c.operation}`
    ],
    signal
  )
  return command(
    'gdbus',
    [
      'call',
      '--session',
      '--dest',
      name,
      '--object-path',
      '/org/mpris/MediaPlayer2',
      '--method',
      'org.freedesktop.DBus.Properties.Get',
      'org.mpris.MediaPlayer2.Player',
      'PlaybackStatus'
    ],
    signal
  )
}

export function launch(executable: string, args: string[], signal: AbortSignal): Promise<Json> {
  abortError(signal)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve({ pid: child.pid ?? 0 })
    })
  })
}
export async function observeAudio(target: 'sink' | 'source'): Promise<Json> {
  const signal = AbortSignal.timeout(2000)
  try {
    const wp = (await command(
      'wpctl',
      ['get-volume', target === 'source' ? '@DEFAULT_AUDIO_SOURCE@' : '@DEFAULT_AUDIO_SINK@'],
      signal
    )) as { stdout: string }
    return {
      available: true,
      muted: wp.stdout.includes('MUTED'),
      volume: Number(wp.stdout.match(/Volume:\s*([\d.]+)/)?.[1] ?? 0) * 100
    }
  } catch {
    try {
      const pulse = (await command(
        'pactl',
        [`get-${target}-mute`, target === 'source' ? '@DEFAULT_SOURCE@' : '@DEFAULT_SINK@'],
        AbortSignal.timeout(2000)
      )) as { stdout: string }
      return { available: true, muted: /yes|true/i.test(pulse.stdout) }
    } catch {
      return { available: false }
    }
  }
}
export async function observeMedia(player: string): Promise<Json> {
  try {
    const signal = AbortSignal.timeout(2000)
    const listed = (await command(
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.DBus',
        '--object-path',
        '/org/freedesktop/DBus',
        '--method',
        'org.freedesktop.DBus.ListNames'
      ],
      signal
    )) as { stdout: string }
    const names = listed.stdout.match(/org\.mpris\.MediaPlayer2\.[\w.-]+/g) ?? []
    const name = player ? names.find((n) => n === player || n.endsWith('.' + player)) : names[0]
    if (!name) return { available: false }
    const result = (await command(
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        name,
        '--object-path',
        '/org/mpris/MediaPlayer2',
        '--method',
        'org.freedesktop.DBus.Properties.Get',
        'org.mpris.MediaPlayer2.Player',
        'PlaybackStatus'
      ],
      signal
    )) as { stdout: string }
    return {
      available: true,
      player: name,
      playback: result.stdout.match(/Playing|Paused|Stopped/)?.[0] ?? 'Unknown'
    }
  } catch {
    return { available: false }
  }
}
