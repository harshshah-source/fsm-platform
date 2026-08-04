/** e.g. `FAILED_ACTIVATION` -> "Failed Activation". */
export function formatInstallStatusLabel(status: string): string {
  return status
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}
