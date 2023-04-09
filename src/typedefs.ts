import type { ProxyConfigurationOptions } from 'apify';
import type { PuppeteerCrawlerOptions, RequestOptions } from 'crawlee';

import type { Stats } from './helper-classes/stats.js';
import type { ErrorSnapshotter } from './helper-classes/error-snapshotter.js';
import type { PlacesCache } from './helper-classes/places_cache.js';
import type { MaxCrawledPlacesTracker } from './helper-classes/max-crawled-places.js';
import type { ExportUrlsDeduper } from './helper-classes/export-urls-deduper.js';

export interface HelperClasses {
    stats: Stats;
    errorSnapshotter: ErrorSnapshotter;
    maxCrawledPlacesTracker: MaxCrawledPlacesTracker;
    placesCache: PlacesCache;
    exportUrlsDeduper?: ExportUrlsDeduper;
}

export type ReviewsTranslation = 'originalAndTranslated' | 'onlyOriginal' | 'onlyTranslated';
export type ReviewsSort = 'newest' | 'mostRelevant' | 'highestRanking' | 'lowestRanking';
export type SearchMatching = 'all' | 'only_exact' | 'only_includes';

export interface ScrapingOptions {
    maxReviews: number;
    maxImages: number;
    maxCrawledPlaces?: number;
    maxCrawledPlacesPerSearch?: number;
    maxAutomaticZoomOut?: number;
    exportPlaceUrls: boolean;
    reviewsSort: ReviewsSort;
    language: string;
    searchMatching: SearchMatching;
    geolocation?: Geolocation;
    reviewsTranslation: ReviewsTranslation;
    reviewsFilterString?: string;
    personalDataOptions: PersonalDataOptions;
    oneReviewPerRow: boolean;
    allPlacesNoSearchAction: string;
    reviewsStartDate?: string;
    debugFingerprints?: boolean;
}

export type CrawlerOptions = Pick<
    PuppeteerCrawlerOptions,
    'requestQueue' | 'proxyConfiguration' | 'browserPoolOptions' | 'maxConcurrency' | 'launchContext' |
    'sessionPoolOptions' | 'requestHandlerTimeoutSecs' | 'maxRequestRetries' | 'autoscaledPoolOptions' >
    & { pageLoadTimeoutSec: number };

export interface Input {
    startUrls?: RequestOptions[];
    allPlacesNoSearchAction: string;
    searchStringsArray?: string[];
    lat?: string;
    lng?: string;
    county?: string;
    country?: string;
    countryCode?: string;
    state?: string;
    city?: string;
    postalCode?: string;
    zoom?: number;
    customGeolocation?: Geolocation;
    pageLoadTimeoutSec?: number;
    useChrome?: boolean;
    maxConcurrency?: number;
    maxPagesPerBrowser?: number;
    maxPageRetries?: number;
    disableFingerprints?: boolean;
    debugFingerprints?: boolean;
    proxyConfig?: ProxyConfigurationOptions & { useApifyProxy?: boolean };
    debug?: boolean;
    language?: string;
    useStealth?: boolean;
    headless?: boolean;
    searchMatching?: SearchMatching;
    maxReviews?: number;
    maxImages?: number;
    exportPlaceUrls?: boolean;
    maxCrawledPlaces?: number;
    maxCrawledPlacesPerSearch?: number;
    maxAutomaticZoomOut?: number;
    cachePlaces?: boolean;
    useCachedPlaces?: boolean;
    cacheKey?: string;
    reviewsSort?: ReviewsSort;
    reviewsTranslation?: ReviewsTranslation;
    reviewsFilterString?: string;
    scrapeReviewerName?: boolean;
    scrapeReviewerId?: boolean;
    scrapeReviewerUrl?: boolean;
    scrapeReviewId?: boolean;
    scrapeReviewUrl?: boolean;
    scrapeResponseFromOwnerText?: boolean;
    oneReviewPerRow?: boolean;
    reviewsStartDate?: string;
    polygonSpreadMultiplier?: number;
}

export interface Review {
    name: string | null;
    text: string;
    publishAt: string;
    publishedAtDate: string;
    likesCount: number;
    reviewId: string | null;
    reviewUrl: string | null;
    reviewerId: string | null;
    reviewerUrl: string | null;
    reviewerPhotoUrl: string | null;
    reviewerNumberOfReviews: number;
    isLocalGuide: boolean;
    stars: number | null;
    rating: number | null;
    responseFromOwnerDate: string | null;
    responseFromOwnerText: string | null;
    reviewImageUrls: string[];
}

export interface PersonalDataOptions {
    scrapeReviewerName: boolean;
    scrapeReviewerId: boolean;
    scrapeReviewerUrl: boolean;
    scrapeReviewId: boolean;
    scrapeReviewUrl: boolean;
    scrapeResponseFromOwnerText: boolean;
}

export interface GeolocationOptions {
    city?: string;
    county?: string;
    state?: string;
    country?: string;
    postalCode?: string;
}

export interface PageStats {
    error: {
        message: string;
        responseStatus?: number;
        responseBody?: string;
    } | null;
    isDataPage: boolean;
    enqueued: number;
    pushed: number;
    totalEnqueued: number;
    totalPushed: number;
    found: number;
    totalFound: number;
    pageNum: number;
}

export interface SearchResultOutcome {
    noOutcomeLoaded?: boolean;
    isBadQuery?: boolean;
    hasNoResults?: boolean;
    isPlaceDetail?: boolean;
    hasResults?: boolean;
}

export interface Coordinates {
    lat: number | null;
    lng: number | null;
}

export interface PlacePaginationData {
    placeId: string;
    coords: Coordinates;
    addressParsed: AddressParsed | undefined;
    isAdvertisement: boolean;
    categories: string[];
    title: string;
}

export interface PlaceUserData {
    rank: number;
    searchPageUrl: string;
    searchPageLoadedUrl: string;
    addressParsed: AddressParsed | undefined;
    isAdvertisement: boolean;
}

export interface AddressParsed {
    neighborhood: string;
    street: string;
    city: string;
    postalCode: string;
    state: string;
    countryCode: string;
}

export interface CachedPlace {
    keywords: string[];
    location: Coordinates;
}

/**
 * geojson parameter from nomatim
 * coordinates have different shape depending on type
 * geometry is only available in few shapes
 * radiusKm is purely our addition for a Point type (circle)
 */
export interface Geolocation {
   type: string,
   coordinates: any,
   geometry: any,
   radiusKm?: number,
}

/**
 * JSON object returned from OpenMaps or provided manually
 * Might contain other fields
 * Sometimes geojson is not provided so we have to use boundingBox
 * User provided customGeolocation should always be GeoJson format
 */
export interface GeolocationFull {
    geojson: Geolocation | undefined;
    boundingbox: string[] | undefined;
    display_name: string | undefined;
}

export interface PopularTimesOutput {
    popularTimesLiveText: string;
    popularTimesLivePercent: number;
    popularTimesHistogram: Record<string, Array<{ hour: number, occupancyPercent: 0 }>>;
}
