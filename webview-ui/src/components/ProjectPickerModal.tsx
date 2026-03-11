import { useState, useEffect, useCallback } from 'react'
import { getTauri } from '../ipc/tauri-backend.js'
import {
  modalBackdropStyle,
  modalContainerStyle,
  modalHeaderStyle,
  modalTitleStyle,
  modalCloseButtonStyle,
  menuItemBase,
  HOVER_BG,
} from './modalStyles.js'

interface RecentProject {
  hash: string
  displayName: string
  fullPath: string | null
  lastUsed: number
}

interface ProjectPickerModalProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (folderPath: string) => void
}

function formatRelativeTime(unixSeconds: number): string {
  const now = Date.now() / 1000
  const diff = now - unixSeconds
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return `${Math.floor(diff / 604800)}w ago`
}

const statusStyle: React.CSSProperties = {
  padding: '10px',
  fontSize: '24px',
  color: 'rgba(255, 255, 255, 0.5)',
  textAlign: 'center',
}

export function ProjectPickerModal({ isOpen, onClose, onSelect }: ProjectPickerModalProps) {
  const [projects, setProjects] = useState<RecentProject[]>([])
  const [loading, setLoading] = useState(true)
  const [hovered, setHovered] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    const tauri = getTauri()
    if (!tauri) return
    setLoading(true)
    tauri.core
      .invoke('list_recent_projects')
      .then((result) => setProjects(result as RecentProject[]))
      .catch(() => setProjects([]))
      .finally(() => setLoading(false))
  }, [isOpen])

  const handleBrowse = useCallback(() => {
    const tauri = getTauri()
    if (!tauri) return
    tauri.core.invoke('browse_for_folder').then((result) => {
      if (result) {
        onSelect(result as string)
      }
    })
  }, [onSelect])

  useEffect(() => {
    if (!isOpen) return
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <>
      <div onClick={onClose} style={modalBackdropStyle} />
      <div style={{ ...modalContainerStyle, minWidth: 280, maxWidth: 400 }}>
        <div style={modalHeaderStyle}>
          <span style={modalTitleStyle}>Pick Project</span>
          <button
            onClick={onClose}
            onMouseEnter={() => setHovered('close')}
            onMouseLeave={() => setHovered(null)}
            style={{
              ...modalCloseButtonStyle,
              background: hovered === 'close' ? HOVER_BG : 'transparent',
            }}
          >
            X
          </button>
        </div>

        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          {loading && <div style={statusStyle}>Loading...</div>}
          {!loading && projects.length === 0 && <div style={statusStyle}>No recent projects</div>}
          {!loading &&
            projects.map((project) => {
              const disabled = !project.fullPath
              return (
                <button
                  key={project.hash}
                  onClick={() => {
                    if (project.fullPath) {
                      onSelect(project.fullPath)
                    }
                  }}
                  onMouseEnter={() => !disabled && setHovered(project.hash)}
                  onMouseLeave={() => setHovered(null)}
                  style={{
                    ...menuItemBase,
                    cursor: disabled ? 'default' : 'pointer',
                    opacity: disabled ? 0.4 : 1,
                    background: hovered === project.hash ? HOVER_BG : 'transparent',
                  }}
                  title={project.fullPath ?? 'Path not found'}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 }}>
                    {project.displayName}
                  </span>
                  <span
                    style={{
                      fontSize: '18px',
                      color: 'rgba(255, 255, 255, 0.4)',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    {formatRelativeTime(project.lastUsed)}
                  </span>
                </button>
              )
            })}
        </div>

        <div
          style={{
            borderTop: '1px solid var(--pixel-border)',
            marginTop: '4px',
            paddingTop: '4px',
          }}
        >
          <button
            onClick={handleBrowse}
            onMouseEnter={() => setHovered('browse')}
            onMouseLeave={() => setHovered(null)}
            style={{
              ...menuItemBase,
              justifyContent: 'center',
              background: hovered === 'browse' ? HOVER_BG : 'transparent',
            }}
          >
            Browse...
          </button>
        </div>
      </div>
    </>
  )
}
