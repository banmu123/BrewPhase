import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CapturePage } from './CapturePage'
import './capture.css'

const root = document.getElementById('root')
if (!root) throw new Error('capture root is missing')

createRoot(root).render(
  <StrictMode>
    <CapturePage />
  </StrictMode>
)
