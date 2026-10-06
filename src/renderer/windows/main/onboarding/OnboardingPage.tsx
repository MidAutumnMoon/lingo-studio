import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { ArrowLeft, Check, KeyRound, Languages } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Scrollbar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip
} from '@cherrystudio/ui'
import { dataApiService } from '@data/DataApiService'
import { usePreference } from '@data/hooks/usePreference'
import AppLogo from '@renderer/assets/images/logo.png'
import { WindowControls } from '@renderer/components/WindowControls'
import { useDefaultModel, useModels } from '@renderer/hooks/useModel'
import { useProviders } from '@renderer/hooks/useProvider'
import { appLanguageOptions, isAppLanguage } from '@renderer/i18n/languages'
import i18n from '@renderer/i18n/resolver'
import ModelSettings from '@renderer/pages/settings/ModelSettings/ModelSettings'
import { ProviderSettingsPage } from '@renderer/pages/settings/ProviderSettings'
import { toast } from '@renderer/services/toast'
import type { OnboardingProviderSetupStatus } from '@shared/data/preference/preferenceTypes'
import type { Model } from '@shared/data/types/model'
import { defaultLanguage } from '@shared/utils/languages'
import { isNonChatModel } from '@shared/utils/model'

type OnboardingStep = 'welcome' | 'provider' | 'select-model'
type OnboardingCompletionStatus = Exclude<OnboardingProviderSetupStatus, 'pending'>

const PESSIMISTIC_PREFERENCE_OPTIONS = { optimistic: false } as const
const isOnboardingModel = (model: Model) => !isNonChatModel(model)
const ONBOARDING_STATUS_PREFERENCE_KEY = 'app.onboarding.provider_setup.status' as const

function OnboardingProviderSettings() {
  const router = useMemo(() => {
    const routeTree = createRootRoute({ component: () => <ProviderSettingsPage /> })
    const history = createMemoryHistory({ initialEntries: ['/'] })
    return createRouter({ routeTree, history })
  }, [])

  return <RouterProvider router={router} />
}

