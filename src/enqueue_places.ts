/* eslint-env jquery */
import { Actor } from 'apify';
import { log, sleep } from 'crawlee';
import querystring from 'querystring';

import type { PuppeteerCrawler, RequestQueue, Request } from 'crawlee';

import type { Page, HTTPResponse } from 'puppeteer';
import type { PageStats, Geolocation, SearchMatching, ScrapingOptions, HelperClasses } from './typedefs';

import type { Stats } from './helper-classes/stats.js';
import type { PlacesCache } from './helper-classes/places_cache.js';
import type { MaxCrawledPlacesTracker } from './helper-classes/max-crawled-places.js';
import type { ExportUrlsDeduper } from './helper-classes/export-urls-deduper.js';

import { MAX_PLACES_PER_PAGE, PLACE_TITLE_SEL, NO_RESULT_XPATH, LABELS } from './consts.js';
import { parseZoomFromUrl, moveMouseThroughPage, getScreenshotPinsFromExternalActor, waiter,
    abortRunIfReachedMaxPlaces, doesPlaceMatchSearchTerm } from './utils/misc-utils.js';
import { getPlacesCountInUI } from './utils/search-page.js';
import { parseSearchPlacesResponseBody } from './place-extractors/general.js';
import { checkInPolygon } from './utils/polygon.js';

const SEARCH_WAIT_TIME_MS = 30000;
const CHECK_LOAD_OUTCOMES_EVERY_MS = 500;

interface EnqueuePlacesOptions {
    page: Page;
    requestQueue: RequestQueue;
    request: Request;
    searchString: string;
    exportPlaceUrls: boolean;
    geolocation?: Geolocation;
    placesCache: PlacesCache;
    stats: Stats;
    maxCrawledPlacesTracker: MaxCrawledPlacesTracker;
    exportUrlsDeduper?: ExportUrlsDeduper;
    crawler: PuppeteerCrawler;
    searchMatching: SearchMatching;
}

/**
 * This handler waiting for response from xhr and enqueue places from the search response boddy.
 */
