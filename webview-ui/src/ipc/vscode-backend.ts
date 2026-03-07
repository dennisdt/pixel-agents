import type { IBackend } from './backend.js'

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }

export class VsCodeBackend implements IBackend {
  private vscode: { postMessage(msg: unknown): void } | null = null

  private getVscode() {
    if (!this.vscode) {
      if (typeof acquireVsCodeApi === 'function') {
        this.vscode = acquireVsCodeApi()
      } else {
        // Not running inside VS Code — no-op
        this.vscode = { postMessage() {} }
      }
    }
    return this.vscode
  }

  postMessage(msg: { type: string; [key: string]: unknown }): void {
    this.getVscode().postMessage(msg)
  }

  onMessage(handler: (msg: { type: string; [key: string]: unknown }) => void): () => void {
    const listener = (e: MessageEvent) => {
      handler(e.data)
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }
}
