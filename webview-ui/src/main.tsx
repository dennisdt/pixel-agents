import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { setBackend } from './ipc/backend.js'
import { VsCodeBackend } from './ipc/vscode-backend.js'
import { TauriBackend } from './ipc/tauri-backend.js'
import App from './App.tsx'

// Initialize backend before rendering
const isTauriEnv = !!(window.__TAURI__ ?? window.__TAURI_INTERNALS__)
const backend = isTauriEnv ? new TauriBackend() : new VsCodeBackend()
setBackend(backend)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
