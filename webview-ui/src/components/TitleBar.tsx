import { electronControls } from '../vscodeApi.js'

const TITLE_BAR_HEIGHT = 24

const titleBarStyle = {
  height: TITLE_BAR_HEIGHT,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  background: 'var(--pixel-bg)',
  borderBottom: '2px solid var(--pixel-border)',

  WebkitAppRegion: 'drag',
  userSelect: 'none' as const,
  flexShrink: 0,
  padding: '0 6px',
  zIndex: 200,
}

const titleStyle: React.CSSProperties = {
  fontSize: '18px',
  color: 'var(--pixel-text-dim)',
  letterSpacing: '1px',
}

const btnGroupStyle = {
  display: 'flex',
  gap: 2,

  WebkitAppRegion: 'no-drag',
}

const btnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--pixel-text-dim)',
  fontSize: '16px',
  width: 20,
  height: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  borderRadius: 0,
  padding: 0,
}

export function TitleBar() {
  const controls = electronControls!

  return (
    <div style={titleBarStyle}>
      <span style={titleStyle}>Pixel Agents</span>
      <div style={btnGroupStyle}>
        <button
          style={btnStyle}
          onClick={() => controls.minimizeWindow()}
          title="Minimize"
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--pixel-accent)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--pixel-text-dim)' }}
        >
          &#x2212;
        </button>
        <button
          style={btnStyle}
          onClick={() => controls.closeWindow()}
          title="Close"
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--pixel-close-hover)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--pixel-text-dim)' }}
        >
          &#x00D7;
        </button>
      </div>
    </div>
  )
}