const enqueuePlacesFromResponse = (options: EnqueuePlacesOptions): (response: HTTPResponse, pageStats: PageStats) => Promise<void> => {
    const { page, requestQueue, searchString, request, exportPlaceUrls, geolocation,
        placesCache, stats, maxCrawledPlacesTracker, exportUrlsDeduper, crawler, searchMatching } = options;
    return async (response, pageStats) => {
        const url = response.url();
        const isSearchPage = url.match(/google\.[a-z.]+\/search/);
        const isDetailPreviewPage = !!url.match(/google\.[a-z.]+\/maps\/preview\/place/);
        if (!isSearchPage && !isDetailPreviewPage) {
            return;
        }

        let responseBody;
        let responseStatus;

        pageStats.isDataPage = true;

        try {
            responseStatus = response.status();
            if (responseStatus !== 200) {
                log.warning(`Response status is not 200, it is ${responseStatus}. This might mean the response is blocked`);
            }
            responseBody = await response.text();
            const { placesPaginationData, error } = parseSearchPlacesResponseBody(responseBody, isDetailPreviewPage);
            if (error) {
                // This way we pass the error to the synchronous context where we can throw to retry
                pageStats.error = { message: error, responseStatus, responseBody };
            }
            let index = -1;
            // One is the original URL that was enqueue and one is resolved after redirects which happens quite often on Google Maps
            // e.g. it can redirect to a single place detail
            const searchPageUrl = request.url;
            const searchPageLoadedUrl = page.url();

            // Parse page number from request url
            const queryParams = querystring.parse(url.split('?')[1]);
            const pageNumber = parseInt(queryParams.ech as string, 10);

            // We use local variable so we assign this at one point with all other stats
            // because we depend on it when checking if we should finish
            let enqueued = 0;
            let pushed = 0;

            for (const placePaginationData of placesPaginationData) {
                index++;
                const rank = ((pageNumber - 1) * 20) + (index + 1);
                // TODO: Refactor this once we get rid of the caching
                const coordinates = placePaginationData.coords || placesCache.getLocation(placePaginationData.placeId);
                const placeUrl = `https://www.google.com/maps/search/?api=1&query=${searchString}&query_place_id=${placePaginationData.placeId}`;
                placesCache.addLocation(placePaginationData.placeId, coordinates, searchString);

                const isPlaceMatching = doesPlaceMatchSearchTerm(placePaginationData.title, searchString, searchMatching);
                if (!isPlaceMatching) {
                    log.warning(`Place title "${placePaginationData.title}" does not match search term `
                        + `"${searchString}" using searchMatching "${searchMatching}", skipping...`);
                    continue;
                }

                // true if no geo or coordinates
                const isCorrectGeolocation = checkInPolygon(geolocation, coordinates);
                if (!isCorrectGeolocation) {
                    stats.outOfPolygonCached();
                    stats.outOfPolygon();
                    stats.addOutOfPolygonPlace({ url: placeUrl, searchPageUrl, coordinates });
                    continue;
                }
                if (exportPlaceUrls) {
                    // We must not pass a searchString here because it aborts the whole run
                    // We have to run this code before and after the push because this loop iteration
                    // can be the first or the last one
                    if (!maxCrawledPlacesTracker.canScrapeMore()) {
                        await abortRunIfReachedMaxPlaces({ searchString, request, page, crawler });
                        break;
                    }

                    if (!maxCrawledPlacesTracker.canScrapeMore(searchString)) {
                        break;
                    }
                    const wasAlreadyPushed = exportUrlsDeduper?.testDuplicateAndAdd(placePaginationData.placeId);
                    if (!wasAlreadyPushed) {
                        maxCrawledPlacesTracker.setScraped();
                        pushed++;
                        await Actor.pushData({
                            url: `https://www.google.com/maps/search/?api=1&query=${searchString}&query_place_id=${placePaginationData.placeId}`,
                        });
                    }
                    if (!maxCrawledPlacesTracker.canScrapeMore()) {
                        await abortRunIfReachedMaxPlaces({ searchString, request, page, crawler });
                        break;
                    }
                } else {
                    const searchKey = searchString || request.url;
                    if (!maxCrawledPlacesTracker.setEnqueued(searchKey)) {
                        log.warning(`[SEARCH]: Finishing search because we enqueued more than maxCrawledPlaces `
                            + `currently: ${maxCrawledPlacesTracker.enqueuedPerSearch[searchKey]}(for this search)`
                            + `/${maxCrawledPlacesTracker.enqueuedTotal}(total) `
                            + `--- ${searchString} - ${request.url}`);
                        break;
                    }

                    const { wasAlreadyPresent } = await requestQueue.addRequest({
                        url: placeUrl,
                        uniqueKey: placePaginationData.placeId,
                        userData: {
                            label: LABELS.PLACE,
                            searchString,
                            rank,
                            searchPageUrl,
                            searchPageLoadedUrl,
                            coords: placePaginationData.coords,
                            addressParsed: placePaginationData.addressParsed,
                            isAdvertisement: placePaginationData.isAdvertisement,
                            categories: placePaginationData.categories,
                        },
                    },
                    { forefront: true });
                    if (!wasAlreadyPresent) {
                        enqueued++;
                    } else {
                        // log.warning(`Google presented already enqueued place, skipping... --- ${placeUrl}`)
                        maxCrawledPlacesTracker.enqueuedTotal--;
                        maxCrawledPlacesTracker.enqueuedPerSearch[searchKey]--;
                    }
                }
            }

            pageStats.found = placesPaginationData.length;
            pageStats.totalFound += placesPaginationData.length;
            pageStats.enqueued = enqueued;
            pageStats.totalEnqueued += enqueued;
            pageStats.pushed = pushed;
            pageStats.totalPushed += pushed;

            const numberOfAds = placesPaginationData.filter((item) => item.isAdvertisement).length;
            // Detail preview page goes one by one so should be logged after
            if (isSearchPage) {
                const typeOfResultAction = exportPlaceUrls ? 'Pushed' : 'Enqueued';
                const typeOfResultsCount = exportPlaceUrls ? pageStats.pushed : pageStats.enqueued;
                const typeOfResultsCountTotal = exportPlaceUrls ? pageStats.totalPushed : pageStats.totalEnqueued;
                log.info(`[SEARCH][${searchString}][SCROLL: ${pageStats.pageNum}]: ${typeOfResultAction} ${typeOfResultsCount}/${pageStats.found} `
                    + `places (unique & correct/found) + ${numberOfAds} ads `
                    + `for this page. Total for this search: ${typeOfResultsCountTotal}/${pageStats.totalFound}  --- ${page.url()}`);
            }
        } catch (e) {
            const message = `Unexpected error during response processing: ${(e as Error).message}`;
            pageStats.error = { message, responseStatus, responseBody };
        }
    };
};

/**
 * Periodically checks if one of the possible search outcomes have happened
 */
const waitForSearchResults = async (page: Page) => {
    const start = Date.now();
    // All possible outcomes should be unique, when outcomes happens, we return it
    for (;;) {
        if (Date.now() - start > SEARCH_WAIT_TIME_MS) {
            return { noOutcomeLoaded: true };
        }
        // These must be contains checks because Google sometimes puts an ID into the selector
        const isBadQuery = await page.$('[class *= "section-bad-query"');
        if (isBadQuery) {
            return { isBadQuery: true };
        }

        const hasNoResults = await page.$x(NO_RESULT_XPATH);
        if (hasNoResults.length > 0) {
            return { hasNoResults: true };
        }

        const isPlaceDetail = await page.$(PLACE_TITLE_SEL);
        if (isPlaceDetail) {
            return { isPlaceDetail: true };
        }

        // This is the happy path
        const hasSearchResults = await page.$$('a.hfpxzc');
        if (hasSearchResults.length > 0) {
            return { hasResults: true };
        }

        await page.waitForTimeout(CHECK_LOAD_OUTCOMES_EVERY_MS);
    }
};

