import { useEffect, useState } from 'react'
import { getVehicle, type Vehicle } from '../api'

export function VehiclePage({ id }: { id: string }) {
  const [vehicle, setVehicle] = useState<Vehicle | null>(null)

  useEffect(() => {
    getVehicle(id).then(setVehicle)
  }, [id])

  if (!vehicle) return null
  return (
    <main className="vehicle-page">
      <h1>{vehicle.plate}</h1>
      <p>{vehicle.model}</p>
    </main>
  )
}
