export interface IBackend {
  postMessage(msg: { type: string; [key: string]: unknown }): void
  onMessage(handler: (msg: { type: string; [key: string]: unknown }) => void): () => void
}

let _backend: IBackend | null = null

export function setBackend(b: IBackend): void {
  _backend = b
}

export function getBackend(): IBackend {
  if (!_backend) throw new Error('Backend not initialized')
  return _backend
}
