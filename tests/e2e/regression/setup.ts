import type { Page } from '@playwright/test'

import { dismissTransientDialogs, selectSidebarApp } from './navigation'

export async function prepareScenario(page: Page): Promise<void> {
  await dismissTransientDialogs(page)
  await page.evaluate(async () => {
    await window.api.preference.setMultiple({
      'app.language': 'en-US',
      'app.onboarding.provider_setup.status': 'skipped'
    })
  })
  await selectSidebarApp(page, 'Chat')
}
