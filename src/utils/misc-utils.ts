import { Actor, log } from 'apify';
import { puppeteerUtils, RequestOptions, sleep } from 'crawlee';
import { gotScraping } from 'got-scraping';

import type { Session, PuppeteerCrawler, Request } from 'crawlee';
import type { Page } from 'puppeteer';

import type { SearchMatching } from '../typedefs.js';

import { DEFAULT_TIMEOUT, PLACE_TITLE_SEL, BACK_BUTTON_SEL, LABELS } from '../consts.js';

const { blockRequests } = puppeteerUtils;

/**
 * Wait until google map loader disappear
 */
export const waitForGoogleMapLoader = async (page: Page) => {
    if (await page.$('#searchbox')) {
        await page.waitForFunction(() => !document.querySelector('#searchbox')!
            .classList.contains('loading'), { timeout: DEFAULT_TIMEOUT });
    }
    // 2019-05-19: New progress bar
    await page.waitForFunction(() => !document.querySelector('.loading-pane-section-loading'), { timeout: DEFAULT_TIMEOUT });
};

export const fixFloatNumber = (float: number): number => Number(float.toFixed(7));

export const getScreenshotPinsFromExternalActor = async (page: Page) => {
    const base64Image = await page.screenshot({ encoding: 'base64' });
    const ocrActorRun = await Actor.call('alexey/google-maps-pins-map-ocr', { base64Image, mapURL: page.url() }, { memory: 256 });
    if (ocrActorRun?.status !== 'SUCCEEDED') {
        log.error('getScreenshotPinsFromExternalActor', ocrActorRun);
        return [];
    }
    const externalDataset = await Actor.openDataset(ocrActorRun.defaultDatasetId, { forceCloud: true });
    const externalTAData = await externalDataset.getData({ clean: true });
    log.info(`[OCR]: Found ${externalTAData.items.length} pin(s) by run ${ocrActorRun?.id} for ${page.url()}`);
    // recalculate coordinates to pin center (current pin is 20x20px)
    const positionsFromActor = externalTAData.items.map((coords) => {
        return {
            x: coords!.x + 10,
            y: coords!.y + 10,
        };
    });
    return positionsFromActor;
};

export const moveMouseThroughPage = async (page: Page, pageStats: { enqueued: number }, ocrCoordinates: { x: number, y: number}[]) => {
    const plannedMoves = ocrCoordinates || [];
    // If we do not have coordinates from OCR actor then fill in viewport
    const viewport = page.viewport();
    if (!ocrCoordinates?.length && viewport) {
        const { width, height } = viewport;
        // If you move with less granularity, places are missed
        for (let y = 0; y < height; y += 10) {
            for (let x = 0; x < width; x += 10) {
                plannedMoves.push({ x, y });
            }
        }
    }
    log.info(`[SEARCH]: Starting moving mouse over the map to gather all places. `
        + `Will do ${plannedMoves.length} mouse moves. This might take a few minutes: ${page.url()}`);
    let done = 0;
    for (const { x, y } of plannedMoves) {
        if (done !== 0 && done % 500 === 0) {
            log.info(`[SEARCH]: Mouse moves still in progress: ${done}/${plannedMoves.length}. Enqueued so far: ${pageStats.enqueued} --- ${page.url()}`);
        }
        await page.mouse.move(x, y, { steps: 5 });
        // mouse trick for processing OCR, otherwise places might be missed because mouse moved too fast
        if (ocrCoordinates?.length) {
            // wait for place detection
            await sleep(1000);
            // move a bit and wait again
            await page.mouse.move(x + 4, y + 4, { steps: 5 });
            await sleep(1000);
            // go back to top left corner to hide popup with preview
            // otherwise it might overlap with places nearby and prevent them from detection
            await page.mouse.move(0, 0, { steps: 5 });
            await sleep(1000);
        }
        done++;
    }
};

