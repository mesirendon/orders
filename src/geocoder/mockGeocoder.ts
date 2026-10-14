import { createHash } from 'node:crypto';
import { GeocodingError, type Address, type Coordinates, type Geocoder } from './geocoder.js';

const KNOWN_POSTAL_CODES: Record<string, Coordinates> = {
  '10001': { lat: 40.7506, lng: -73.9972 },
  '02108': { lat: 42.3576, lng: -71.064 },
  '60601': { lat: 41.8853, lng: -87.6216 },
  '75201': { lat: 32.7876, lng: -96.7994 },
  '80202': { lat: 39.7525, lng: -104.9995 },
  '90012': { lat: 34.0614, lng: -118.2385 },
  '94105': { lat: 37.7898, lng: -122.3942 },
  '98101': { lat: 47.6101, lng: -122.3344 },
  '30303': { lat: 33.7529, lng: -84.3902 },
  '33131': { lat: 25.7663, lng: -80.1917 },
};

const BOUNDING_BOX = { minLat: 25, maxLat: 49, minLng: -124, maxLng: -67 };
const POSTAL_CODE_PATTERN = /^[A-Z0-9][A-Z0-9 -]{2,9}$/;

export class MockGeocoder implements Geocoder {
  async geocode(address: Address): Promise<Coordinates> {
    const postalCode = address.postalCode.trim().toUpperCase();
    if (postalCode === '') {
      throw new GeocodingError('postal code is required');
    }

    const known = KNOWN_POSTAL_CODES[postalCode];
    if (known) {
      return known;
    }

    if (!POSTAL_CODE_PATTERN.test(postalCode)) {
      throw new GeocodingError(`cannot geocode postal code "${postalCode}"`);
    }

    const digest = createHash('sha256').update(`${address.country.trim().toUpperCase()}:${postalCode}`).digest();
    const latFraction = digest.readUInt32BE(0) / 0xffffffff;
    const lngFraction = digest.readUInt32BE(4) / 0xffffffff;
    return {
      lat: BOUNDING_BOX.minLat + latFraction * (BOUNDING_BOX.maxLat - BOUNDING_BOX.minLat),
      lng: BOUNDING_BOX.minLng + lngFraction * (BOUNDING_BOX.maxLng - BOUNDING_BOX.minLng),
    };
  }
}
