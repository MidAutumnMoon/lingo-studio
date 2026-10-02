import type { AppEdition } from '@shared/types/appEdition'

declare global {
  const __APP_EDITION__: AppEdition

  interface ImportMetaEnv {
    readonly MAIN_VITE_CHERRYAI_CLIENT_SECRET: string
  }
}
