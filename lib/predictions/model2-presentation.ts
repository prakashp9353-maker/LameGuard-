export function model2GeometryStatus(
  primaryClass: string | null,
  validObservationCount: number,
): string | null {
  if (primaryClass === 'limping-cow' || primaryClass === 'healthy-cow') {
    return null
  }
  return validObservationCount > 0
    ? 'Geometry observations available; lameness not assessed.'
    : 'Geometry assessment unavailable'
}
