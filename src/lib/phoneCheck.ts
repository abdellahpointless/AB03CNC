import { countryPath, currentRegion } from './instance';

/*
 * QR codes on the machines. Each code holds the address of the country's app with the machine:
 *   https://<site>/ma/?check=HAAS-1
 * Scanning it with a phone opens the sign-in page if needed, then only that machine's checks,
 * laid out for a phone. The PC way (Preventive actions tab) is unchanged.
 */

export const CHECK_PARAM = 'check';

const MACHINE_ID = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

/** The machine named by the address (a scanned QR code), or null. */
export function scannedMachine(search: string = typeof location === 'undefined' ? '' : location.search): string | null {
  const raw = new URLSearchParams(search).get(CHECK_PARAM);
  const id = raw?.trim().toUpperCase() ?? '';
  return MACHINE_ID.test(id) ? id : null;
}

/** The address a machine's QR code opens. */
export function checkUrl(machineId: string, origin: string = typeof location === 'undefined' ? '' : location.origin): string {
  return `${origin}${countryPath(currentRegion().id)}?${CHECK_PARAM}=${encodeURIComponent(machineId)}`;
}

/** Leaves the phone screen for the full app (the address loses the machine). */
export function leavePhoneCheck(): void {
  try {
    history.replaceState(null, '', location.pathname);
  } catch {
    /* ignore */
  }
}
