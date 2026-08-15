import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'

// The header clears the window controls differently per OS: Windows draws
// them top-right, macOS keeps the traffic lights top-left. A platform class
// on <body> lets the CSS pad the correct side.
if (navigator.userAgent.includes('Mac')) document.body.classList.add('platform-mac')

// Last line of defence. Anything that gets past the boundaries inside the app
// lands here rather than unmounting the tree and leaving a blank window.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary
      label="App"
      title="Casrion hit a problem"
      hint="Your notes are untouched. They are plain Markdown files on disk and nothing here writes to them."
      onReload={() => window.location.reload()}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
