import { Actor, log } from "apify";

import type { RequestOptions } from "crawlee";

import type {
    HelperClasses,
    Input,
    PersonalDataOptions,
    ScrapingOptions,
    CrawlerOptions,
} from "./typedefs.js";

import { setUpCrawler } from "./places_crawler.js";
import { Stats } from "./helper-classes/stats.js";
import { ErrorSnapshotter } from "./helper-classes/error-snapshotter.js";
import { PlacesCache } from "./helper-classes/places_cache.js";
import { MaxCrawledPlacesTracker } from "./helper-classes/max-crawled-places.js";
import { ExportUrlsDeduper } from "./helper-classes/export-urls-deduper.js";
import { prepareSearchUrlsAndGeo } from "./utils/search.js";
import {
    makeInputBackwardsCompatible,
    validateInput,
    getValidStartRequests,
    adjustInput,
} from "./utils/input-validation.js";
import {
    parseRequestsFromStartUrls,
    injectSearchTermToUrl,
    getDefaultMaxAndDesiredConcurrency,
} from "./utils/misc-utils.js";
import { setUpEnqueueingInBackground } from "./utils/background-enqueue.js";
import { LABELS } from "./consts.js";
import { reviewsRequestFailCounter } from "./utils/reviewsFailCounter.js";

await Actor.init();

const input = (await Actor.getInput()) as Input;

makeInputBackwardsCompatible(input);
validateInput(input);
adjustInput(input);

const {
    // Search and Start URLs
    startUrls = [],
    searchStringsArray = [],
    allPlacesNoSearchAction = "",
    // Geolocation (country is deprecated but we will leave for a long time)
    lat,
    lng,
    country,
    countryCode,
    state,
    county,
    city,
    postalCode,
    zoom,
    customGeolocation,
    // browser and request options
    pageLoadTimeoutSec = 120,
    useChrome = false,
    maxConcurrency,
    maxPagesPerBrowser = 10,
    maxPageRetries = 6,
    disableFingerprints = false,
    debugFingerprints = false,
    // Misc
    proxyConfig,
    debug = false,
    language = "en",
    headless = true,
    // Search options
    searchMatching = "all",

    // Scraping options
    maxReviews = 0,
    maxImages = 0,
    exportPlaceUrls = false,

    maxCrawledPlacesPerSearch = 9999999,

    maxAutomaticZoomOut,
    reviewsTranslation = "originalAndTranslated",
    reviewsFilterString,
    oneReviewPerRow = false,
    // For some rare places, Google doesn't show all reviews unless in newest sorting
    reviewsSort = "newest",
    reviewsStartDate,
    // Fields used by Heyrick only, not present in the schema (too narrow use-case for now)
    cachePlaces = false,
    useCachedPlaces = false,
    cacheKey = "",

    // Personal data
    scrapeReviewerName = true,
    scrapeReviewerId = true,
    scrapeReviewerUrl = true,
    scrapeReviewId = true,
    scrapeReviewUrl = true,
    scrapeResponseFromOwnerText = true,

    // Just internal for testing now, increase this value to create much less search requests for the same zoom
    // It increases efficiency of compute per place but will miss some places
    polygonSpreadMultiplier = 1,
} = input;

if (debug) {
    log.setLevel(log.LEVELS.DEBUG);
}

// Initializing reviews fail counter, there is a high chance of `server errors 500` by google, so the retries are high
export const reviewsFailCounter = await reviewsRequestFailCounter(
    maxPageRetries < 10 ? 10 : maxPageRetries
);

const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);

// Initializing all the supportive classes in this block
const stats = new Stats();
await stats.initialize();

const errorSnapshotter = new ErrorSnapshotter();
await errorSnapshotter.initialize();

// By default, this is not used and the functions are no-ops
const placesCache = new PlacesCache({ cachePlaces, cacheKey, useCachedPlaces });
await placesCache.initialize();

/** @type {ExportUrlsDeduper | undefined} */
let exportUrlsDeduper;
if (exportPlaceUrls) {
    exportUrlsDeduper = new ExportUrlsDeduper();
    await exportUrlsDeduper.initialize();
}

// Requests that are used in the queue, we persist them to skip this step after migration
const startRequests: RequestOptions[] =
    (await Actor.getValue("START-REQUESTS")) || [];

