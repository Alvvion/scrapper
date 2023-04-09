import { Actor, log } from 'apify';

import type { KeyValueStore } from 'apify';

import type { Coordinates, Geolocation } from '../typedefs';

import { checkInPolygon } from '../utils/polygon.js';

// Only used for Heyrick customer, enabled by input
// TODO: Re-evaluate if we should not remove this
export class PlacesCache {
    cachePlaces: boolean;
    allPlaces: Record<string, any> = {};
    isLoaded = false;
    cacheKey: string;
    useCachedPlaces: boolean;

    constructor({ cachePlaces = false, cacheKey, useCachedPlaces }: { cachePlaces?: boolean; cacheKey: string; useCachedPlaces: boolean }) {
        this.cachePlaces = cachePlaces;
        this.cacheKey = cacheKey;
        this.useCachedPlaces = useCachedPlaces;
    }

    /**
     * Load cached places if caching if enabled.
     */
    async initialize() {
        // By default this is a no-op
        if (this.cachePlaces) {
            log.debug('Load cached places');
            this.allPlaces = await this.loadPlaces();
            log.info('[CACHE] cached places loaded.');

            Actor.on('persistState', async () => {
                await this.savePlaces();
            });
        }

        // mark as loaded
        this.isLoaded = true;
    }

    /**
     * loads cached data
     * @returns {Promise<{}>}
     */
    async loadPlaces(): Promise<Record<string, any>> {
        const allPlacesStore = await this.placesStore();

        return allPlacesStore ? (await allPlacesStore.getValue(this.keyName()) || {}) : {};
    }

    async placesStore(): Promise<KeyValueStore> {
        return Actor.openKeyValueStore('Places-cached-locations');
    }

    /**
     * returns key of cached places
     */
    keyName(): string {
        return this.cacheKey ? `places-${this.cacheKey}` : 'places';
    }

    /**
     * Add place to cache
     */
    addLocation(placeId: string, location: Coordinates, keyword: string) {
        if (!this.cachePlaces) return;
        const place = this.place(placeId) || { location, keywords: [] };
        place.keywords = [...(place.keywords || []), keyword];
        this.allPlaces[placeId] = place;
    }

    /**
     * @param {string} placeId
     * @returns {null|typedefs.CachedPlace}
     */
    place(placeId: string) {
        if (!this.cachePlaces || !this.allPlaces[placeId]) return null;
        if (this.allPlaces[placeId].lat) {
            // backward compatible with older cache version
            return { location: this.allPlaces[placeId], keywords: [] };
        }
        return this.allPlaces[placeId];
    }

    getLocation(placeId: string): Coordinates | null {
        if (!this.cachePlaces || !this.place(placeId)) return null;
        return (this.place(placeId) || {}).location || null;
    }

    /**
     * Save places cache.
     */
    async savePlaces() {
        // By default this is a no-op
        if (this.cachePlaces) {
            if (!this.isLoaded) throw new Error('Cannot save before loading old data!');

            const allPlacesStore = await this.placesStore();
            const reloadedPlaces = await this.loadPlaces();

            const newPlaces = { ...reloadedPlaces, ...this.allPlaces };

            await allPlacesStore.setValue(this.keyName(), newPlaces);
            log.info('[CACHE] places saved');
        }
    }

    /**
     * Find places for specific polygon a keywords.
     */
    placesInPolygon(geolocation: Geolocation | undefined, maxCrawledPlaces: number, keywords: string[] = []): string[] {
        const arr: string[] = [];

        if (!this.cachePlaces || !this.useCachedPlaces) return arr;
        for (const placeId of Object.keys(this.allPlaces)) {
            // check if cached location is desired polygon and has at least one search string currently needed
            const place = this.place(placeId) || { keywords: [] };

            if (checkInPolygon(geolocation, this.getLocation(placeId)!)
                && (place.keywords.length === 0 || place.keywords.filter((x: string) => keywords.includes(x)).length > 0)) {
                arr.push(placeId);
            }
            if (maxCrawledPlaces && maxCrawledPlaces !== 0 && arr.length >= maxCrawledPlaces) {
                break;
            }
        }
        return arr;
    }
};
