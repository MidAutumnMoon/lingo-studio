import { createFileRoute, Outlet } from '@tanstack/react-router'

function SkillsLayout() {
  return <Outlet />
}

export const Route = createFileRoute('/settings/skills')({
  component: SkillsLayout
})
