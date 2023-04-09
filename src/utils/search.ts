import { log, Actor } from 'apify';

import type { ProxyConfiguration } from 'apify';

import { GEO_TO_DEFAULT_ZOOM } from '../consts.js';
import { getGeolocation, findPointsInPolygon, getGeoJson } from './polygon.js';

import type { Geolocation, GeolocationOptions } from '../typedefs.js';

const getMatchingDefaultZoom = ({ country, state, county, city, postalCode }: GeolocationOptions) => {
    // We start with the most specific that should get highest zoom
    if (postalCode) {
        return GEO_TO_DEFAULT_ZOOM.postalCode;
    }
    if (city) {
        return GEO_TO_DEFAULT_ZOOM.city;
    }
    if (county) {
        return GEO_TO_DEFAULT_ZOOM.county;
    }
    if (state) {
        return GEO_TO_DEFAULT_ZOOM.state;
    }
    if (country) {
        return GEO_TO_DEFAULT_ZOOM.country;
    }
    return GEO_TO_DEFAULT_ZOOM.default;
};

interface PrepareSearchUrlsAndGeoOptions extends GeolocationOptions {
    lat?: string;
    lng?: string;
    userOverridingZoom?: number;
    customGeolocation?: Geolocation;
    proxyConfiguration?: ProxyConfiguration;
    polygonSpreadMultiplier: number;
}

// DON'T CHANGE THE FORMAT OF THE GENERATED URLS AS THE SEARCH TERMS INJECTION DEPENDS ON IT!
export const prepareSearchUrlsAndGeo = async ({
    lat, lng, userOverridingZoom, country, state, county, city, postalCode, customGeolocation, proxyConfiguration, polygonSpreadMultiplier,
}: PrepareSearchUrlsAndGeoOptions) => {
    // Base part of the URLs to make up the startRequests
    const startUrlSearches = [];

    const zoom = userOverridingZoom || getMatchingDefaultZoom({ country, state, county, city, postalCode });
    log.info(`Using zoom ${zoom} to define the search. `
        + `Higher zoom takes exponentially more time to run but is able to extract more (usually less known) places`
        + `You can override the default zoom in input`);

    let geolocation;

    // preference for startUrlSearches is state & city > lat & lng
    // because people often use both and we want to split the map for more results
    if (customGeolocation || country || state || county || city || postalCode) {
        let fullGeolocation = null;
        if (customGeolocation) {
            log.warning(`Using provided customGeolocation`);
            fullGeolocation = { geojson: customGeolocation, boundingbox: undefined, display_name: undefined };
        }
        if (!fullGeolocation) {
            // Store so we don't have to call it again
            fullGeolocation = await Actor.getValue('GEO');
        }
        if (!fullGeolocation) {
            fullGeolocation = await getGeolocation({ country, state, county, city, postalCode }, proxyConfiguration);
        }
        if (fullGeolocation) {
            await Actor.setValue('GEO', fullGeolocation);
            geolocation = getGeoJson(fullGeolocation);

            const points = await findPointsInPolygon(geolocation, zoom, polygonSpreadMultiplier);
            for (const point of points) {
                startUrlSearches.push(`https://www.google.com/maps/search/@${point.lat},${point.lon},${zoom}z`);
            }
            log.info(`Splitted the map into ${startUrlSearches.length} search page base URLs for each search term to ensure maximum coverage .`);
        }
    } else if (lat || lng) {
        if (!lat || !lng) {
            throw new Error('You have to define both lat and lng!');
        }
        startUrlSearches.push(`https://www.google.com/maps/search/@${lat},${lng},${zoom}z`);
    } else {
        startUrlSearches.push('https://www.google.com/maps/search');
    }
    return { startUrlSearches, geolocation };
};
