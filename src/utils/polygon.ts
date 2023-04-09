import { log, ProxyConfiguration } from 'apify';
import { sleep } from 'crawlee';
import turf from '@turf/turf';
import { gotScraping } from 'got-scraping';

import fs from 'fs';

import type { Geolocation, Coordinates, GeolocationOptions, GeolocationFull } from '../typedefs';

const TURF_UNIT = 'kilometers';

const GEO_TYPES = {
    MULTI_POLYGON: 'MultiPolygon',
    POLYGON: 'Polygon',
    POINT: 'Point',
    LINE_STRING: 'LineString',
};

const FEATURE_COLLECTION = 'FeatureCollection';
const FEATURE = 'Feature';

function getPolygonFromBoundingBox(boundingbox: string[]) {
    const numberBBox = boundingbox.map(Number);
    // Format for their bounding box is [lat, lat, long, long]
    // Format of their coordinate points in [long, lat]
    // First and last position must be the same and it has to be nested like this
    return [[
        [numberBBox[2], numberBBox[0]],
        [numberBBox[2], numberBBox[1]],
        [numberBBox[3], numberBBox[0]],
        [numberBBox[3], numberBBox[1]],
        [numberBBox[2], numberBBox[0]],
    ]];
}

/**
 * Checks if provided coordinates are inside a geolocation
 * If no coordinates or geo is provided, this returns true (ease of use for non geolocated searches)
 */
export const checkInPolygon = (geolocation?: Geolocation, coordinates?: Coordinates) => {
    if (!geolocation || !coordinates || !coordinates.lng || !coordinates.lat) {
        return true;
    }
    const point = turf.point([coordinates.lng, coordinates.lat]);
    let included = false;
    const polygons = getPolygons(geolocation);
    for (const polygon of polygons) {
        included = turf.booleanContains(polygon, point);
        if (included) break;
    }
    return included;
};

const getPolygons = (geolocation: Geolocation): (turf.Feature<turf.Polygon | turf.MultiPolygon> | turf.Polygon | turf.MultiPolygon)[] => {
    const { coordinates, type, geometry, radiusKm = 5 } = geolocation;
    if (type === GEO_TYPES.POLYGON) {
        return [turf.polygon(coordinates)];
    }

    if (type === FEATURE && geometry.type === GEO_TYPES.POLYGON) {
        return [geometry];
    }

    // We got only the point for city, lets create a circle...
    if (type === GEO_TYPES.POINT) {
        return [turf.circle(coordinates, radiusKm, { units: TURF_UNIT })];
    }

    // Line (road or street) - find midpoint and length and create circle
    if (type === GEO_TYPES.LINE_STRING) {
        const firstPoint = turf.point(coordinates[0]);
        const lastPoint = turf.point(coordinates[coordinates.length - 1]);
        const midPoint = turf.midpoint(firstPoint, lastPoint);

        const line = turf.lineString(coordinates);
        const length = turf.length(line, { units: TURF_UNIT });

        return [turf.circle(midPoint, length, { units: TURF_UNIT })];
    }

    // Multipolygon
    return coordinates.map((coords: any) => turf.polygon(coords));
};

