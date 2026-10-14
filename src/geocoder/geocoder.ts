export interface Address {
  line1: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface Geocoder {
  geocode(address: Address): Promise<Coordinates>;
}

export class GeocodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeocodingError';
  }
}
