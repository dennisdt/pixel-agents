import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalPanelProps {
  agents: number[]
  selectedAgent: number | null
  onSelectAgent: (id: number) => void
  onCloseAgent: (id: number) => void
  height: number
  externalAgents?: number[]
  agentStatuses?: Record<number, string>
  agentFolderNames?: Record<number, string>
}

interface TerminalInstance {
  term: Terminal
  fit: FitAddon
  wrapper: HTMLDivElement
  unlisten: (() => void) | null
}

const TERMINAL_BG = '#1e1e2e'
const TERMINAL_FG = '#cdd6f4'

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  background: '#181825',
  borderTop: '2px solid #4a4a6a',
  height: 30,
  overflow: 'hidden',
  flexShrink: 0,
}

const tabStyle: React.CSSProperties = {
  padding: '0 12px',
  height: 30,
  lineHeight: '30px',
  fontSize: '20px',
  color: 'rgba(255, 255, 255, 0.5)',
  background: 'transparent',
  border: 'none',
  borderRight: '1px solid #4a4a6a',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const tabActiveStyle: React.CSSProperties = {
  ...tabStyle,
  color: 'rgba(255, 255, 255, 0.9)',
  background: TERMINAL_BG,
}

const closeTabBtnStyle: React.CSSProperties = {
  marginLeft: 6,
  color: 'rgba(255, 255, 255, 0.3)',
  cursor: 'pointer',
  fontSize: '18px',
}

export function TerminalPanel({ agents, selectedAgent, onSelectAgent, onCloseAgent, height, externalAgents, agentStatuses, agentFolderNames }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalsRef = useRef<Map<number, TerminalInstance>>(new Map())

  const getTauri = useCallback(() => window.__TAURI__ ?? window.__TAURI_INTERNALS__, [])

  // Create/destroy terminal instances when agents change
  useEffect(() => {
    const tauri = getTauri()
    if (!tauri) return
    const container = containerRef.current
    if (!container) return

    const current = terminalsRef.current
    const agentSet = new Set(agents)

    // Remove terminals for closed agents
    for (const [id, inst] of current) {
      if (!agentSet.has(id)) {
        inst.unlisten?.()
        inst.term.dispose()
        if (inst.wrapper.parentElement) {
          container.removeChild(inst.wrapper)
        }
        current.delete(id)
      }
    }

    // Create terminals for new agents
    for (const id of agents) {
      if (current.has(id)) continue

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: {
          background: TERMINAL_BG,
          foreground: TERMINAL_FG,
          cursor: '#f5e0dc',
          selectionBackground: 'rgba(90, 140, 255, 0.3)',
        },
        allowProposedApi: true,
      })

      const fit = new FitAddon()
      term.loadAddon(fit)

      // Create a wrapper div for this terminal
      const wrapper = document.createElement('div')
      wrapper.style.cssText = 'position:absolute;inset:0;display:none;'
      container.appendChild(wrapper)

      term.open(wrapper)

      const inst: TerminalInstance = { term, fit, wrapper, unlisten: null }

      // Listen for PTY output
      tauri.event.listen(`pty-output-${id}`, (event) => {
        const payload = event.payload as { data: string }
        term.write(payload.data)
      }).then((unlisten) => {
        inst.unlisten = unlisten
      })

      // Forward input to PTY
      term.onData((data) => {
        tauri.core.invoke('write_pty', { agentId: id, data }).catch((err: unknown) => {
          console.error(`[Terminal] write_pty failed for agent ${id}:`, err)
        })
      })

      // Forward resize to PTY
      term.onResize(({ cols, rows }) => {
        tauri.core.invoke('resize_pty', { agentId: id, cols, rows }).catch((err: unknown) => {
          console.error(`[Terminal] resize_pty failed for agent ${id}:`, err)
        })
      })

      current.set(id, inst)
    }
  }, [agents, getTauri])

  // Show/hide terminal wrappers when selected agent changes + fit
  useEffect(() => {
    const current = terminalsRef.current
    for (const [id, inst] of current) {
      inst.wrapper.style.display = id === selectedAgent ? 'block' : 'none'
    }

    if (selectedAgent !== null) {
      const inst = current.get(selectedAgent)
      if (inst) {
        requestAnimationFrame(() => {
          try {
            inst.fit.fit()
          } catch {
            // Ignore fit errors during mount
          }
        })
      }
    }
  }, [selectedAgent])

  // Re-fit on height change
  useEffect(() => {
    if (selectedAgent === null) return
    const inst = terminalsRef.current.get(selectedAgent)
    if (!inst) return
    requestAnimationFrame(() => {
      try {
        inst.fit.fit()
      } catch {
        // Ignore fit errors
      }
    })
  }, [height, selectedAgent])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const [, inst] of terminalsRef.current) {
        inst.unlisten?.()
        inst.term.dispose()
      }
      terminalsRef.current.clear()
    }
  }, [])

  if (agents.length === 0) {
    const extAgents = externalAgents ?? []

    if (extAgents.length === 0) {
      return (
        <div style={{ height, background: TERMINAL_BG, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.3)', fontSize: '20px' }}>
          No agents running. Click "+ Agent" to start.
        </div>
      )
    }

    return (
      <div style={{ height, background: TERMINAL_BG, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20 }}>
        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '20px' }}>
          Watching {extAgents.length} external session{extAgents.length !== 1 ? 's' : ''}
        </div>
        <div style={{ border: '2px solid var(--pixel-border, #4a4a6a)', background: '#181825', minWidth: 240, maxWidth: 400, width: '100%' }}>
          {extAgents.map((id) => {
            const status = agentStatuses?.[id]
            const folderName = agentFolderNames?.[id] ?? `Agent #${id}`
            const isActive = status === 'active' || status === undefined
            const isWaiting = status === 'waiting'
            const dotColor = isActive ? '#a6e3a1' : isWaiting ? '#f9e2af' : '#6c7086'
            const statusText = isWaiting ? 'waiting' : isActive ? 'active' : (status ?? 'idle')
            return (
              <div
                key={id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  borderBottom: '1px solid #313244',
                  fontSize: '20px',
                }}
              >
                <span style={{ color: dotColor, fontSize: '10px', lineHeight: 1 }}>●</span>
                <span style={{ color: 'rgba(255,255,255,0.7)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folderName}</span>
                <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '18px' }}>{statusText}</span>
              </div>
            )
          })}
        </div>
        <div style={{ color: 'rgba(255,255,255,0.25)', fontSize: '18px' }}>
          Click "+ Agent" to open a new terminal.
        </div>
      </div>
    )
  }

  return (
    <div style={{ height, display: 'flex', flexDirection: 'column', background: TERMINAL_BG }}>
      <div style={tabBarStyle}>
        {agents.map((id) => (
          <div
            key={id}
            style={id === selectedAgent ? tabActiveStyle : tabStyle}
            onClick={() => onSelectAgent(id)}
          >
            Claude Code #{id}
            <span
              style={closeTabBtnStyle}
              onClick={(e) => { e.stopPropagation(); onCloseAgent(id) }}
              title="Close agent"
            >
              ✕
            </span>
          </div>
        ))}
      </div>
      <div
        ref={containerRef}
        style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
      />
    </div>
  )
}
