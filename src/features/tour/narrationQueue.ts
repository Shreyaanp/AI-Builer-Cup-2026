export interface NarrationPlayback {
  play(): Promise<void>
  stop(): void
}

export interface NarrationVoice {
  load(text: string, language: string, signal: AbortSignal): Promise<NarrationPlayback | null>
  fallback(text: string, language: string): NarrationPlayback | null
}

/** Latest step wins, including when an old request ignores cancellation. */
export function narrationQueue(voice: NarrationVoice) {
  let controller: AbortController | undefined
  let playback: NarrationPlayback | null = null

  function stop() {
    controller?.abort()
    controller = undefined
    playback?.stop()
    playback = null
  }

  async function speak(text: string, language: string) {
    stop()
    const request = new AbortController()
    controller = request
    let loaded: NarrationPlayback | null = null
    try {
      loaded = await voice.load(text, language, request.signal)
      if (request.signal.aborted) return loaded?.stop()
      if (loaded) {
        playback = loaded
        await loaded.play()
        return
      }
    } catch (error) {
      loaded?.stop()
      if (request.signal.aborted) return
      // A browser autoplay rejection needs another gesture, not another playback method.
      if (error instanceof Error && error.name === 'NotAllowedError') return
    }
    if (request.signal.aborted) return
    let fallback: NarrationPlayback | null = null
    try {
      fallback = voice.fallback(text, language)
      playback = fallback
      await fallback?.play()
    } catch {
      fallback?.stop()
    }
  }

  return { speak, stop }
}
