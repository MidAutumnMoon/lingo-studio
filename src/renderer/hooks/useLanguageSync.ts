import { useEffect } from 'react'

import { usePreference } from '@data/hooks/usePreference'
import i18n from '@renderer/i18n/resolver'
import { defaultLanguage } from '@shared/utils/languages'

/**
 * Keep i18next's active language in sync with the `app.language` preference.
 *
 * The initial language is already applied by `prepareWindow`'s `initI18n()`; this
 * hook only reacts to runtime preference changes. It is the shared language owner
 * for every UI window (main / subWindow / selection-action /
 * selection-toolbar). Date formatting is locale-independent (fixed numeric
 * patterns via `utils/time.ts`), so no date-locale sync exists.
 */
export function useLanguageSync(): void {
  const [language] = usePreference('app.language')

  useEffect(() => {
    void i18n.changeLanguage(language || navigator.language || defaultLanguage)
  }, [language])
}
