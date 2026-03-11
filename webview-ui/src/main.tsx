import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { setBackend } from './ipc/backend.js'
import { VsCodeBackend } from './ipc/vscode-backend.js'
import { TauriBackend, isTauri } from './ipc/tauri-backend.js'
import App from './App.tsx'

// Initialize backend before rendering
const backend = isTauri() ? new TauriBackend() : new VsCodeBackend()
setBackend(backend)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
