import { Actor, log } from 'apify';

import type { Coordinates } from '../typedefs';

interface InnerStats {
    failed: number,
    ok: number,
    outOfPolygon: number,
    outOfPolygonCached: number,
    places: number,
    maps: number,
}

interface PlaceOutOfPolygon {
    url: string,
    searchPageUrl: string,
    coordinates: Coordinates,
}

export class Stats {
    stats: InnerStats;
    placesOutOfPolygon: PlaceOutOfPolygon[];
    statsKVKey: string;
    placesOutOfPolygonKVKey: string;
    persistBatchSize: number;

    constructor() {
        this.stats = { failed: 0, ok: 0, outOfPolygon: 0, outOfPolygonCached: 0, places: 0, maps: 0 };
        this.placesOutOfPolygon = [];
        this.statsKVKey = 'STATS';
        this.placesOutOfPolygonKVKey = 'PLACES-OUT-OF-POLYGON';
        this.persistBatchSize = 10000;
    }

    async initialize() {
        const loadedStats = await Actor.getValue(this.statsKVKey) as InnerStats | undefined;
        if (loadedStats) {
            this.stats = loadedStats;
        }
        await this.loadPlacesOutsideOfPolygon();

        Actor.on('persistState', async () => {
            await this.saveStats();
        });
    }

    async logInfo() {
        const statsArray = [];

        for (const [key, value] of Object.entries(this.stats)) {
            statsArray.push(`${key}: ${value}`);
        }

        log.info(`[STATS]: ${statsArray.join(' | ')}`);
    }

    async saveStats() {
        await Actor.setValue(this.statsKVKey, this.stats);
        await this.persitsPlacesOutsideOfPolygon();
        await this.logInfo();
    }

    failed() {
        this.stats.failed++;
    }

    ok() {
        this.stats.ok++;
    }

    outOfPolygon() {
        this.stats.outOfPolygon++;
    }

    maps() {
        this.stats.maps++;
    }

    places() {
        this.stats.places++;
    }

    outOfPolygonCached() {
        this.stats.outOfPolygonCached++;
    }

    addOutOfPolygonPlace(placeInfo: PlaceOutOfPolygon) {
        this.placesOutOfPolygon.push(placeInfo);
    }

    async persitsPlacesOutsideOfPolygon() {
        if (this.placesOutOfPolygon.length === 0) {
            return;
        }
        for (let i = 0; i < this.placesOutOfPolygon.length; i += this.persistBatchSize) {
            const slice = this.placesOutOfPolygon.slice(i, i + this.persistBatchSize);
            await Actor.setValue(`${this.placesOutOfPolygonKVKey}-${i / this.persistBatchSize}`, slice);
        }
    }

    async loadPlacesOutsideOfPolygon() {
        for (let i = 0; ; i += this.persistBatchSize) {
            const placesOutOfPolygonSlice = await Actor.getValue(
                `${this.placesOutOfPolygonKVKey}-${i / this.persistBatchSize}`,
            ) as PlaceOutOfPolygon[] | undefined;
            if (!placesOutOfPolygonSlice) {
                return;
            }
            this.placesOutOfPolygon = this.placesOutOfPolygon.concat(placesOutOfPolygonSlice);
        }
    }
}
