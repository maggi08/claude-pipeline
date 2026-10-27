import type { ReactNode } from 'react'
import { PortalContainerContext } from '../ui/portal'

declare function getSdkContainer(): HTMLElement | null

export function Providers({ children }: { children: ReactNode }) {
  return <PortalContainerContext.Provider value={getSdkContainer()}>{children}</PortalContainerContext.Provider>
}
