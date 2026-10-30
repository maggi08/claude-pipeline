import { is404Error } from '../../shared/http/errors'

export async function fetchSupplierRegistration(id: string): Promise<{ id: string } | null> {
  try {
    const response = await fetch(`/api/suppliers/${id}/registration`)
    if (!response.ok) throw Object.assign(new Error('request failed'), { status: response.status })
    return await response.json()
  } catch (error) {
    if (is404Error(error)) return null
    throw error
  }
}
