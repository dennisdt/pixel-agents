interface PixelAgentsApi {
  postMessage(msg: unknown): void
  onMessage(callback: (msg: unknown) => void): () => void
  minimizeWindow(): void
  closeWindow(): void
}

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }

const electronApi = (window as unknown as Record<string, unknown>).pixelAgentsApi as PixelAgentsApi | undefined

export const isElectron = !!electronApi

export const vscode = electronApi
  ? { postMessage: (msg: unknown) => electronApi.postMessage(msg) }
  : acquireVsCodeApi()

export const electronControls = electronApi
  ? {
      minimizeWindow: () => electronApi.minimizeWindow(),
      closeWindow: () => electronApi.closeWindow(),
      onMessage: (cb: (msg: unknown) => void) => electronApi.onMessage(cb),
    }
  : null
