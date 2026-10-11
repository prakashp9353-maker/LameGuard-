import type { PredictionResponse } from '@/lib/predictions/api'

export async function savePrediction(file: File, result: PredictionResponse) {
  const form = new FormData()
  form.append('file', file)
  form.append('result', result.signed_payload)
  form.append('input_sha256', result.input_sha256)
  form.append('signature', result.signature)

  let response: Response
  try {
    response = await fetch('/api/predictions', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15 * 60_000),
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'TimeoutError') {
      throw new Error('Saving the analysis timed out. Check Supabase Storage and try again.')
    }
    throw new Error('Could not reach the secure prediction-saving route.')
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(`The secure save route returned an unreadable response (${response.status}).`)
  }
  if (!response.ok) {
    const detail =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : `The prediction could not be saved (${response.status}).`
    throw new Error(detail)
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('id' in payload) ||
    typeof payload.id !== 'string'
  ) {
    throw new Error('Supabase did not return the saved prediction ID.')
  }
  return { id: payload.id }
}
