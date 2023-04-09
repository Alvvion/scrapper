/* eslint-env jquery */
import { Actor, log } from 'apify';
import { puppeteerUtils, PuppeteerCrawler, sleep } from 'crawlee';

import type { PuppeteerCrawlingContext } from 'crawlee';

import { ScrapingOptions, HelperClasses, CrawlerOptions } from './typedefs.js';

import { enqueueAllPlaceDetails } from './enqueue_places.js';
import { handlePlaceDetail } from './detail_page_handle.js';
import { waitAndHandleConsentScreen, waiter, blockRequestsForOptimization } from './utils/misc-utils.js';
import { LABELS } from './consts.js';

const { injectJQuery } = puppeteerUtils;

interface HandlePageFunctionExtendedOptions {
    pageContext: PuppeteerCrawlingContext;
    scrapingOptions: ScrapingOptions;
    helperClasses: HelperClasses;
}

const handlePageFunctionExtended = async ({ pageContext, scrapingOptions, helperClasses }: HandlePageFunctionExtendedOptions) => {
    const { request, page, session, crawler, sendRequest } = pageContext;
    const { stats, errorSnapshotter, maxCrawledPlacesTracker } = helperClasses;

    const { label, searchString } = request.userData as { label: string; searchString: string };

    // TODO: Figure out how to remove the timeout and still handle consent screen
    // Handle consent screen, this wait is ok because we wait for selector later anyway
    await sleep(5000);

    if (request.userData.waitingForConsent !== undefined) {
        await waiter(
            () => request.userData.waitingForConsent === false,
            { timeout: 70000, timeoutErrorMeesage: 'Waiting for cookie consent timeouted, reloading page again' },
        );
    }

    // Inject JQuery crashes on consent screen
    // we need to first approve consent screen before injecting
    await injectJQuery(page);

    // Check if Google shows captcha
    if (await page.$('form#captcha-form')) {
        throw new Error(`[${label}]: Got CAPTCHA on page, retrying --- ${searchString || ''} ${request.url}`);
    }
    if (label === LABELS.SEARCH) {
        if (!maxCrawledPlacesTracker.canEnqueueMore(searchString || request.url)) {
            // No need to log anything here as it was already logged for this search
            return;
        }
        log.info(`[${label}]: Start enqueuing places details for search --- ${searchString || ''} ${request.url}`);
        await errorSnapshotter.tryWithSnapshot(
            page,
            async () => enqueueAllPlaceDetails({
                page,
                searchString,
                requestQueue: crawler.requestQueue!,
                request,
                helperClasses,
                scrapingOptions,
                crawler,
            }),
        );

        log.info(`[${label}]: Enqueuing places finished for --- ${searchString || ''} ${request.url}`);
        stats.maps();
    } else if (label === LABELS.PLACE) {
        // Get data for place and save it to dataset
        log.info(`[${label}]: Extracting details from place url ${page.url()}`);

        await handlePlaceDetail({
            page,
            request,
            searchString,
            session: session!,
            scrapingOptions,
            errorSnapshotter,
            stats,
            maxCrawledPlacesTracker,
            crawler,
            sendRequest,
        });
    } else {
        // This is developer error, should never happen
        throw new Error(`Unkown label "${label}" provided in the Request to the Crawler`);
    }
    stats.ok();
};

interface SetUpCrawlerOptions {
    crawlerOptions: CrawlerOptions;
    scrapingOptions: ScrapingOptions;
    helperClasses: HelperClasses;
}

export const setUpCrawler = ({ crawlerOptions, scrapingOptions, helperClasses }: SetUpCrawlerOptions) => {
    const { maxImages, language, allPlacesNoSearchAction } = scrapingOptions;
    const { pageLoadTimeoutSec, ...options } = crawlerOptions;
    const { stats, errorSnapshotter } = helperClasses;
    return new PuppeteerCrawler({
        ...options,
        preNavigationHooks: [async ({ request, page, session }, gotoOptions) => {
            // TODO: Figure out how to drain the queue from only requests for search strings
            // that reached maxCrawledPlacesPerSearch
            // https://github.com/drobnikj/crawler-google-places/issues/171
            /*
                if (!maxCrawledPlacesTracker.canScrapeMore(request.userData.searchString)) {

                }
            */

            const mapUrl = new URL(request.url);

            await blockRequestsForOptimization(page, request.userData.label, maxImages, allPlacesNoSearchAction);

            if (language) {
                mapUrl.searchParams.set('hl', language);

                await page.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'language', {
                        get() {
                            return language;
                        },
                    });
                    Object.defineProperty(navigator, 'languages', {
                        get() {
                            return [language];
                        },
                    });
                });
            }

            request.url = mapUrl.toString();

            // The idea is that we are using predictable viewports for the polygon splitting
            // But it is always better to use larger viewport to collect as many places as possible
            // We also have to count that the sidebar with places found takes significant portion of the screen
            // TODO: This needs more testing
            if (allPlacesNoSearchAction) {
                // Here we need more predictable viewport so they line up exactly
                await page.setViewport({ width: 800, height: 800 });
            } else {
                // Here we can use larger viewport since we are not limited to the places on the screen as we scroll the search page
                await page.setViewport({ width: 1920, height: 1080 });
            }

            // We must reset this if we crash and retry in the middle of consent approval
            request.userData.waitingForConsent = undefined;

            // Handle consent screen, it takes time before the iframe loads so we need to update userData
            // and block handlePageFunction from continuing until we click on that
            page.on('response', async (res) => {
                try {
                    if (res.url().match(/consent\.google\.[a-z.]+\/(?:intro|m\?)/)) {
                        log.warning('Consent screen loading, we need to approve first!');
                        request.userData.waitingForConsent = true;
                        await page.waitForTimeout(5000);
                        await waitAndHandleConsentScreen(page, request.url, session);
                        request.userData.waitingForConsent = false;
                        log.warning('Consent screen approved! We can continue scraping');
                    }
                } catch (err) {
                    // We have to catch this if browser randomly crashes
                    // This will now timeout in the handlePageFunction and retry from there
                    log.warning(`Error while waiting for consent screen: ${err}`);
                }
            });

            gotoOptions!.timeout = pageLoadTimeoutSec * 1000;
        }],
        requestHandler: async (pageContext) => {
            if (scrapingOptions.debugFingerprints) {
                console.log('Fingerprint launch context');
                const { id, fingerprint } = pageContext.browserController.launchContext;
                await Actor.setValue(`fingerprint`, fingerprint);
                await Actor.setValue(`fingerprint-${id}`, fingerprint);
            }
            await errorSnapshotter.tryWithSnapshot(
                pageContext.page,
                async () => handlePageFunctionExtended({ pageContext, scrapingOptions, helperClasses }),
            );
        },
        failedRequestHandler: async ({ request }, error) => {
            // This function is called when crawling of a request failed too many time
            stats.failed();
            const defaultStore = await Actor.openKeyValueStore();
            await Actor.pushData({
                '#url': request.url,
                '#succeeded': false,
                '#errors': request.errorMessages,
                '#debugFiles': {
                    html: defaultStore.getPublicUrl(`${request.id}.html`),
                    screen: defaultStore.getPublicUrl(`${request.id}.png`),
                },
            });
            log.exception(error as Error, `Page ${request.url} failed ${request.retryCount + 1} `
                + 'times! It will not be retired. Check debug fields in dataset to find the issue.');
        },
    });
};
