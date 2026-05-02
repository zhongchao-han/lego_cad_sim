import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { ThumbnailGenerator } from './ThumbnailGenerator.tsx'

// 离线 GPU 提图工具走独立路由：必须在 App 挂载前分流，
// 否则 App 内的 useStore/useEffect 会被 hooks-rules 视为条件调用。
const Root = window.location.pathname === '/generator' ? <ThumbnailGenerator /> : <App />

createRoot(document.getElementById('root')).render(Root)
