import { Actor, log } from 'apify';

import type { Page } from 'puppeteer';
import type { Request, Session, PuppeteerCrawler } from 'crawlee';

import { MaxCrawledPlacesTracker } from './helper-classes/max-crawled-places.js';
import { ErrorSnapshotter } from './helper-classes/error-snapshotter.js';
import { Stats } from './helper-classes/stats.js';

import { extractPageData, extractPopularTimes, extractOpeningHours, extractPeopleAlsoSearch, extractAdditionalInfo } from './place-extractors/general.js';
import { extractImages } from './place-extractors/images.js';
import { extractReviews } from './place-extractors/reviews.js';
import { DEFAULT_TIMEOUT, PLACE_TITLE_SEL } from './consts.js';
import { waitForGoogleMapLoader, abortRunIfReachedMaxPlaces } from './utils/misc-utils.js';

import type { ScrapingOptions, PlaceUserData } from './typedefs';

interface handlePlaceDetailOptions {
    page: Page;
    request: Request;
    searchString: string;
    session: Session;
    scrapingOptions: ScrapingOptions;
    errorSnapshotter: ErrorSnapshotter;
    stats: Stats;
    maxCrawledPlacesTracker: MaxCrawledPlacesTracker;
    crawler: PuppeteerCrawler;
    sendRequest: (overrideOptions?: Partial<any> | undefined) => Promise<{ body: any; headers: any }>;
}

declare const APP_INITIALIZATION_STATE: any;

