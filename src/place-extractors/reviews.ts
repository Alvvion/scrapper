import { log } from 'apify';
import { sleep } from 'crawlee';
import GoogleMapsDataAST from 'google-maps-data-ast';

import type { HTTPResponse, Page } from 'puppeteer';
import type { Request } from 'crawlee';

import { unstringifyGoogleXrhResponse } from '../utils/misc-utils.js';

import type { Review, PersonalDataOptions, ReviewsTranslation, ReviewsSort } from '../typedefs.js';
import { reviewsFailCounter } from '../main.js';

class ReviewUrlParams {
    reviewUrl: string;
    ast: any;

    constructor(reviewUrl: string) {
        this.reviewUrl = reviewUrl;
        const pb = new URL(reviewUrl).searchParams.get('pb');

        if (!pb) {
            throw new Error('Could not find pb parameter in the review URL');
        }

        this.ast = GoogleMapsDataAST.parse(pb);

        // Increase the number of reviews per page (Max value is 199)
        this.ast.matrix[2].children.integer['2'].value = '199';
        this.ast.matrix[2].children.integer['2'].data = 199;
    }

    setReviewSort(sortType: number) {
        this.ast.enum[3].value = `${sortType + 1}`;
        this.ast.enum[3].data = sortType + 1;
    }

    setPaginationCursor(cursor: string) {
        // Stating that the matrix has now 2 values
        this.ast.matrix[2].value = '2';
        // Adding the second value, which is the cursor of the last comment found
        this.ast.matrix[2].children.string = {
            3: {
                id: 3,
                code: 's',
                value: cursor,
            },
        };

        // I found that this is the pagination for the next page
        // eslint-disable-next-line no-unsafe-optional-chaining
        const nextPage = Number(this.ast.enum?.['4']?.data + 1 || this.ast.enum?.['3']?.data);
        if (!this.ast.enum['4']) this.ast.enum['4'] = { ...this.ast.enum['3'] };
        this.ast.enum['4'].id = '4';
        this.ast.enum['4'].value = `${nextPage}`;
        this.ast.enum['4'].data = nextPage;

        log.debug(`Setting next page to ${nextPage}`);
    }

    getUrl() {
        const reviewUrlInstance = new URL(this.reviewUrl);
        reviewUrlInstance.searchParams.set('pb', GoogleMapsDataAST.stringify(this.ast));
        return reviewUrlInstance.href;
    }
}

const removePersonalDataFromReviews = (reviews: Review[], personalDataOptions: PersonalDataOptions): Review[] => {
    for (const review of reviews) {
        if (!personalDataOptions.scrapeReviewerName) {
            review.name = null;
        }
        if (!personalDataOptions.scrapeReviewerId) {
            review.reviewerId = null;
        }
        if (!personalDataOptions.scrapeReviewerUrl) {
            review.reviewerUrl = null;
            review.reviewerPhotoUrl = null;
        }
        if (!personalDataOptions.scrapeReviewId) {
            review.reviewId = null;
        }
        if (!personalDataOptions.scrapeReviewUrl) {
            review.reviewUrl = null;
        }
        if (!personalDataOptions.scrapeResponseFromOwnerText) {
            review.responseFromOwnerText = null;
        }
    }
    return reviews;
};

/**
 * Parses review from a single review array json Google format
 */
