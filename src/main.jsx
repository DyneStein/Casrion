import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// The header clears the window controls differently per OS: Windows draws
// them top-right, macOS keeps the traffic lights top-left. A platform class
// on <body> lets the CSS pad the correct side.
if (navigator.userAgent.includes('Mac')) document.body.classList.add('platform-mac')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
