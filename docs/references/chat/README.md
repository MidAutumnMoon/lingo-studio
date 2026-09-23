---
description: Current chat-domain map covering shared renderer modules, page-owned adapters, rich clipboard, and the message tree
sources:
  - src/renderer/components/chat
  - src/renderer/components/composer
  - src/renderer/components/Sidebar
  - src/renderer/pages/home/messages
  - src/renderer/pages/home/Tabs
  - src/renderer/pages/agents/messages
  - src/main/data/services/MessageService.ts
---

# Chat Reference

The chat domain spans reusable renderer modules, page-owned adapters, composer UI,
and the main-process message tree. There is no root
`@renderer/components/chat` barrel or generic `components/chat/adapters/`
directory; consumers import from the module that owns the capability.

## Current ownership

| Path | Responsibility |
|---|---|
| `src/renderer/components/chat/messages/` | Shared message-list contracts, rendering, actions, tools, markdown, streaming, and list behavior |
| `src/renderer/components/chat/actions/` | Generic action descriptors/registry plus current topic and session action sets |
| `src/renderer/components/chat/{resourceList,shell,panes,flow}/` | Shared resource navigation, conversation shell, auxiliary panes, and topic-tree visualization |
| `src/renderer/components/composer/` | Shared composer surface and its Chat/Agent variants |
| `src/renderer/pages/{home,agents}/messages/` | Page-owned projections from business state into the shared message-list contract |
| `src/main/data/services/MessageService.ts` | SQLite-backed topic-message tree operations and invariants |

The repository previously carried target-architecture documents for a generic
adapter layer and root package barrel. Those APIs did not land; the current
reference set documents implemented behavior only.

## Chat left area

The chat page has one layout. The app sidebar carries both the app entries and the assistant
list (`components/Sidebar` renders it from resolved rows; `hooks/useAssistantSidebarSection.tsx`
owns the data, grouping, and entity menu, and `hooks/useAssistantNavigation.ts` opens an
assistant's conversation — its latest topic, or a reusable placeholder — through the tab-URL
channel). The single list pane is that assistant's history: time buckets with pinned first,
two-line rows (`RESOURCE_LIST_ROW_LAYOUTS.history`), and a scoped `activeAssistantId`
(`null` = conversations whose assistant is gone). The chat bar names the open conversation and
the composer carries the assistant/model control.

The retired alternatives — a per-assistant grouping mode, a configurable list side, and a
right-panel copy of the topic list — are gone, along with the preferences that selected them
(`topic.tab.display_mode`, `topic.tab.position`).

## Documents

| Document | What it covers |
|---|---|
| [Composer Rich Clipboard](./composer-rich-clipboard.md) | Private clipboard format that preserves composer tokens across copy/paste, its restore rules, and ownership boundaries |
| [Message Tree](./message-tree.md) | The topic message-tree model: adjacency list, virtual root, sibling groups, invariants, delete semantics, consumer contract |
