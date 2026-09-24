import { DshRuntimeDriver } from './dsh/DshRuntimeDriver'
import { PiRuntimeDriver } from './pi/PiRuntimeDriver'
import { runtimeDriverRegistry } from './registry'

/** Register every built-in runtime at the AgentSessionRuntimeService lifecycle boundary. */
export function registerRuntimeDrivers(): void {
  runtimeDriverRegistry.register(new PiRuntimeDriver())
  runtimeDriverRegistry.register(new DshRuntimeDriver())
}
