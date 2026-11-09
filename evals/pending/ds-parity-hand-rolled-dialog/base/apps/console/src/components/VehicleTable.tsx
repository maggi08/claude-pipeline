import { Badge } from '@fleet/ui'
import type { Vehicle } from '../api'

const STATUS_TONE = { active: 'success', parked: 'neutral', retired: 'warning' } as const

export function VehicleTable({ vehicles, onOpen }: { vehicles: Vehicle[]; onOpen: (id: string) => void }) {
  return (
    <table className="vehicle-table">
      <tbody>
        {vehicles.map((vehicle) => (
          <tr key={vehicle.id} onClick={() => onOpen(vehicle.id)}>
            <td>{vehicle.plate}</td>
            <td>{vehicle.model}</td>
            <td>
              <Badge tone={STATUS_TONE[vehicle.status]}>{vehicle.status}</Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
