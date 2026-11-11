import { useEffect, useState } from 'react'
import { getVehicle, removeVehicle, type Vehicle } from '../api'
import { ConfirmRemoveDialog } from '../components/ConfirmRemoveDialog'
import { MaintenanceStatus } from '../components/MaintenanceStatus'
import { ToolbarButton } from '../components/ToolbarButton'

export function VehiclePage({ id, onRemoved }: { id: string; onRemoved: () => void }) {
  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    getVehicle(id).then(setVehicle)
  }, [id])

  async function remove() {
    await removeVehicle(id)
    setConfirming(false)
    onRemoved()
  }

  if (!vehicle) return null
  return (
    <main className="vehicle-page">
      <div className="vehicle-page__toolbar">
        <ToolbarButton onClick={() => setConfirming(true)}>Remove from fleet</ToolbarButton>
      </div>
      <h1>{vehicle.plate}</h1>
      <p>{vehicle.model}</p>
      <MaintenanceStatus status={vehicle.maintenance} />
      <ConfirmRemoveDialog open={confirming} plate={vehicle.plate} onCancel={() => setConfirming(false)} onConfirm={remove} />
    </main>
  )
}
