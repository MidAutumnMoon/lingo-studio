import { safeParseInstant } from '@renderer/utils/time'
import type { BrowserVisit } from '@shared/data/api/schemas/browserVisits'

export interface VisitGroup {
  group: string
  header: string
  items: BrowserVisit[]
}

/** Groups visits by local calendar day, labeling today and yesterday relatively. */
export function groupVisitsByDay(visits: BrowserVisit[], locale: string): VisitGroup[] {
  const today = Temporal.Now.plainDateISO()
  const yesterday = today.subtract({ days: 1 })
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'long' })
  const grouped = new Map<string, { label: string; visits: BrowserVisit[] }>()
  for (const visit of visits) {
    const visited = safeParseInstant(visit.visitedAt)?.toZonedDateTimeISO(Temporal.Now.timeZoneId()).toPlainDate()
    if (!visited) continue
    const label = visited.equals(today)
      ? relative.format(0, 'day')
      : visited.equals(yesterday)
        ? relative.format(-1, 'day')
        : dateFormat.format(visited)
    const key = visited.toString()
    const group = grouped.get(key)
    if (group) group.visits.push(visit)
    else grouped.set(key, { label, visits: [visit] })
  }
  return [...grouped.entries()].map(([day, { label, visits }]) => ({ group: day, header: label, items: visits }))
}
