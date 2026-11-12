import { useEffect, useState } from 'react'
import type { Vehicle } from '../api'
import { LoadingDots } from '../components/LoadingDots'
import { VehicleTable } from '../components/VehicleTable'

export function FleetPage({ onOpen }: { onOpen: (id: string) => void }) {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null)

  useEffect(() => {
    fetch('/api/vehicles')
      .then((response) => response.json())
      .then(setVehicles)
  }, [])

  if (!vehicles) return <LoadingDots />
  return <VehicleTable vehicles={vehicles} onOpen={onOpen} />
}