export const handlePlaceDetail = async (options: handlePlaceDetailOptions) => {
    const {
        page, request, searchString, session, scrapingOptions, errorSnapshotter,
        stats, maxCrawledPlacesTracker, crawler, sendRequest,
    } = options;
    const {
        maxReviews, maxImages, reviewsSort, reviewsTranslation,
        oneReviewPerRow, reviewsStartDate, reviewsFilterString,
    } = scrapingOptions;
    // Extract basic information
    await waitForGoogleMapLoader(page);

    // Some customers are passing link to the reviews subpage for some reason
    const maybeBackButton = await page.$('button[aria-label="Back"]');
    if (maybeBackButton) {
        await maybeBackButton.click();
    }

    try {
        await page.waitForSelector(PLACE_TITLE_SEL, { timeout: DEFAULT_TIMEOUT });
    } catch (e) {
        session.markBad();
        throw new Error('The page header didn\'t load fast enough, this will be retried');
    }

    // Add info from listing page
    const { rank, searchPageUrl, searchPageLoadedUrl, isAdvertisement } = request.userData as PlaceUserData;

    // Extract gps from URL
    // We need to URL will be change, it happened asynchronously
    if (!maybeBackButton) {
        await page.waitForFunction(() => window.location.href.includes('/place/'));
    }
    const url = page.url();

    const coordinatesMatch = url.match(/!3d([0-9\-.]+)!4d([0-9\-.]+)/);
    const latMatch = coordinatesMatch ? coordinatesMatch[1] : null;
    const lngMatch = coordinatesMatch ? coordinatesMatch[2] : null;

    const coordinates = latMatch && lngMatch ? { lat: parseFloat(latMatch), lng: parseFloat(lngMatch) } : null;

    // This huge JSON contains mostly everything, we still don't use it fully
    // It seems to be very stable over time, it never broke the format
    // Examples can be found in the /samples folder
    // NOTE: This is empty for certain types of direct URL formats but we have automatic conversion "normalizePlaceUrl"
    // If you cannot get this work on a place in browser, run it through this scraper is debug mode
    // to get the normalized URL
    const jsonData = await page.evaluate(() => {
        try {
            return JSON.parse(APP_INITIALIZATION_STATE[3][6].replace(`)]}'`, ''))[6];
        } catch (e) { return null; }
    });

    // Enable to debug data parsed from JSONs - DON'T FORGET TO REMOVE BEFORE PUSHING!
    /*
    await Apify.setValue('APP-OPTIONS', await page.evaluate(() => APP_OPTIONS ))
    await Apify.setValue('APP_INIT_STATE', await page.evaluate(() => APP_INITIALIZATION_STATE ));
    await Apify.setValue('JSON-DATA', jsonData);
    */

    // For hotels there is a button to show more hotels options
    // We need to click it to get the data
    const maybeShowMoreHotelsButton = await page.$('button[aria-label^="More prices"]');
    if (maybeShowMoreHotelsButton) {
        await maybeShowMoreHotelsButton.click();
    }

    // For hotels there is a button to show more hotels options
    // We need to click it to get the data
    const maybeHotelShowMoreDetailsButton = await page.$('button[aria-label^="More details"]');
    if (maybeHotelShowMoreDetailsButton) {
        await maybeHotelShowMoreDetailsButton.click();
    }

    const pageData = await extractPageData({ page, jsonData });

    const gasPrices = jsonData?.[86]?.[0]?.map((arr: any) => {
        /* expected raw array
        [
        "$4.10",
        3,
        1652829848,
        "gallon",
        1,
        "USD",
        4.1,
        "Regular"
        ],
        */
        return {
            priceTag: arr?.[0],
            updatedAt: new Date((arr?.[2] || 0) * 1000).toISOString(),
            unit: arr?.[3],
            currency: arr?.[5],
            price: arr?.[6],
            gasType: arr?.[7],
        };
    });

    let orderBy;
    // new format where food ordering represented by widget https://food.google.com/chooseprovider
    try {
        const orderByWidget = jsonData?.[75]?.[0]?.find((x: any) => x?.[5]?.[1]?.[2]?.[0]?.startsWith('https://food.google.com/chooseprovider'));
        if (orderByWidget) {
            const orderByWidgetUrl = orderByWidget[5]?.[1]?.[2]?.[0];
            const orderWidgetHtml = await page.evaluate(async (urlEval: string) => {
                const data = await fetch(urlEval).then((r) => r.text());
                return data;
            }, orderByWidgetUrl);
            // we getting two instances of AF_initDataCallback, first one looks like place info
            // we need
            // AF_initDataCallback({key: 'ds:1'
            const orderByInlineJsonData = orderWidgetHtml?.split(`AF_initDataCallback({key: 'ds:1'`)?.[1]?.split(', data:')?.[1]?.split(', sideChannel:')?.[0];
            if (orderByInlineJsonData) {
                log.debug(`[ORDERBY]: parsing widget ${orderByWidgetUrl}`);
            } else {
                log.warning(`[ORDERBY]: unknown widget format ${orderByWidgetUrl}`);
            }
            const orderByInlineJson = orderByInlineJsonData ? JSON.parse(orderByInlineJsonData) : {};
            let deliveryArray = orderByInlineJson?.[0];
            if (!deliveryArray) {
                deliveryArray = orderByInlineJson?.data?.[8];
                log.debug(`[ORDERBY]: delivery options not as expected ${orderByWidgetUrl}`);
            }
            if (deliveryArray?.[21]) {
                orderBy = deliveryArray?.[21]?.map((x: any) => {
                    return {
                        name: x?.[3],
                        url: x?.[32],
                        orderUrl: x?.[49],
                    };
                });
            }
        }
    } catch (err) {
        log.error(`[ORDERBY]: ${(err as Error).message}`);
    }
    if (!orderBy?.length) {
        // old format with inline json values, displayed randomly by google maps as of 15 of May 2022
        orderBy = jsonData?.[75]?.[0]?.[0]?.[2]?.map((i: any) => {
            return { name: i?.[0]?.[0], url: i?.[1]?.[2]?.[0] };
        }).filter((x: any) => x?.url);
    }
    // if none of parsing returned results output must be empty array for backwards compatibility
    orderBy = orderBy || [];

    let totalScore = jsonData?.[4]?.[7] || null;
    let reviewsCount = jsonData?.[4]?.[8] || 0;
    let permanentlyClosed = (jsonData?.[88]?.[0] === 'CLOSED' || jsonData?.[203]?.[1]?.[4]?.[0] === 'Permanently closed');

    // We fallback to HTML (might be good to do only)
    if (!totalScore) {
        totalScore = await page.evaluate(() => Number($(('[class*="section-star-display"]'))
            .eq(0).text().trim()
            .replace(',', '.')) || null);
    }

    if (!reviewsCount) {
        reviewsCount = await page.evaluate(() => Number($('button[jsaction="pane.reviewChart.moreReviews"]')
            .text()
            .replace(/[^0-9]+/g, '')) || 0);
    }

    if (!permanentlyClosed) {
        permanentlyClosed = await page.evaluate(() => $('#pane,.skqShb').text().includes('Permanently closed'));
    }

    // TODO: Add a backup and figure out why some direct start URLs don't load jsonData
    // direct place IDs are fine
    const reviewsDistributionDefault = {
        oneStar: 0,
        twoStar: 0,
        threeStar: 0,
        fourStar: 0,
        fiveStar: 0,
    };

    let reviewsDistribution = reviewsDistributionDefault;

    if (jsonData) {
        if (Array.isArray(jsonData?.[52]?.[3])) {
            const [oneStar, twoStar, threeStar, fourStar, fiveStar] = jsonData[52][3];
            reviewsDistribution = { oneStar, twoStar, threeStar, fourStar, fiveStar };
        }
    }

    const defaultReviewsJson = jsonData?.[52]?.[0];

    let cid;
    const cidHexSplit = jsonData?.[10]?.split(':');
    if (cidHexSplit && cidHexSplit[1]) {
        // Hexadecimal to decimal. We have to use BigInt because JS Number does not have enough precision
        cid = BigInt(cidHexSplit[1]).toString();
    }

    // How many we should scrape (otherwise we retry)
    const targetReviewsCount = Math.min(reviewsCount, maxReviews);

    // extract categories
    const categories = jsonData?.[13];

    // extract places tags
    const placesTags = jsonData?.[186]?.[2]?.map((tag: any) => {
        return {
            title: tag?.[0],
            count: tag?.[1]?.length,
        };
    });

    // extract reviews tags
    const reviewsTags = jsonData?.[153]?.[0]?.map((tag: any) => {
        return {
            title: tag?.[1],
            count: tag?.[3]?.[4],
        };
    });

    const detail = {
        ...pageData,
        permanentlyClosed,
        totalScore,
        isAdvertisement,
        rank,
        placeId: jsonData?.[78] || request.uniqueKey,
        categories: request.userData.categories || categories,
        cid,
        url,
        searchPageUrl,
        searchPageLoadedUrl,
        searchString,
        // keeping backwards compatible even though coordinates is better name
        location: coordinates || pageData?.location?.lat ? pageData.location : null,
        scrapedAt: new Date().toISOString(),
        ...extractPopularTimes({ jsonData }),
        openingHours: await extractOpeningHours({ page, jsonData }),
        peopleAlsoSearch: extractPeopleAlsoSearch(jsonData),
        additionalInfo: await extractAdditionalInfo({ page, placeUrl: url, jsonData }),
        reviewsCount,
        reviewsDistribution,
        imagesCount: jsonData?.[37]?.[1],
        // IMPORTANT: The order of actions image -> reviews is important
        // If you need to change it, you need to check the implementations
        // and where the back buttons need to be
        // NOTE: Image URLs are quite rare for users to require
        // In case the back button fails, we reload the page before reviews
        imageUrls: await errorSnapshotter.tryWithSnapshot(
            page,
            async () => extractImages({ page, maxImages, targetReviewsCount, placeUrl: url }),
            { name: 'Image extraction' },
        ),
        // NOTE: Reviews must be the last action on the detail page
        // because the back button is always a little buggy (unless you fix it :) ).
        // We want to close the page right after reviews are extracted
        reviews: await errorSnapshotter.tryWithSnapshot(
            page,
            async () => extractReviews({
                request,
                page,
                reviewsCount,
                targetReviewsCount,
                reviewsSort,
                reviewsTranslation,
                defaultReviewsJson,
                personalDataOptions: scrapingOptions.personalDataOptions,
                reviewsStartDate,
                reviewsFilterString,
                sendRequest,
            }),
            { name: 'Reviews extraction' },
        ),
        reviewsTags,
        placesTags,
        orderBy,
        gasPrices,
        hotelStars: jsonData?.[64]?.[3],
    };

    if (jsonData?.[160] !== undefined) {
        detail.temporarilyClosed = jsonData[160]?.[0] === 1;
    }

    const reserveTableUrl = jsonData?.[75]?.[0]?.[0]?.[5]?.[1]?.[2]?.[0];

    if (reserveTableUrl?.includes('food.google')) {
        detail.googleFoodUrl = reserveTableUrl;
    } else {
        detail.reserveTableUrl = reserveTableUrl || pageData?.reserveTableUrl;
    }

    if (!detail.price && jsonData?.[4]?.[2]) {
        detail.price = jsonData?.[4]?.[2];
    }

    if (!detail.description && jsonData?.[32]?.[1]?.[1]) {
        detail.description = jsonData?.[32]?.[1]?.[1];
    }

    const isHotel = detail.categoryName === 'Hotel';
    if (isHotel) {
        // Save price and check in/out dates (Price is based on the dates)
        // Overriding the price if it's a hotel, if available
        detail.price = jsonData?.[88]?.[0] || detail.price || null;
        detail.checkInDate = jsonData?.[35]?.[0] || null;
        detail.checkOutDate = jsonData?.[35]?.[1] || null;

        const description = await page.evaluate(() => $('.HeZRrf > div').text().trim());
        detail.description = description || jsonData?.[32]?.[2]?.[7]?.[0]?.join('\n ') || null;

        // Similar Hotels Nearby
        detail.similarHotelsNearby = jsonData?.[35]?.[29]?.[0]?.map((hotel: any) => ({
            name: hotel?.[0]?.[4],
            rating: hotel?.[0]?.[7],
            reviews: hotel?.[0]?.[8],
            description: hotel?.[1],
            price: hotel?.[3],
        }));
    }

    // Include customer updates if available
    const customerUpdatesInfo = jsonData?.[175]?.[7]?.[0]?.[0]?.[0];
    if (customerUpdatesInfo) {
        const postedBy = customerUpdatesInfo?.[1]?.[4]?.[0];
        detail.updatesFromCustomers = {
            text: customerUpdatesInfo?.[2]?.[1]?.[0],
            language: customerUpdatesInfo?.[2]?.[1]?.[1],
            postDate: customerUpdatesInfo?.[1]?.[6],
            postedBy: {
                name: postedBy?.[4],
                url: postedBy?.[5],
                title: postedBy?.[12]?.[0].split('·')?.[0]?.trim(),
                // eslint-disable-next-line no-unsafe-optional-chaining
                totalReviews: +postedBy?.[12]?.[0]?.split('·')?.[1]?.trim()?.replace(/\D/g, '') || undefined,
            },
            media: customerUpdatesInfo?.[2]?.[2]?.flatMap((item: any) => {
                const link = item?.[1]?.[21]?.[2]?.[10]?.[1]?.[0]?.[3];
                const postDate = item?.[1]?.[21]?.[6]?.[7]?.[8]?.[0] || null;
                if (link) return { link, postDate };
                return [];
            }),
        };
    }

    // Include questions and answers if available
    const questionAndAnswerInfo = jsonData?.[126]?.[0]?.[0];
    const question = questionAndAnswerInfo?.[0]?.[2];
    const answer = questionAndAnswerInfo?.[1]?.[0]?.[2];
    if (question && answer) {
        detail.questionsAndAnswers = {
            question: questionAndAnswerInfo?.[0]?.[2],
            answer,
            askDate: questionAndAnswerInfo?.[0]?.[7],
            askedBy: {
                name: questionAndAnswerInfo?.[0]?.[1]?.[0]?.[4],
                url: questionAndAnswerInfo?.[0]?.[1]?.[0]?.[5],
            },
            answerDate: questionAndAnswerInfo?.[1]?.[0]?.[7],
            answeredBy: {
                name: questionAndAnswerInfo?.[1]?.[0]?.[1]?.[0]?.[4],
                url: questionAndAnswerInfo?.[1]?.[0]?.[1]?.[0]?.[5],
            },
        };
    }

    if (oneReviewPerRow) {
        const unwoundResults = [];
        if (detail.reviews.length === 0) {
            // Removing reviews array from output
            unwoundResults.push({ ...detail, reviews: undefined });
        } else {
            for (const review of detail.reviews) {
                unwoundResults.push({ ...detail, ...review, reviews: undefined });
            }
        }
        await Actor.pushData(unwoundResults);
    } else {
        await Actor.pushData(detail);
    }

    stats.places();
    log.info(`[PLACE]: Place scraped successfully --- ${url}`);
    // We must not pass a searchString here because it aborts the whole run. We expect the global max to be correctly set.
    const shouldScrapeMore = maxCrawledPlacesTracker.setScraped();
    if (!shouldScrapeMore) {
        await abortRunIfReachedMaxPlaces({ searchString, request, page, crawler });
    }
};
