import { application } from '@application'
import { authorizeTokenDanceApiKey } from '@main/services/tokenDanceOAuth'
import type { oauthRequestSchemas } from '@shared/ipc/schemas/oauth'
import type { IpcHandlersFor } from '@shared/ipc/types'

import { mapOAuthSignInCancellation, runOAuthSignIn } from './oauthSignIn'

const runtime = () => application.get('OAuthRuntimeService')

export const oauthHandlers: IpcHandlersFor<typeof oauthRequestSchemas> = {
  'oauth.sign_in': async ({ providerId, requestId }, ctx) => {
    const { accountId } = await runOAuthSignIn(ctx.senderId, providerId, requestId)
    return { accountId }
  },
  'oauth.sign_in.attach': ({ providerId, requestId }, ctx) =>
    mapOAuthSignInCancellation(runtime().joinActiveSignIn(ctx.senderId, providerId, requestId)),
  'oauth.cancel_sign_in': ({ providerId, requestId }, ctx) =>
    runtime().cancelSignIn(ctx.senderId, providerId, requestId),
  'oauth.has_token': ({ providerId }) => runtime().hasToken(providerId),
  'oauth.get_account': ({ providerId }) => runtime().getAccount(providerId),
  'oauth.logout': ({ providerId }) => runtime().logout(providerId),
  'oauth.tokendance.authorize_api_key': () => authorizeTokenDanceApiKey()
}