export default function OnboardingPage() {
  const { t } = useTranslation()
  const [language, setLanguage] = usePreference('app.language')
  const [, setProviderSetupStatus] = usePreference(ONBOARDING_STATUS_PREFERENCE_KEY, PESSIMISTIC_PREFERENCE_OPTIONS)
  const { providers: enabledProviders, isLoading: isProvidersLoading } = useProviders({ enabled: true })
  const { models: enabledModels, isLoading: isModelsLoading } = useModels({ enabled: true })
  const { defaultModel, translateModel } = useDefaultModel()
  const [step, setStep] = useState<OnboardingStep>('welcome')
  const [isCompleting, setIsCompleting] = useState(false)
  const eligibleProviderIds = new Set(enabledProviders.map((provider) => provider.id))
  const canCompleteModelSetup = [defaultModel, translateModel].every(
    (model) => model && eligibleProviderIds.has(model.providerId) && isOnboardingModel(model)
  )
  const hasEligibleProvider = eligibleProviderIds.size > 0
  const hasEligibleModel = enabledModels.some(
    (model) => eligibleProviderIds.has(model.providerId) && isOnboardingModel(model)
  )
  const isProviderSetupLoading = isProvidersLoading || isModelsLoading
  const canContinueProviderSetup = !isProviderSetupLoading && hasEligibleProvider && hasEligibleModel
  const providerSetupHint = !isProviderSetupLoading
    ? !hasEligibleProvider
      ? t('onboarding.provider_setup.missing_provider')
      : !hasEligibleModel
        ? t('onboarding.provider_setup.missing_model')
        : null
    : null
  const resolvedLanguage = i18n.resolvedLanguage ?? i18n.language
  const displayLanguage = isAppLanguage(language)
    ? language
    : isAppLanguage(resolvedLanguage)
      ? resolvedLanguage
      : defaultLanguage
  const displayLanguageLabel = appLanguageOptions.find((option) => option.value === displayLanguage)?.label

  const updateSeededResourceModels = useCallback(async (model: Model) => {
    const assistantUpdate = dataApiService
      .get('/assistants', { query: { limit: 2 } })
      .then(async ({ items, total }) => {
        const assistant = total === 1 ? items[0] : undefined
        // Only the freshly seeded assistant has no model yet; a user-edited one keeps its model.
        if (assistant && assistant.modelId == null) {
          await dataApiService.patch(`/assistants/${assistant.id}`, { body: { modelId: model.id } })
        }
      })

    await assistantUpdate
  }, [])

  const handleLanguageChange = (value: string) => {
    if (!isAppLanguage(value)) return

    void i18n.changeLanguage(value)
    void setLanguage(value)
  }

  const complete = useCallback(
    async (status: OnboardingCompletionStatus) => {
      setIsCompleting(true)
      try {
        if (status === 'completed' && defaultModel) {
          await updateSeededResourceModels(defaultModel)
        }
        await setProviderSetupStatus(status)
      } catch {
        toast.error(t('onboarding.toast.complete_failed'))
      } finally {
        setIsCompleting(false)
      }
    },
    [defaultModel, setProviderSetupStatus, t, updateSeededResourceModels]
  )

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-sidebar text-foreground">
      <div className="drag flex h-[var(--app-top-chrome-height)] shrink-0 items-stretch justify-end">
        <div className="nodrag mr-2 flex items-center gap-1">
          <div data-onboarding-language-select="" className="nodrag">
            <Select value={displayLanguage} onValueChange={handleLanguageChange}>
              <SelectTrigger
                aria-label={t('common.language')}
                size="sm"
                className="nodrag h-7 w-auto gap-1.5 border-0 bg-transparent px-2 text-muted-foreground text-xs shadow-none hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50 focus-visible:text-foreground aria-expanded:border-transparent aria-expanded:ring-0 dark:bg-transparent [&_svg]:size-3.5 [&_svg]:opacity-60">
                <Languages className="size-3.5" />
                <SelectValue>{displayLanguageLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                {appLanguageOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span aria-hidden="true">{option.flag}</span>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="nodrag text-muted-foreground hover:text-foreground"
            onClick={() => void complete('skipped')}
            disabled={isCompleting}>
            {t('onboarding.skip')}
          </Button>
        </div>
        <WindowControls />
      </div>

      <div className="flex min-h-0 flex-1 px-2 pb-2">
        <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border-[0.5px] border-border bg-background">
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {step === 'welcome' && (
              <div className="flex h-full w-full items-center justify-center px-6 pb-20">
                <div className="flex w-full max-w-[420px] flex-col items-center">
                  <img src={AppLogo} alt="Cherry Studio" className="size-16 rounded-xl" />
                  <div className="mt-5 flex flex-col gap-2 text-center">
                    <h1 className="m-0 font-semibold text-2xl text-foreground">{t('onboarding.welcome.title')}</h1>
                    <p className="m-0 text-muted-foreground text-sm">{t('onboarding.welcome.subtitle')}</p>
                  </div>
                  <div className="mt-8 flex w-full flex-col gap-3">
                    <Button
                      type="button"
                      size="lg"
                      className="h-11 w-full rounded-xl"
                      onClick={() => setStep('provider')}>
                      <KeyRound size={16} />
                      {t('onboarding.welcome.other_provider')}
                    </Button>
                  </div>
                  <p className="mt-4 mb-0 text-center text-muted-foreground text-xs">
                    {t('onboarding.welcome.setup_hint')}
                  </p>
                </div>
              </div>
            )}

            {step === 'provider' && (
              <div className="flex h-full min-h-0 w-full flex-col">
                <OnboardingHeader
                  title={t('onboarding.provider_setup.title')}
                  onBack={() => setStep('welcome')}
                  padded
                />
                <div className="min-h-0 flex-1 border-border border-y">
                  <OnboardingProviderSettings />
                </div>
                <div className="flex shrink-0 justify-end gap-2 px-5 py-3">
                  <Button type="button" variant="outline" onClick={() => setStep('welcome')}>
                    {t('common.back')}
                  </Button>
                  <Tooltip
                    content={providerSetupHint}
                    placement="top"
                    classNames={{
                      content:
                        'dark:bg-neutral-100 dark:text-neutral-900 dark:[&_svg]:fill-neutral-100! dark:[&_svg]:stroke-neutral-100!'
                    }}>
                    <Button
                      type="button"
                      aria-disabled={!canContinueProviderSetup}
                      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                      onClick={() => canContinueProviderSetup && setStep('select-model')}>
                      {t('onboarding.provider_setup.next')}
                    </Button>
                  </Tooltip>
                </div>
              </div>
            )}

            {step === 'select-model' && (
              <div className="flex h-full min-h-0 w-full flex-col">
                <OnboardingHeader
                  title={t('onboarding.select_model.title')}
                  onBack={() => setStep('provider')}
                  padded
                />
                <Scrollbar className="flex min-h-0 flex-1 justify-center border-border border-t px-6 py-8">
                  <div className="my-auto w-full max-w-[440px]">
                    <div className="w-full">
                      <ModelSettings
                        autoFillEmptyModels
                        onDefaultModelSelected={updateSeededResourceModels}
                        showSettingsButton={false}
                        showDescription={false}
                        showDividers={false}
                        showPaintingModel={false}
                        modelFilter={isOnboardingModel}
                        compact
                        className="mt-4 min-h-0 w-full flex-none overflow-visible"
                      />
                      <div className="mt-5 flex flex-col items-center gap-3">
                        <Button
                          type="button"
                          size="lg"
                          className="w-full"
                          loading={isCompleting}
                          disabled={!canCompleteModelSetup}
                          onClick={() => void complete('completed')}>
                          <Check size={16} />
                          {t('onboarding.select_model.start')}
                        </Button>
                        <p className="m-0 text-center text-muted-foreground text-xs">
                          {t('onboarding.select_model.change_later')}
                        </p>
                      </div>
                    </div>
                  </div>
                </Scrollbar>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

interface OnboardingHeaderProps {
  title: string
  onBack: () => void
  padded?: boolean
}

function OnboardingHeader({ title, onBack, padded = false }: OnboardingHeaderProps) {
  return (
    <div className={padded ? 'flex shrink-0 items-center gap-3 px-5 py-4' : 'flex shrink-0 items-center gap-3 py-4'}>
      <Button type="button" variant="outline" size="icon-sm" className="shrink-0" onClick={onBack} aria-label={title}>
        <ArrowLeft size={15} />
      </Button>
      <div className="flex min-w-0 flex-1 items-center">
        <h2 className="m-0 truncate font-semibold text-base text-foreground">{title}</h2>
      </div>
    </div>
  )
}
