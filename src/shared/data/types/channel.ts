import * as z from 'zod'

// ---- Per-channel-type config schemas ----

export const TelegramChannelConfigSchema = z.object({
  type: z.literal('telegram'),
  bot_token: z.string(),
  allowed_chat_ids: z.array(z.string()).default([])
})

export type TelegramChannelConfig = z.infer<typeof TelegramChannelConfigSchema>

export const QQChannelConfigSchema = z.object({
  type: z.literal('qq'),
  app_id: z.string(),
  client_secret: z.string(),
  allowed_chat_ids: z.array(z.string()).default([]),
  mention_only: z.boolean().optional()
})

export type QQChannelConfig = z.infer<typeof QQChannelConfigSchema>

export const WeChatChannelConfigSchema = z.object({
  type: z.literal('wechat'),
  token_path: z.string(),
  allowed_chat_ids: z.array(z.string()).default([])
})

export type WeChatChannelConfig = z.infer<typeof WeChatChannelConfigSchema>

export const DiscordChannelConfigSchema = z.object({
  type: z.literal('discord'),
  bot_token: z.string(),
  allowed_channel_ids: z.array(z.string()).default([])
})

export type DiscordChannelConfig = z.infer<typeof DiscordChannelConfigSchema>

export const SlackChannelConfigSchema = z.object({
  type: z.literal('slack'),
  bot_token: z.string(),
  app_token: z.string(),
  allowed_channel_ids: z.array(z.string()).default([])
})

export type SlackChannelConfig = z.infer<typeof SlackChannelConfigSchema>

// ---- Discriminated union ----

export const ChannelConfigSchema = z.discriminatedUnion('type', [
  TelegramChannelConfigSchema,
  QQChannelConfigSchema,
  WeChatChannelConfigSchema,
  DiscordChannelConfigSchema,
  SlackChannelConfigSchema
])

export type ChannelConfig = z.infer<typeof ChannelConfigSchema>

export const CHANNEL_TYPES = ['telegram', 'qq', 'wechat', 'discord', 'slack'] as const
export type ChannelType = (typeof CHANNEL_TYPES)[number]

export interface ChannelStatus {
  channelId: string
  connected: boolean
  error?: string
}
