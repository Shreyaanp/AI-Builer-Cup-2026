import type { Api } from '../v1/api'
import { utter } from '../v1/phoneVoice'
import type { NarrationVoice } from './narrationQueue'

export function narrationVoice(api: Api): NarrationVoice {
  return {
    async load(text, language, signal) {
      const response = await api<Response>('/tts', {
        method: 'POST',
        body: JSON.stringify({ text, language }),
        raw: true,
        signal,
      })
      if (response.status !== 200) return null
      const url = URL.createObjectURL(await response.blob())
      const audio = new Audio(url)
      const stop = () => {
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
        URL.revokeObjectURL(url)
      }
      audio.onended = stop
      audio.onerror = () => URL.revokeObjectURL(url)
      return { play: () => audio.play(), stop }
    },
    fallback(text, language) {
      if (!('speechSynthesis' in window)) return null
      const utterance = utter(text, language)
      return {
        async play() {
          speechSynthesis.cancel()
          speechSynthesis.speak(utterance)
        },
        stop: () => speechSynthesis.cancel(),
      }
    },
  }
}