const convertGoogleSheetsUrlToCsvDownload = (sheetUrl: string): string | null => {
    const CSV_DOWNLOAD_SUFFIX = 'gviz/tq?tqx=out:csv';
    // The lazy (+?) regex is important because we don't want to capture other slashes
    const baseUrlMatches = sheetUrl.match(/^.*docs.google.com\/spreadsheets\/d\/.+?\//g);

    if (!baseUrlMatches || baseUrlMatches.length === 0) {
        log.error(`Invalid start url provided (${sheetUrl}).
        Google spreadsheet url must contain: docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/`);
        return null;
    }

    const baseUrl = baseUrlMatches[0];
    const downloadRequestUrl = `${baseUrl}${CSV_DOWNLOAD_SUFFIX}`;

    log.info(`Converting Google Sheets URL to a standardized format. If this doesn't work, please create an issue`);
    log.info(`${sheetUrl} => ${downloadRequestUrl}`);

    return downloadRequestUrl;
};

const fetchRowsFromCsvFile = async (downloadUrl: string): Promise<string[]> => {
    const { body } = await gotScraping({ url: downloadUrl });
    const rows = body.replace(/[";]/g, '').split('\n');

    return Array.from(new Set(rows));
};

const isGoogleSpreadsheetFile = (fileUrl: string): boolean => {
    const googleSpreadsheetMatches = fileUrl.match(/docs.google.com\/spreadsheets/g);
    return googleSpreadsheetMatches?.length === 1;
};

const parseStartUrlsFromFile = async (fileUrl: string): Promise<string[]> => {
    let startUrls: string[] = [];

    if (isGoogleSpreadsheetFile(fileUrl)) {
        const dowloadUrl = convertGoogleSheetsUrlToCsvDownload(fileUrl);
        if (dowloadUrl) {
            startUrls = await fetchRowsFromCsvFile(dowloadUrl);
        } else {
            log.warning(`WRONG INPUT: Google Sheets URL cannot be converted to CSV. `);
        }
    } else {
        // We assume it is some text file
        startUrls = await fetchRowsFromCsvFile(fileUrl);
    }

    const trimmedStartUrls = startUrls.map((url) => url.trim());
    return trimmedStartUrls.filter((url) => url.length);
};

export const parseRequestsFromStartUrls = async (
    startUrls: (RequestOptions & { requestsFromUrl?: string})[],
): Promise<{ url: string, uniqueKey: string }[]> => {
    /**
     * @type {  }
     */
    let updatedStartUrls: { url: string, uniqueKey: string }[] = [];

    /**
     * `uniqueKey` is specified explicitly for each request object
     * as SDK otherwise wrongly normalizes it
     */

    for (const request of startUrls) {
        if (typeof request === 'string') {
            updatedStartUrls.push({
                url: request,
                uniqueKey: request,
            });
        } else {
            const { url, requestsFromUrl } = request;
            if (requestsFromUrl) {
                const parsedStartUrls = await parseStartUrlsFromFile(requestsFromUrl);
                const parsedRequests = parsedStartUrls.map((urlInner: string) => ({
                    url: urlInner,
                    uniqueKey: url,
                }));
                updatedStartUrls = updatedStartUrls.concat(parsedRequests);
            } else {
                updatedStartUrls.push({
                    ...request,
                    uniqueKey: url,
                });
            }
        }
    }

    return updatedStartUrls;
};

// TODO: create robust URL parser for all types of Google Maps URLs
export const parseZoomFromUrl = (url: string): number | null => {
    const zoomMatch = url.match(/@[0-9.-]+,[0-9.-]+,([0-9.]+)z/);
    return zoomMatch ? Number(zoomMatch[1]) : null;
};

// e.g. https://www.google.es/maps/search/%2B34%20518%2010%2017%2004/@39.7068778,-7.0277654,6.5z
export const parseSearchTermFromUrl = (url: string): string | undefined => {
    const match = url.match(/\/search\/([^/]+)\//);
    if (match) {
        return decodeURIComponent(match[1]);
    }
    return undefined;
};

export const doesPlaceMatchSearchTerm = (placeTitle: string, searchTerm: string, searchMatching: SearchMatching) => {
    // If something goes wrong, we don't want to skip the place
    if (!placeTitle || !searchTerm || !searchMatching) {
        return true;
    }

    if (searchMatching === 'all') {
        return true;
    }

    const placeTitleLower = placeTitle.toLowerCase().trim();
    const searchTermLower = searchTerm.toLowerCase().trim();
    if (searchMatching === 'only_exact') {
        return placeTitleLower === searchTermLower;
    }

    if (searchMatching === 'only_includes') {
        return placeTitleLower.includes(searchTermLower);
    }

    return undefined;
};

interface WaiterOptions {
    timeout?: number;
    pollInterval?: number;
    timeoutErrorMeesage?: string;
    successMessage?: string;
    noThrow?: boolean;
}

/**
 * Waits until a predicate (funcion that returns bool) returns true
 *
 * ```
 * let eventFired = false;
 * await waiter(() => eventFired, { timeout: 120000, pollInterval: 1000 })
 * // Something happening elsewhere that will set eventFired to true
 * ```
 */
export const waiter = async (predicate: () => boolean | Promise<boolean>, options: WaiterOptions = {}) => {
    const { timeout = 120000, pollInterval = 1000, timeoutErrorMeesage, successMessage, noThrow = false } = options;
    const start = Date.now();
    for (;;) {
        if (await predicate()) {
            if (successMessage) {
                log.info(successMessage);
            }
            return;
        }
        const waitingFor = Date.now() - start;
        if (waitingFor > timeout) {
            if (noThrow) {
                return;
            }
            throw new Error(timeoutErrorMeesage || `Timeout reached when waiting for predicate for ${waitingFor} ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
};

/**
 * Navigates back to the details page
 * either by clicking back button or reloading the main page
 */
export const navigateBack = async (page: Page, pageLabel: string, placeUrl: string) => {
    const title = await page.$(PLACE_TITLE_SEL);
    if (title) {
        log.info('[PLACE]: We are still on the details page -> no back navigation needed');
        return;
    }
    try {
        const backButtonPresent = async () => {
            const backButton = await page.$(BACK_BUTTON_SEL);
            return backButton != null;
        };
        await waiter(backButtonPresent, {
            timeout: 2000,
            pollInterval: 500,
            timeoutErrorMeesage: `Waiting for backButton on ${pageLabel} page ran into a timeout after 2s on URL: ${placeUrl}`,
        });
        const navigationSucceeded = async () => {
            const backButton = await page.$(BACK_BUTTON_SEL);
            if (backButton) {
                await backButton.evaluate((backButtonNode) => {
                    if (backButtonNode instanceof HTMLElement) {
                        backButtonNode.click();
                    }
                });
            }
            const titleInner = await page.$(PLACE_TITLE_SEL);
            if (titleInner) {
                return true;
            }
            return false;
        };
        await waiter(navigationSucceeded, {
            // timeout: 10000,
            // pollInterval: 500,
            timeoutErrorMeesage: `Waiting for back navigation on ${pageLabel} page ran into a timeout after 10s on URL: ${placeUrl}`,
        });
    } catch (e) {
        // As a last resort, we just reload the main page
        log.warning(`${(e as Error).message} - will hard reload the place page instead`);
        try {
            await page.goto(placeUrl);
            await page.waitForSelector(PLACE_TITLE_SEL);
            await puppeteerUtils.injectJQuery(page);
        } catch (err) {
            throw new Error('Reloading the page to navigate back failed, retrying whole request');
        }
    }
};

export const waitAndHandleConsentScreen = async (page: Page, url: string, session?: Session) => {
    const predicate = async (shouldClick = false) => {
        // handling consent page (usually shows up on startup), handles non .com domains
        const consentButton = await page.$('[action^="https://consent.google"] button');
        if (consentButton) {
            if (shouldClick) {
                await Promise.all([
                    page.waitForNavigation({ timeout: 60000 }),
                    consentButton.click(),
                ]);
            }
            return true;
        }
        // handling consent frame in maps
        // (this only happens rarely, but still happens)
        for (const frame of page.mainFrame().childFrames()) {
            if (frame.url().match(/consent\.google\.[a-z.]+/)) {
                if (shouldClick) {
                    await frame.click('#introAgreeButton');
                }
                return true;
            }
        }
        return false;
    };

    /**
     * Puts the CONSENT Cookie into the session
     */
    const updateCookies = async () => {
        if (session) {
            const cookies = await page.cookies(url);
            // Without changing the domain, apify won't find the cookie later.
            // Changing the domain can duplicate cookies in the saved session state, so only the necessary cookie is saved here.
            if (cookies) {
                const consentCookie = cookies.filter((cookie) => cookie.name === 'CONSENT')[0];
                // overwrite the pending cookie to make sure, we don't set the pending cookie when Apify is fixed
                session.setCookies([{ ...consentCookie }], 'https://www.google.com/');
                if (consentCookie) {
                    consentCookie.domain = 'www.google.com';
                }
                session.setCookies([consentCookie], 'https://www.google.com/');
            }
        } else {
            log.warning('Session is undefined -> consent screen cookies not saved');
        }
    };

    await waiter(predicate, {
        timeout: 60000,
        pollInterval: 500,
        timeoutErrorMeesage: `Waiting for consent screen timeouted after 60000ms on URL: ${url}`,
        successMessage: `Approved consent screen on URL: ${url}`,
    });
    await predicate(true);
    await updateCookies();
};

//

/**
 * Only certain formats of place URLs will give the JSON with data
 * Examples in /samples/URLS-PLACE.js
 * The core of data parameter seems to be data=!4m2!3m1!1s0x470b94c1ffba5d57:0xe357d0d58f1979d7
 */
export const normalizePlaceUrl = (url: string): string => {
    // We just need to find that 1s hex number part and add the first 2 params (!4m2!3m1) to it
    let pathname;
    let origin;
    try {
        ({ pathname, origin } = new URL(url));
    } catch (e) {
        log.warning(`Cannot normalize place URL, invalid URL --- ${url}`);
        return url;
    }
    // pathname starts with /
    const pathSegments = pathname.split('/').slice(1);
    const nonDataSegments = pathSegments.filter((part) => !part.startsWith('data='));
    const dataSegment = pathSegments.find((part) => part.startsWith('data='));
    if (!dataSegment) {
        log.warning(`Cannot normalize place URL, didn't find data param --- ${url}`);
        return url;
    }
    // params are prefixed with '!'
    const dataParams = dataSegment.split('!').slice(1);
    // This is some hex of CID and some other hex, I forgot but we should figure it out:)
    const hexPart = dataParams.find((param) => {
        const hexPartMatch = param.match(/1s0x[0-9a-z]+:0x[0-9a-z]+/);
        if (hexPartMatch) {
            return true;
        }
        return false;
    });

    if (!hexPart) {
        log.warning(`Cannot normalize place URL, didn't find hexadecimal string part --- ${url}`);
        return url;
    }

    const normalizedDataSegment = `data=!4m2!3m1!${hexPart}`;
    const normalized = `${origin}/${nonDataSegments.join('/')}/${normalizedDataSegment}`;
    log.debug(`Normalized Start URL: ${url} => ${normalized}`);
    return normalized;
};

/**
 * The URL is coming from our functions that will have always correct format of
 * https://www.google.com/maps/search[.*]
 */
export const injectSearchTermToUrl = (url: string, searchTerm: string): string => {
    return url.replace('/search', `/search/${searchTerm}`);
};

export const unstringifyGoogleXrhResponse = (googleResponseString: string): any => {
    return JSON.parse(googleResponseString.replace(')]}\'', ''));
};

export const blockRequestsForOptimization = async (page: Page, label: string, maxImages: number, allPlacesNoSearchAction?: string) => {
    // Blocking requests for optimizations
    // googleusercontent.com/p is the image file, the rest is needed for scrolling to work
    const IMAGE_REQUIRED_URL_PATTERNS = ['googleusercontent.com/p'];
    const MAP_URL_PATTERNS = ['maps/vt', 'preview/log204', '/earth/BulkMetadata/', 'blob:https'];

    const PLACE_NO_IMAGES_SETTINGS = { extraUrlPatterns: [...MAP_URL_PATTERNS, ...IMAGE_REQUIRED_URL_PATTERNS] };
    const PLACE_1_IMAGE_SETTING = { extraUrlPatterns: MAP_URL_PATTERNS };
    // TODO: Image scrolling is currently buggy (it jumps up) with any request blocking
    // but it should be fixable with enough fiddling
    // Right now, we disable all optimizations for images which is unfortunate
    const PLACE_MANY_IMAGES_SETTING = { urlPatterns: [] };

    // We need some images that are blocked by default for scrolling places
    const SEARCH_NORMAL_SETTING = {
        urlPatterns: ['.svg', '.woff', '.pdf', '.zip'],
        extraUrlPatterns: [...MAP_URL_PATTERNS, ...IMAGE_REQUIRED_URL_PATTERNS],
    };
    // Here we need the map
    // TODO: This might fine-tuned if we try different options long enough but not a priority since it is rare
    const SEARCH_NO_SEARCHSTRING_SETTING = { urlPatterns: [] };

    /** @type {{extraUrlPatterns?: string[], urlPatterns?: string[]}} */
    let blockRequestsOptions;
    if (label === LABELS.PLACE) {
        if (maxImages > 1) {
            blockRequestsOptions = PLACE_MANY_IMAGES_SETTING;
        } else if (maxImages === 1) {
            blockRequestsOptions = PLACE_1_IMAGE_SETTING;
        } else {
            blockRequestsOptions = PLACE_NO_IMAGES_SETTINGS;
        }
    } else if (label === LABELS.SEARCH) {
        if (allPlacesNoSearchAction) {
            blockRequestsOptions = SEARCH_NO_SEARCHSTRING_SETTING;
        } else {
            blockRequestsOptions = SEARCH_NORMAL_SETTING;
        }
    }

    await blockRequests(page, blockRequestsOptions);
};

interface AbortRunIfReachedMaxPlacesOptions {
    searchString: string;
    request: Request;
    page: Page;
    crawler: PuppeteerCrawler;
}

export const abortRunIfReachedMaxPlaces = async ({ searchString, request, page, crawler }: AbortRunIfReachedMaxPlacesOptions) => {
    log.warning(`[SEARCH]: Finishing scraping because we reached maxCrawledPlaces `
        // + `currently: ${maxCrawledPlacesTracker.enqueuedPerSearch[searchKey]}(for this search)/${maxCrawledPlacesTracker.enqueuedTotal}(total) `
        + `--- ${searchString} - ${request.url}`);
    // We need to wait a bit so the pages got processed and data pushed
    await page.waitForTimeout(5000);
    await crawler.autoscaledPool?.abort();
};

/**
 * This actor sometimes gets into concurrency death spiral so we need reasonable top limit that should ideally
 * never be hit. We as well set some starting concurrency so our slower scaling with not slow us too much.
 */
export const getDefaultMaxAndDesiredConcurrency = (userOverridenMaxConcurrency?: number) => {
    const actorMemoryGB = (Actor.getEnv().memoryMbytes || 2048) / 1024;
    // E.g. 8 GB actor can have max 32 concurrency
    // This is fairly high number so we might even go down to (* 3) if we still see lot of timeouts
    const maxConcurrency = Math.floor(actorMemoryGB * 4);
    // E.g. 8 GB actor starts with 4 concurrency
    const desiredConcurrency = Math.ceil(actorMemoryGB / 2);
    const overringLog = userOverridenMaxConcurrency
        ? `You overrode maximum concurrency to ${userOverridenMaxConcurrency}.`
        : `You can override maximum concurrency limit by setting maxConcurrency input value.`;

    log.info(`Based on provided memory of ${actorMemoryGB} GB, we set maximum concurrency to ${maxConcurrency} `
        + `and starting concurrency to ${desiredConcurrency}. This helps to reduce timeouts and overscaling. ${overringLog}`);
    return { maxConcurrency, desiredConcurrency };
};
