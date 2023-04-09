import { Actor } from 'apify';
import type { Request } from 'crawlee';

export const reviewsRequestFailCounter = async (maxRetries: number) => {
    const countState: Record<string, number> = (await Actor.getValue('COUNT')) || {};

    const persistState = async () => {
        await Actor.setValue('FAIL_COUNT', countState);
    };

    Actor.on('persistState', persistState);

    return {
        increaseCount(request: Request | { id: string }, increment = 1) {
            countState[request.id!] = (countState[request.id!] || 0) + increment;
        },
        reachedLimit(request: Request | { id: string }) {
            return countState[request.id!] >= maxRetries;
        },
        resetCount(request: Request) {
            countState[request.id!] = 0;
        },
    };
};