const parseReviewFromJson = (jsonArray: any, reviewsTranslation: ReviewsTranslation): Review => {
    let text = jsonArray[3];

    // Optionally remove translation
    // TODO: Perhaps the text is differentiated in the JSON
    if (typeof text === 'string' && reviewsTranslation !== 'originalAndTranslated') {
        const splitReviewText = text.split('\n\n(Original)\n');

        if (reviewsTranslation === 'onlyOriginal') {
            // Fallback if there is no translation
            text = splitReviewText[1] || splitReviewText[0];
        } else if (reviewsTranslation === 'onlyTranslated') {
            text = splitReviewText[0];
        }
        text = text.replace('(Translated by Google)', '').replace('\n\n(Original)\n', '').trim();
    }

    return {
        name: jsonArray[0][1],
        text,
        publishAt: jsonArray[1],
        publishedAtDate: new Date(jsonArray[27]).toISOString(),
        likesCount: jsonArray[16],
        reviewId: jsonArray[10],
        reviewUrl: jsonArray[18],
        reviewerId: jsonArray[6],
        reviewerUrl: jsonArray[0][0],
        reviewerPhotoUrl: jsonArray[0][2],
        reviewerNumberOfReviews: jsonArray[12] && jsonArray[12][1] && jsonArray[12][1][1],
        isLocalGuide: jsonArray[12] && jsonArray[12][1] && Array.isArray(jsonArray[12][1][0]),
        // On some places google shows reviews from other services like booking
        // There isn't stars but rating for this places reviews
        stars: jsonArray[4] || null,
        // Trip advisor
        rating: jsonArray[25] ? jsonArray[25][1] : null,
        responseFromOwnerDate: jsonArray[9] && jsonArray[9][3]
            ? new Date(jsonArray[9][3]).toISOString()
            : null,
        responseFromOwnerText: jsonArray[9] ? jsonArray[9][1] : null,
        reviewImageUrls: jsonArray[14]?.map((imageObj: any) => imageObj?.[6]?.[0]) || [],
    };
};

/**
 * Response from google xhr is kind a weird. Mix of array of array.
 * This function parse reviews from the response body.
 */
const parseReviewFromResponseBody = (
    responseBody: Buffer | string, reviewsTranslation: ReviewsTranslation,
): { currentReviews?: Review[], nextBatchCursor?: string, error?: Error | string } => {
    const currentReviews: Review[] = [];
    const stringBody = typeof responseBody === 'string'
        ? responseBody
        : responseBody.toString('utf-8');
    let results;
    try {
        results = unstringifyGoogleXrhResponse(stringBody);
    } catch (e) {
        return { error: e as Error };
    }
    if (!results || !results[2]) {
        return { currentReviews };
    }
    results[2].forEach((jsonArray: any) => {
        const review = parseReviewFromJson(jsonArray, reviewsTranslation);
        currentReviews.push(review);
    });
    const nextBatchCursor = results?.[2]?.[results?.[2]?.length as number - 1 || 9]?.[61];
    return { currentReviews, nextBatchCursor };
};

interface ExtractReviewsOptions {
    page: Page;
    reviewsCount: number;
    request: Request;
    targetReviewsCount: number;
    reviewsSort: ReviewsSort;
    reviewsTranslation: ReviewsTranslation;
    reviewsFilterString?: string;
    defaultReviewsJson: any;
    personalDataOptions: PersonalDataOptions;
    reviewsStartDate?: string;
    sendRequest: (overrideOptions?: Partial<any> | undefined) => Promise<{ body: any; headers: any }>;
}

