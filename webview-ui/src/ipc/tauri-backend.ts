import type { IBackend } from './backend.js'

interface TauriGlobal {
  core: {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
  }
  event: {
    listen(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void>
  }
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal
    __TAURI_INTERNALS__?: TauriGlobal
  }
}

export function getTauri(): TauriGlobal | undefined {
  return window.__TAURI__ ?? window.__TAURI_INTERNALS__
}

export function isTauri(): boolean {
  return getTauri() !== undefined
}

const MESSAGE_TO_COMMAND: Record<string, string> = {
  openClaude: 'create_agent',
  focusAgent: 'focus_agent',
  closeAgent: 'close_agent',
  saveAgentSeats: 'save_agent_seats',
  saveLayout: 'save_layout',
  setSoundEnabled: 'set_sound_enabled',
  webviewReady: 'app_ready',
  exportLayout: 'export_layout',
  importLayout: 'import_layout',
  openSessionsFolder: 'open_sessions_folder',
}

export class TauriBackend implements IBackend {
  postMessage(msg: { type: string; [key: string]: unknown }): void {
    const command = MESSAGE_TO_COMMAND[msg.type] ?? msg.type
    const { type: _, ...args } = msg
    const tauri = getTauri()
    if (tauri) {
      tauri.core.invoke(command, args).catch((err: unknown) => {
        console.error(`[Tauri] invoke ${command} failed:`, err)
      })
    }
  }

  onMessage(handler: (msg: { type: string; [key: string]: unknown }) => void): () => void {
    const tauri = getTauri()
    if (!tauri) return () => {}

    let cleanup: (() => void) | null = null
    tauri.event.listen('backend-event', (event) => {
      const payload = event.payload as { type: string; [key: string]: unknown }
      handler(payload)
    }).then((unlisten) => {
      cleanup = unlisten
    })

    return () => {
      cleanup?.()
    }
  }
}
