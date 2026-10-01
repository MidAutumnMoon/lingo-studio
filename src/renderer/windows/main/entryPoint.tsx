import '@renderer/assets/styles/index.css'
import '@renderer/assets/styles/tailwind.css'
import { createRoot } from 'react-dom/client'

import { registerOfflineIcons } from '@renderer/services/offlineIcons'
import { prepareWindow } from '@renderer/windows/prepareWindow'

import MainApp from './MainApp'

registerOfflineIcons()
await prepareWindow({ preference: 'all' })

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(<MainApp />)