export const extractReviews = async ({
    page, reviewsCount, request, reviewsStartDate,
    targetReviewsCount, reviewsSort, reviewsTranslation,
    reviewsFilterString, defaultReviewsJson, personalDataOptions, sendRequest,
}: ExtractReviewsOptions): Promise<Review[]> => {
    let reviews: Review[] = [];

    if (targetReviewsCount === 0) {
        return [];
    }

    const reviewsStartDateAsDate = reviewsStartDate ? new Date(reviewsStartDate) : null;

    // If we already have all reviews from the page as default ones, we can finish
    // Just need to sort appropriately manually
    if (!reviewsFilterString && defaultReviewsJson?.length >= targetReviewsCount) {
        reviews = defaultReviewsJson
            .map((defaultReviewJson: any) => parseReviewFromJson(defaultReviewJson, reviewsTranslation));
        // mostRelevant is default

        if (reviewsSort === 'newest') {
            reviews.sort((review1, review2) => {
                const unixDate1 = new Date(review1.publishedAtDate).getTime();
                const unixDate2 = new Date(review2.publishedAtDate).getTime();
                return unixDate2 - unixDate1;
            });
        }
        if (reviewsSort === 'highestRanking') {
            reviews.sort((review1, review2) => (review2.stars || 0) - (review1.stars || 0));
        }
        if (reviewsSort === 'lowestRanking') {
            reviews.sort((review1, review2) => (review2.stars || 0) - (review1.stars || 0));
        }
        log.info(`[PLACE]: Reviews extraction finished: ${reviews.length}/${reviewsCount} --- ${page.url()}`);
    } else {
        // Standard scrolling
        // We don't use default reviews if we gonna scroll.
        // Scrolling is fast anyway so we can easily do it from scratch
        const reviewsButtonSel = 'button[jsaction="pane.reviewChart.moreReviews"]';

        try {
            await page.waitForSelector(reviewsButtonSel, { timeout: 15000 });
        } catch (e) {
            log.warning(`Could not find reviews count, check if the page really has no reviews --- ${page.url()}`);
        }

        // click the consent iframe, working with arrays so it never fails.
        // also if there's anything wrong with Same-Origin, just delete the modal contents
        // TODO: Why is this isolated in reviews?
        await page.$$eval('#consent-bump iframe', async (frames) => {
            try {
                frames.forEach((frame) => {
                    [...frame.contentDocument!.querySelectorAll('#introAgreeButton')].forEach((s) => (s as any).click());
                });
            } catch (e) {
                document.querySelectorAll('#consent-bump > *').forEach((el) => el.remove());
            }
        });

        try {
            await page.waitForSelector(reviewsButtonSel);
        } catch (e) {
            throw new Error('Reviews button selector did not load in time');
        }

        const reviewSortOptions = {
            mostRelevant: 0,
            newest: 1,
            highestRanking: 2,
            lowestRanking: 3,
        };

        await sleep(500);

        let reviewsResponse;
        if (reviewsFilterString) {
            log.info('[PLACE]: Searching reviews....');
            try {
                await Promise.all([
                    page.click(reviewsButtonSel),
                    page.waitForResponse((response) => response.url().includes('preview/review/listentitiesreviews')),
                ]);
                await page.click('div.pV4rW.q8YqMd > div > button');
                await page.keyboard.type(reviewsFilterString.trim());
                await page.keyboard.press('Enter');

                reviewsResponse = await page.waitForResponse((response) => response.url().includes('preview/review/listentitiesreviews'));
            } catch (err) {
                throw new Error(`Could not search for reviews - ${(err as Error).message}`);
            }
        } else {
            try {
                const responses = await Promise.all([
                    page.waitForResponse((response) => response.url().includes('preview/review/listentitiesreviews'),
                        { timeout: 60000 }),
                    page.click(reviewsButtonSel),
                ]);
                reviewsResponse = responses[0];
            } catch (e) {
                throw new Error(`Didn't receive response in time after clicking on reviews button - ${(e as Error).message}`);
            }
        }

        if (!reviewsResponse) {
            throw new Error(`Didn't receive response url after clicking on reviews button`);
        }

        let reviewUrl = (reviewsResponse as HTTPResponse).url();

        const nextReviewPbAST = new ReviewUrlParams(reviewUrl);

        nextReviewPbAST.setReviewSort(reviewSortOptions[reviewsSort]);

        let lastBatchUrlCursor = null;

        while (reviews.length < targetReviewsCount) {
            if (lastBatchUrlCursor) {
                nextReviewPbAST.setPaginationCursor(lastBatchUrlCursor);
            }

            reviewUrl = nextReviewPbAST.getUrl();

            log.debug(`[REVIEW URL]: ${reviewUrl}`);

            let responseBody; let contentType;

            try {
                const response = await Promise.race([
                    sendRequest({ url: reviewUrl }).catch((err) => {
                        throw new Error(err);
                    }),
                    sleep(30000).then(() => {
                        throw new Error('Reviews request timed out.');
                    }),
                ]);

                responseBody = response.body;
                contentType = response.headers['content-type'];
            } catch (err: any) {
                log.debug('Error while fetching reviews', err);
                responseBody = null;
            }

            // This means that invalid response were returned, I noticed that this is not a block
            // but a server error 500 by google, it happens usually when we pass about ~15k reviews
            if (!responseBody || !contentType || !contentType.includes('application/json')) {
                reviewsFailCounter.increaseCount(request);

                // So we don't update the request
                lastBatchUrlCursor = null;

                log.warning('[REVIEWS]: Reviews response is invalid. Retrying...');
                if (reviewsFailCounter.reachedLimit(request)) {
                    reviewsFailCounter.resetCount(request);
                    log.warning(`[REVIEWS]: Finishing with incomplete set of ${reviews.length} reviews for ${page.url()}`);
                    break;
                } else {
                    // Wait a bit before retrying, I noticed that google returns `server error 500`
                    await sleep(10000);
                    continue;
                }
            } else {
                // Reset the failed counter
                reviewsFailCounter.resetCount(request);
            };

            const { currentReviews = [], error, nextBatchCursor } = parseReviewFromResponseBody(responseBody, reviewsTranslation);
            if (error) {
                // This means that invalid response were returned
                // I think can happen if the review count changes
                log.warning(`Invalid response returned for reviews. `
                    + `This might be caused by updated review count. The reviews should be scraped correctly. ${page.url()}`);
                log.warning(typeof error === 'string' ? error : error.message);
                break;
            }
            if (currentReviews.length === 0) {
                break;
            }

            reviews.push(...currentReviews);

            let stopDateReached = false;
            for (const review of currentReviews) {
                if (reviewsStartDateAsDate && new Date(review.publishedAtDate) < reviewsStartDateAsDate) {
                    stopDateReached = true;
                    break;
                }
            }
            if (stopDateReached) {
                log.info(`[PLACE]: Extracting reviews stopping: Reached review older than ${reviewsStartDate} --- ${page.url()} `);
                break;
            }
            log.info(`[PLACE]: Extracting reviews: ${reviews.length}/${reviewsCount} --- ${page.url()}`);
            lastBatchUrlCursor = nextBatchCursor;
            // Either we are on the last page or something broke
            if (!nextBatchCursor && reviewsFilterString && reviews.length < targetReviewsCount) {
                log.warning(`Found only ${reviews.length} for reviews search string: ${reviewsFilterString}, stopping now --- ${page.url()}`);
                break;
            } else if (!nextBatchCursor && reviews.length < targetReviewsCount) {
                log.warning(`Could not find parameter to get to a next page of reviews, stopping now --- ${page.url()}`);
                break;
            }

            // Emulate Scrolling, generate a random number between 2000 and 5000
            const min = 2000; const max = 5000;
            await sleep(Math.floor(Math.random() * (max - min)) + min);
        }
        // NOTE: Sometimes for unknown reason, Google gives less reviews and in different order
        // TODO: Find a cause!!! All requests URLs look the same otherwise
        // Extracting reviews method updated
        if (!reviewsFilterString && !reviewsStartDateAsDate && reviews.length < targetReviewsCount) {
            log.warning(`Google served us less reviews than it should (${reviews.length}/${targetReviewsCount})`);
        }
        log.info(`[PLACE]: Reviews extraction finished: ${reviews.length}/${reviewsCount} --- ${page.url()}`);
        // Clicking on the back button using navigateBack function here is infamously buggy
        // So we just do reviews as last every time
    }
    reviews = reviews
        .slice(0, targetReviewsCount)
        .filter((review) => !reviewsStartDateAsDate || new Date(review.publishedAtDate) > reviewsStartDateAsDate);
    return removePersonalDataFromReviews(reviews, personalDataOptions);
};