const requestQueue = await Actor.openRequestQueue();

// We declare geolocation as top level variable so it is constructed only once in memory,
// persisted and then used to check all requests
let geolocation;
let startUrlSearches;
// We crate geolocation only for search. not for Start URLs
if (startUrls.length === 0) {
    // This call is async because it persists geolocation into KV
    ({ startUrlSearches, geolocation } = await prepareSearchUrlsAndGeo({
        lat,
        lng,
        userOverridingZoom: zoom,
        // country is deprecated but we use it for backwards compatibility
        // our search works the same with code or full name
        country: countryCode || country,
        state,
        county,
        city,
        postalCode,
        customGeolocation,
        proxyConfiguration,
        polygonSpreadMultiplier,
    }));

    if (startUrlSearches?.length > 1 && searchStringsArray?.length > 10) {
        log.warning(
            `Extracting more than 10 search terms with geolocation parameters (country, city, county, etc...) is not recommended. ` +
                `Usually, this is a mistake of users that are putting locations into search terms as well.` +
                `You should either use geolocation parameters or put location into search terms, not both.`
        );
    }
}

if (allPlacesNoSearchAction) {
    if (searchStringsArray?.length > 0) {
        log.warning(
            `You cannot use search terms with allPlacesNoSearch option. Clearing them out.`
        );
        searchStringsArray.length = 0;
    }
    searchStringsArray?.push(allPlacesNoSearchAction);
}

if (startRequests.length === 0) {
    // Start URLs have higher preference than search
    if (startUrls.length > 0) {
        if (searchStringsArray?.length) {
            log.warning(
                "\n\n------\nUsing Start URLs disables search. You can use either search or Start URLs.\n------\n"
            );
        }
        // Apify has a tendency to strip part of URL for uniqueKey for Google Maps URLs

        const updatedStartUrls = await parseRequestsFromStartUrls(startUrls);
        const validStartRequests = getValidStartRequests(updatedStartUrls);
        validStartRequests.forEach((req) => startRequests.push(req));
    } else if (searchStringsArray?.length) {
        for (const searchString of searchStringsArray) {
            // Sometimes users accidentally pass empty strings
            if (typeof searchString !== "string" || !searchString.trim()) {
                log.warning(
                    `WRONG INPUT: Search "${searchString}" is not a valid search, skipping`
                );
                continue;
            }
            if (searchString.includes("place_id:")) {
                /**
                 * User can use place_id:<Google place ID> as search query
                 */
                const cleanSearch = searchString.replace(/\s+/g, "");
                const placeId = cleanSearch.match(/place_id:(.*)/)![1];
                startRequests.push({
                    url: `https://www.google.com/maps/search/?api=1&query=${cleanSearch}&query_place_id=${placeId}`,
                    uniqueKey: placeId,
                    userData: { label: LABELS.PLACE, searchString },
                });
            } else if (startUrlSearches) {
                // For each search, we use the geolocated URLs
                for (const startUrlSearch of startUrlSearches) {
                    const urlWithSearchString = searchString.startsWith(
                        "all_places_no_search"
                    )
                        ? startUrlSearch
                        : injectSearchTermToUrl(startUrlSearch, searchString);
                    startRequests.push({
                        url: urlWithSearchString,
                        uniqueKey: urlWithSearchString,
                        userData: { label: LABELS.SEARCH, searchString },
                    });
                }
            }
        }

        // use cached place ids for geolocation
        for (const placeId of placesCache.placesInPolygon(
            geolocation,
            maxCrawledPlacesPerSearch * searchStringsArray.length,
            searchStringsArray
        )) {
            const searchString = searchStringsArray.filter((x) =>
                placesCache.place(placeId)?.keywords.includes(x)
            )[0];
            startRequests.push({
                url: `https://www.google.com/maps/search/?api=1&query=${searchString}&query_place_id=${placeId}`,
                uniqueKey: placeId,
                userData: { label: LABELS.PLACE, searchString, rank: null },
            });
        }
    }

    log.info(
        `Prepared ${startRequests.length} Start URLs (showing first 5 as example):`
    );
    console.dir(startRequests.map((r) => r.url).slice(0, 5));

    await Actor.setValue("START-REQUESTS", startRequests);
    const apifyPlatformKVLink =
        "link: https://api.apify.com/v2/key-value-stores/" +
        `${
            Actor.getEnv().defaultKeyValueStoreId
        }/records/START-REQUESTS?disableRedirect=true`;
    const localLink =
        "local disk: apify_storage/key_value_stores/default/START-REQUESTS.json";
    const link = Actor.isAtHome() ? apifyPlatformKVLink : localLink;
    log.info(`Full list of Start URLs is available on ${link}`);
} else {
    log.warning(
        "Actor was restarted, skipping search step because it was already done..."
    );
}

