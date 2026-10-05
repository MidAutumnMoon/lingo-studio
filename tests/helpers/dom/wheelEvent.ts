type WheelEventFields = Partial<Record<'clientX' | 'clientY' | 'ctrlKey' | 'metaKey' | 'shiftKey', number | boolean>>

// happy-dom's WheelEvent drops init-dict MouseEvent fields (modifiers, clientX/Y);
// pin whatever the environment did not carry over onto the instance.
export function pinWheelEventFields(event: WheelEvent, fields: WheelEventFields): WheelEvent {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || (event as unknown as Record<string, unknown>)[key] === value) continue
    Object.defineProperty(event, key, { configurable: true, value })
  }
  return event
}

export function fireWheel(
  element: Element,
  init: { bubbles?: boolean; cancelable?: boolean; deltaY: number } & WheelEventFields
): WheelEvent {
  const { bubbles = false, cancelable = true, deltaY, ...fields } = init
  const event = new WheelEvent('wheel', { bubbles, cancelable, deltaY })
  pinWheelEventFields(event, fields)
  element.dispatchEvent(event)
  return event
}
