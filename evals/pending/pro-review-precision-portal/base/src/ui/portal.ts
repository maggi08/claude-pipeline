import { createContext, useContext } from 'react'

export const PortalContainerContext = createContext<HTMLElement | null>(null)

/** Where dialogs render: the container the app provided (the host document's node when embedded), else document.body. */
export function usePortalContainer(): HTMLElement {
  return useContext(PortalContainerContext) ?? document.body
}