// We have to define this class here because we can expand new requests during the preparation
const maxCrawledPlaces =
    (searchStringsArray.length || startRequests.length) *
    maxCrawledPlacesPerSearch;
const maxCrawledPlacesTracker = new MaxCrawledPlacesTracker(
    maxCrawledPlaces,
    maxCrawledPlacesPerSearch
);
await maxCrawledPlacesTracker.initialize();

// We enqueue small part of initial requests now and the rest in background
await setUpEnqueueingInBackground(
    startRequests,
    requestQueue,
    maxCrawledPlacesTracker
);

const defaultConcurrency = getDefaultMaxAndDesiredConcurrency(maxConcurrency);
const requestHandlerTimeoutSecs =
    (maxReviews > 30 * 60 ? maxReviews : 30 * 60) * 1.2;

const crawlerOptions: CrawlerOptions = {
    requestQueue,
    proxyConfiguration,
    // This is just passed to gotoFunction
    pageLoadTimeoutSec,
    // long timeout, because of long infinite scroll and reviews loading
    // reviews tend to fail a lot, so we need to retry them
    requestHandlerTimeoutSecs:
        requestHandlerTimeoutSecs < 18000 ? requestHandlerTimeoutSecs : 18000,
    maxRequestRetries: maxPageRetries,
    sessionPoolOptions: {
        sessionOptions: {
            maxErrorScore: 1,
        },
    },
    browserPoolOptions: {
        maxOpenPagesPerBrowser: maxPagesPerBrowser,
        useFingerprints: !disableFingerprints,
    },
    // This crawler often gets into timeout death spiral that increases concurrency without using the CPU (probably stuck on network)
    // So we need to make the concurrency changes slower and smoother
    autoscaledPoolOptions: {
        maxConcurrency: maxConcurrency || defaultConcurrency.maxConcurrency,
        desiredConcurrency: defaultConcurrency.desiredConcurrency,
        // The default is 0.05 but we want to to be slower going up but still relatively fast going down
        scaleUpStepRatio: 0.02,
    },
    launchContext: {
        useChrome,
        launchOptions: {
            headless,
            args: [
                // this is needed to access cross-domain iframes
                "--disable-web-security",
                "--disable-features=IsolateOrigins,site-per-process",
                `--lang=${language}`, // force language at browser level
            ],
        },
    },
};

const personalDataOptions: PersonalDataOptions = {
    scrapeReviewerName,
    scrapeReviewerId,
    scrapeReviewerUrl,
    scrapeReviewId,
    scrapeReviewUrl,
    scrapeResponseFromOwnerText,
};

const scrapingOptions: ScrapingOptions = {
    maxReviews,
    maxImages,
    exportPlaceUrls,
    maxAutomaticZoomOut,
    reviewsSort,
    language,
    reviewsStartDate,
    geolocation,
    reviewsTranslation,
    reviewsFilterString: reviewsFilterString?.trim(),
    searchMatching,
    personalDataOptions,
    oneReviewPerRow,
    allPlacesNoSearchAction,
    debugFingerprints,
};

const helperClasses: HelperClasses = {
    stats,
    errorSnapshotter,
    maxCrawledPlacesTracker,
    placesCache,
    exportUrlsDeduper,
};

// Create and run crawler
const crawler = setUpCrawler({
    crawlerOptions,
    scrapingOptions,
    helperClasses,
});

await crawler.run();
await stats.saveStats();
await placesCache.savePlaces();
await maxCrawledPlacesTracker.persist();

log.info("Scraping finished!");

await Actor.exit();
