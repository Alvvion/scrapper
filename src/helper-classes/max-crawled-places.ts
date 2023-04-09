import { Actor } from 'apify';

const MAX_CRAWLED_PLACES_STATE_RECORD_NAME = 'MAX_CRAWLED_PLACES_STATE';

interface MaxCrawledPlacesState {
    enqueuedTotal: number,
    enqueuedPerSearch: Record<string, number>,
    scrapedTotal: number,
    scrapedPerSearch: Record<string, number>,
}

export class MaxCrawledPlacesTracker {
    maxCrawledPlaces: number;
    maxCrawledPlacesPerSearch: number;
    enqueuedTotal: number;
    enqueuedPerSearch: Record<string, number>;
    scrapedTotal: number;
    scrapedPerSearch: Record<string, number>;

    constructor(maxCrawledPlaces: number, maxCrawledPlacesPerSearch: number) {
        this.maxCrawledPlaces = maxCrawledPlaces;
        this.maxCrawledPlacesPerSearch = maxCrawledPlacesPerSearch;
        this.enqueuedTotal = 0;
        this.enqueuedPerSearch = {};
        this.scrapedTotal = 0;
        this.scrapedPerSearch = {};
    }

    async initialize() {
        const loadedState = await Actor.getValue(MAX_CRAWLED_PLACES_STATE_RECORD_NAME) as MaxCrawledPlacesState | undefined;
        if (loadedState) {
            this.enqueuedTotal = loadedState.enqueuedTotal;
            this.enqueuedPerSearch = loadedState.enqueuedPerSearch;
            this.scrapedTotal = loadedState.scrapedTotal;
            this.scrapedPerSearch = loadedState.scrapedPerSearch;
        }

        Actor.on('persistState', async () => {
            await this.persist();
        });
    }

    /**
     * Returns true if we can still enqueue more for this search string
     */
    canEnqueueMore(searchString?: string): boolean {
        if (this.enqueuedTotal >= this.maxCrawledPlaces) {
            return false;
        }
        if (searchString && this.enqueuedPerSearch[searchString] >= this.maxCrawledPlacesPerSearch) {
            return false;
        }
        return true;
    }

    /**
     * You should use this stateful function before each enqueueing
     * Increments a counter for enqueued requests
     * Returns true if the requests count was incremented
     * and the request should be really enqueued, false if not
     */
    setEnqueued(searchString?: string): boolean {
        if (searchString && !this.enqueuedPerSearch[searchString]) {
            this.enqueuedPerSearch[searchString] = 0;
        }

        // Here we first check before enqueue
        const canEnqueueMore = this.canEnqueueMore(searchString);
        if (!canEnqueueMore) {
            return false;
        }
        this.enqueuedTotal++;
        if (searchString) {
            this.enqueuedPerSearch[searchString]++;
        }
        return true;
    }

    /**
     * Returns true if we can still scrape more for this search string
     */
    canScrapeMore(searchString?: string): boolean {
        if (this.scrapedTotal >= this.maxCrawledPlaces) {
            return false;
        }
        if (searchString && this.scrapedPerSearch[searchString] >= this.maxCrawledPlacesPerSearch) {
            return false;
        }
        return true;
    }

    /**
     * You should use this stateful function after each place pushing
     * Increments a counter for scraped requests
     * Returns true if the requests count was incremented
     * and we should continue to scrape for this search, false if not
     */
    setScraped(searchString?: string): boolean {
        if (searchString && !this.scrapedPerSearch[searchString]) {
            this.scrapedPerSearch[searchString] = 0;
        }
        // Here we push and then check
        this.scrapedTotal++;
        if (searchString) {
            this.scrapedPerSearch[searchString]++;
        }

        const canScrapeMore = this.canScrapeMore(searchString);
        if (!canScrapeMore) {
            return false;
        }

        return true;
    }

    async persist() {
        await Actor.setValue(
            MAX_CRAWLED_PLACES_STATE_RECORD_NAME,
            {
                enqueuedTotal: this.enqueuedTotal,
                enqueuedPerSearch: this.enqueuedPerSearch,
                scrapedTotal: this.scrapedTotal,
                scrapedPerSearch: this.scrapedPerSearch,
            },
        );
    }
}
