import { Button } from '@fleet/ui'
import './ConfirmRemoveDialog.css'

type Props = { open: boolean; plate: string; onCancel: () => void; onConfirm: () => void }

export function ConfirmRemoveDialog({ open, plate, onCancel, onConfirm }: Props) {
  if (!open) return null
  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-box" onClick={(event) => event.stopPropagation()}>
        <h3 className="confirm-title">Remove {plate} from the fleet?</h3>
        <p>Trips and maintenance history stay in the reports.</p>
        <div className="confirm-actions">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Remove
          </Button>
        </div>
      </div>
    </div>
  )
}
