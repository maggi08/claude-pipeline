import type { RegistrationError } from '../../api/registration'

/** The text shown under the submit button when the registration is refused. */
export function rawMessage(error: RegistrationError): string {
  const reason = error.reason.trim()
  return reason ? `${error.code}: ${reason}` : error.code
}