interface EnqueueAllPlaceDetailsOptions {
    page: Page;
    searchString: string;
    requestQueue: RequestQueue;
    request: Request;
    crawler: PuppeteerCrawler;
    scrapingOptions: ScrapingOptions;
    helperClasses: HelperClasses;
}

/**
 * Method adds places from listing to queue
 */
export const enqueueAllPlaceDetails = async ({
    page,
    searchString,
    requestQueue,
    request,
    crawler,
    scrapingOptions,
    helperClasses,
}: EnqueueAllPlaceDetailsOptions) => {
    const { geolocation, maxAutomaticZoomOut, exportPlaceUrls, searchMatching } = scrapingOptions;
    const { stats, placesCache, maxCrawledPlacesTracker, exportUrlsDeduper } = helperClasses;

    // The error property is a way to propagate errors from the response handler to this synchronous context
    const pageStats = { error: null,
        isDataPage: false,
        enqueued: 0,
        pushed: 0,
        totalEnqueued: 0,
        totalPushed: 0,
        found: 0,
        totalFound: 0,
        pageNum: 1 };

    const responseHandler = enqueuePlacesFromResponse({
        page,
        requestQueue,
        searchString,
        request,
        exportPlaceUrls,
        geolocation,
        placesCache,
        stats,
        maxCrawledPlacesTracker,
        exportUrlsDeduper,
        crawler,
        searchMatching,
    });

    page.on('response', async (response) => {
        await responseHandler(response, pageStats);
    });

    // Special case that works completely differently
    // TODO: Make it work with scrolling
    if (searchString?.startsWith('all_places_no_search')) {
        await sleep(10000);
        // dismiss covid warning panel
        try {
            await page.click('button[aria-label*="Dismiss"]');
        } catch (e) { /* ignore */ }
        // if specified by user input call OCR to recognize pins
        const isPinsFromOCR = searchString.endsWith('_ocr');
        const pinPositions = isPinsFromOCR ? await getScreenshotPinsFromExternalActor(page) : [];
        if (isPinsFromOCR && !pinPositions?.length) {
            // no OCR results, do not fall back to regular mouseMove
            return;
        }
        await moveMouseThroughPage(page, pageStats, pinPositions);
        log.info(`[SEARCH]: Mouse moving finished, enqueued ${pageStats.enqueued}/${pageStats.found} out of found: ${page.url()}`);
        return;
    }

    // We already have the results loaded but to get them via XHR, we need to click again
    // This is not abosolutely necessary but we would need to rewrite and complicate the parser
    await page.waitForSelector('#searchbox-searchbutton', { timeout: 60_000 });
    await page.click('#searchbox-searchbutton');

    // In the past, we did input flow with typing the search, it is not necessary and it is slow
    // but maybe it had some anti-blocking effect
    // Leaving this comment here until we test current code well and then we can remove it
    // await searchInputBoxFlow(page, searchString);

    const startZoom = /** @type {number} */ (parseZoomFromUrl(page.url()));

    const logBase = `[SEARCH][${searchString}]`;

    // We check if we already processed the response for the newly loaded UI places, if yes, we can continue
    let placesCountInUI = await getPlacesCountInUI(page);
    await waiter(() => pageStats.totalFound >= placesCountInUI, { noThrow: true, timeout: 5000 });
    // Sanity sleep
    await sleep(500);

    // There can be many states other than loaded results
    const { noOutcomeLoaded, hasNoResults, isBadQuery, isPlaceDetail } = await waitForSearchResults(page);

    if (noOutcomeLoaded) {
        throw new Error(`${logBase} Don't recognize the loaded content - ${request.url}`);
    }

    if (isBadQuery) {
        log.warning(`${logBase} Finishing search because this query yielded no results - ${request.url}`);
        return;
    }

    if (hasNoResults) {
        log.warning(`${logBase} Finishing search because there are no results for this query - ${request.url}`);
        return;
    }

    // If we search for very specific place, it redirects us to the place page right away
    // Unofortunately, this page lacks the JSON data as we need it
    // So we still enqueue it separately
    if (isPlaceDetail) {
        log.warning(`${logBase} Finishing scroll because we loaded a single place page directly - ${request.url}`);
        // We must wait a bit for the response to be intercepted
        await waiter(() => pageStats.totalFound > 0, { timeout: 60000, timeoutErrorMeesage: 'Could not enqueue single place in time' });
        return;
    }

    let numberOfEmptyScrolls = 0;
    let lastNumberOfResultsLoadedTotally = 0;

    // Main scrolling/enqueueing loop starts
    for (;;) {
        const logBaseScroll = `${logBase}[SCROLL: ${pageStats.pageNum}]:`;
        // Check if we grabbed all results for this search
        // We also need to check that these were processed already so we don't finish too fast
        const noMoreResults = await page.$('.HlvSq');
        if (noMoreResults) {
            log.info(`${logBase} Finishing search because we reached all ${pageStats.totalFound} results - ${request.url}`);
            return;
        }

        // We also check for number of scrolls that do not trigger more places to have a hard stop
        if (lastNumberOfResultsLoadedTotally === pageStats.totalFound) {
            numberOfEmptyScrolls++;
        } else {
            numberOfEmptyScrolls = 0;
        }
        lastNumberOfResultsLoadedTotally = pageStats.totalFound;
        // They load via XHR only each batch of 20 places so there will be about 6 of empty scrolls
        // but should not be too many
        if (numberOfEmptyScrolls >= 10) {
            log.info(`${logBaseScroll} Finishing scroll with ${pageStats.totalFound} results `
                + `because scrolling doesn't yiled any more results (and is less than maximum ${MAX_PLACES_PER_PAGE}) --- ${request.url}`);
            return;
        }

        if (pageStats.error) {
            const snapshotKey = `SEARCH-RESPONSE-ERROR-${Math.random()}`;
            await Actor.setValue(snapshotKey, (pageStats.error as any).responseBody, { contentType: 'text/plain' });
            const snapshotUrl = `https://api.apify.com/v2/key-value-stores/${Actor.getEnv().defaultKeyValueStoreId}/records/ERROR-SNAPSHOTTER-STATE`;
            throw new Error(`${logBaseScroll} Error occured, will retry the page: ${(pageStats.error as any).message}\n`
                + ` Storing response body for debugging: ${snapshotUrl}\n`
                + `${request.url}`);
        }

        if (!maxCrawledPlacesTracker.canEnqueueMore(searchString || request.url)) {
            // no need to log here because it is logged already in
            return;
        }

        // If Google auto-zoomes too far, we might want to end the search
        let finishBecauseAutoZoom = false;
        if (typeof maxAutomaticZoomOut === 'number') {
            const actualZoom = parseZoomFromUrl(page.url());
            // console.log('ACTUAL ZOOM:', actualZoom, 'STARTED ZOOM:', startZoom);
            const googleZoomedOut = startZoom! - actualZoom!;
            if (googleZoomedOut > maxAutomaticZoomOut) {
                finishBecauseAutoZoom = true;
            }
        }

        if (finishBecauseAutoZoom) {
            log.warning(`${logBaseScroll} Finishing search because Google zoomed out `
                + 'further than maxAutomaticZoomOut. Current zoom: '
                + `${parseZoomFromUrl(page.url())} --- ${searchString} - ${request.url}`);
            return;
        }

        if (pageStats.totalFound >= MAX_PLACES_PER_PAGE) {
            log.info(`${logBaseScroll} Finishing scrolling with ${pageStats.totalFound} results for `
                + `this page because we found maximum (${MAX_PLACES_PER_PAGE}) places per page - ${request.url}`);
            return;
        }

        // This is a bit controversial optimization but in 99% cases it should be fine
        // Google first gives you the most close relevant results
        // Subsequent scrolls give you places further away that might not be in your current map square
        // So if we only get duplicate places on the first scroll, we are super unlikely to get any relevant later
        // NOTE: If you want this to be changed, be very careful how are these populated
        if (pageStats.found > 0 && (pageStats.enqueued + pageStats.pushed) === 0) {
            log.info(`${logBaseScroll} Finishing scrolling with ${pageStats.totalFound} results for `
                + `this page because we only found places we already have or that are outside of required location - ${request.url}`);
            return;
        }

        // We need to have mouse in the left scrolling panel
        await page.mouse.move(10, 300);
        await page.waitForTimeout(100);
        // scroll down the panel
        await page.mouse.wheel({ deltaY: 800 });
        // await waitForGoogleMapLoader(page);
        pageStats.pageNum++;

        // We wait between 2 and 3 sec to simulate real scrolling
        // It seems if we go faster than 2 sec, we sometimes miss some data (not sure why yet)
        await page.waitForTimeout(2000 + Math.ceil(1000 * Math.random()));

        placesCountInUI = await getPlacesCountInUI(page);
        // eslint-disable-next-line no-loop-func
        await waiter(() => pageStats.totalFound >= placesCountInUI, { noThrow: true, timeout: 5000 });
    }
};