// Sadly, even some bigger cities (Bremer­haven) are not found by the API
// Maybe we need to find a fallback
export const getGeolocation = async (options: GeolocationOptions, proxyConfiguration?: ProxyConfiguration) => {
    const { city, state, country, postalCode, county } = options;

    // NOTES:
    // 1. Unfortunately, openstreet maps don't work well with country codes so we have to convert back to full names
    // via our schema mapping
    // 2. Openstreet maps doesn't support some tiny countries as country search or they are states of different countries
    // actually, you can check the samples/openstreetmap-countries.json
    // To work around this, if there is only a country, we will use "q" as general query instead of "country"

    let countryName;
    try {
        const inputSchema = JSON.parse(fs.readFileSync('./.actor/INPUT_SCHEMA.json', 'utf8'));
        const { countryCode } = inputSchema.properties;
        const countryIndex = countryCode.enum.indexOf(country);
        countryName = countryCode.enumTitles[countryIndex];
    } catch (e) {
        log.warning(`Was not able to load country names from INPUT_SCHEMA.json, using country code instead. Error: ${e}`);
    }

    const cityString = (city || '').trim().replace(/\s+/g, '+');
    const stateString = (state || '').trim().replace(/\s+/g, '+');
    const countyString = (county || '').trim().replace(/\s+/g, '+');
    let countryString = (countryName || country || '').trim().replace(/\s+/g, '+');
    const postalCodeString = (postalCode || '').trim().replace(/\s+/g, '+');

    // Special case for Congo and Korea that have 2 countries, we need to swap the name
    // e.g. Congo, Democratic Republic of the => Democratic Republic of the Congo
    if (countryString.includes(',')) {
        const [first, second] = countryString.split(',');
        countryString = `${second}+${first}`;
    }

    log.info(`Finding geolocation for country: ${countryString}, state: ${stateString}, `
        + `county: ${countyString}, city: ${cityString}, postal code: ${postalCodeString}`);

    const queryAsString = countryString && !stateString && !countyString && !cityString && !postalCodeString
        ? `q=${countryString}&`
        : '';

    // TODO when get more results? Currently only first match is returned!
    let res;
    let tries = 1;
    for (;;) {
        try {
            res = await (gotScraping as any)({
                url: encodeURI(`https://nominatim.openstreetmap.org/search?${queryAsString}country=${countryString}&state=${stateString}&county=${countyString}&city=${cityString}&postalcode=${postalCodeString}&format=json&polygon_geojson=1&limit=1&polygon_threshold=0.005`),
                headers: { referer: 'http://google.com' },
                // We first test without proxy for speed
                proxyUrl: tries > 1 && proxyConfiguration ? proxyConfiguration.newUrl() : undefined,
            });
            break;
        } catch (e) {
            log.warning(`Error while getting geolocation on try ${tries} Error: ${e}`);
        }
        if (tries >= 3) {
            throw new Error('Could not get geolocation from Openstreetmaps, please file an issue or contact support@apify.com');
        }
        tries++;
        await sleep(5000);
    }
    const body = JSON.parse(res.body);
    const geolocationFull = body[0];
    if (!geolocationFull) {
        throw new Error('[Geolocation]: Location not found! Check that you wrote it correctly. If yes, please file an issue for this actor.');
    }
    log.info(`[Geolocation]: Location found: ${geolocationFull.display_name}, lat: ${geolocationFull.lat}, long: ${geolocationFull.lon}`);
    return geolocationFull;
};

/**
 * Calculates distance meters per pixel for zoom and latitude.
 */
const distanceByZoom = (lat: number, zoom: number) => {
    return 156543.03392 * (Math.cos((lat * Math.PI) / 180) / (2 ** zoom));
};

/**
 * Throws error if geojson and boundingbox are missing
 * Calculates geojson from bouding box
 */
export const getGeoJson = (geolocationFull: GeolocationFull): Geolocation => {
    const { geojson, boundingbox } = geolocationFull;

    if (geojson) {
        return geojson;
    }

    if (!boundingbox) {
        throw new Error(`[Geolocation]: Could not find geojson or bounding box in geolocation for ${geolocationFull.display_name}`);
    }
    return {
        coordinates: getPolygonFromBoundingBox(boundingbox),
        type: GEO_TYPES.POLYGON,
        geometry: undefined,
    };
};

/**
 *  Prepare centre points grid for search
 */
export const findPointsInPolygon = async (geolocation: Geolocation, zoom: number, polygonSpreadMultiplier: number): Promise<{ lat: number, lon: number}[]> => {
    const { coordinates, type } = geolocation;
    if (!coordinates && ![FEATURE_COLLECTION, FEATURE].includes(type)) return [];

    const points = [];
    // If we have a point add it to result
    if (type === GEO_TYPES.POINT) {
        const [lon, lat] = coordinates;
        points.push({ lon, lat });
    }
    // If we have a line add a first and last point
    if (type === GEO_TYPES.LINE_STRING) {
        const pointsToProcess = [coordinates[0], coordinates[coordinates.length - 1]];
        pointsToProcess.forEach((point) => {
            const [lon, lat] = point;
            points.push({ lon, lat });
        });
    }
    const polygons = getPolygons(geolocation);

    polygons.forEach((polygon) => {
        const bbox = turf.bbox(polygon);
        // distance in meters per pixel * viewport / 1000 meters
        let distanceKilometers = distanceByZoom(bbox[3], zoom) * (800 / 1000) * polygonSpreadMultiplier;
        // Creates grid of points inside given polygon
        let pointGrid = null;
        // point grid can be empty for to large distance.
        while (distanceKilometers > 0) {
            log.debug('distanceKilometers', { distanceKilometers });
            // Use lower distance for points
            const distance = geolocation.type === GEO_TYPES.POINT ? distanceKilometers / 2 : distanceKilometers;

            const options = {
                units: 'kilometers',
                mask: polygon,
            };
            // TODO: Type option was wrong before but it is working
            pointGrid = turf.pointGrid(bbox, distance, options as any);

            if (pointGrid.features && pointGrid.features.length > 0) break;
            distanceKilometers -= 1;
        }
        if (pointGrid) {
            pointGrid.features.forEach((feature) => {
                const { geometry } = feature;
                if (geometry) {
                    const [lon, lat] = geometry.coordinates;
                    points.push({ lon, lat });
                    // points.push(feature); // http://geojson.io is nice tool to check found points on map
                }
            });
        }
    });
    return points;
};
