import * as Location from 'expo-location';

/**
 * #57 CONTEXT §339: ON_SITE capture is best-effort and silent — off/denied/failed all fall back to
 * `undefined` (never throws), so the caller can always post `target: 'ON_SITE'` with or without a
 * location and let the server decide `AUTO_GEOFENCE` vs `MANUAL`. No client geofence math.
 */
export async function captureLocation(): Promise<{ lat: number; lng: number } | undefined> {
  try {
    const servicesEnabled = await Location.hasServicesEnabledAsync();
    if (!servicesEnabled) return undefined;
    const { granted } = await Location.requestForegroundPermissionsAsync();
    if (!granted) return undefined;
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: position.coords.latitude, lng: position.coords.longitude };
  } catch {
    return undefined;
  }
}
