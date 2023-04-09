import { Actor, log } from 'apify';
import type { RequestOptions, RequestQueue } from 'crawlee';

import { MaxCrawledPlacesTracker } from '../helper-classes/max-crawled-places.js';
import { MAX_START_REQUESTS_SYNC, ASYNC_START_REQUESTS_INTERVAL_MS, LABELS } from '../consts.js';

const enqueueStartRequests = async (
    requests: RequestOptions[],
    requestQueue: RequestQueue,
    maxCrawledPlacesTracker: MaxCrawledPlacesTracker,
    enqueueingState: { enqueued: number },
) => {
    for (const request of requests) {
        if (request.userData?.label === LABELS.PLACE) {
            if (!maxCrawledPlacesTracker.setEnqueued()) {
                log.warning(`Reached maxCrawledPlaces ${maxCrawledPlacesTracker.enqueuedTotal}, not enqueueing any more`);
                break;
            }
        }
        await requestQueue.addRequest(request);
        enqueueingState.enqueued++;
    }
};

/**
 *
 * @param {Apify.RequestOptions[]} requests
 * @param {Apify.RequestQueue} requestQueue
 * @param {MaxCrawledPlacesTracker} maxCrawledPlacesTracker
 * @param {{ enqueued: number }} enqueueingState
 */
const enqueueStartRequestsAsync = (
    requests: RequestOptions[],
    requestQueue: RequestQueue,
    maxCrawledPlacesTracker: MaxCrawledPlacesTracker,
    enqueueingState: { enqueued: number },
) => {
    const asyncRequestGroups: RequestOptions[][] = [];

    for (let i = 0; i < requests.length + MAX_START_REQUESTS_SYNC; i += MAX_START_REQUESTS_SYNC) {
        const nextRequestGroup = requests.slice(i, i + MAX_START_REQUESTS_SYNC);
        if (nextRequestGroup.length > 0) {
            asyncRequestGroups.push(nextRequestGroup);
        }
    }

    /**
     * We're using `setInterval` instead of `setTimeout` since `setTimeout` freezes
     * the run in local development as all the remaining requests are enqueued at once.
     * It is most likely caused by the implementation of `RequestQueue` which responds
     * immediately in a local run.
     */
    const intervalId = setInterval(async () => {
        const nextGroup = asyncRequestGroups.shift();
        if (nextGroup) {
            await enqueueStartRequests(nextGroup, requestQueue, maxCrawledPlacesTracker, enqueueingState);
        } else {
            clearInterval(intervalId);
        }
    }, ASYNC_START_REQUESTS_INTERVAL_MS);
};

export const setUpEnqueueingInBackground = async (
    startRequests: RequestOptions[],
    requestQueue: RequestQueue,
    maxCrawledPlacesTracker: MaxCrawledPlacesTracker,
) => {
    const enqueueingState = (await Actor.getValue('ENQUEUEING_STATE') || { enqueued: 0 }) as { enqueued: number };
    Actor.on('persistState', async () => {
        await Actor.setValue('ENQUEUEING_STATE', enqueueingState);
    });

    const requestsToEnqueue = startRequests.slice(enqueueingState.enqueued);

    const syncStartRequests = requestsToEnqueue.slice(0, MAX_START_REQUESTS_SYNC);
    await enqueueStartRequests(syncStartRequests, requestQueue, maxCrawledPlacesTracker, enqueueingState);

    const backgroundStartRequests = requestsToEnqueue.slice(MAX_START_REQUESTS_SYNC);
    enqueueStartRequestsAsync(backgroundStartRequests, requestQueue, maxCrawledPlacesTracker, enqueueingState);
};
