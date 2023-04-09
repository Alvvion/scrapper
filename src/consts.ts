export const DEFAULT_TIMEOUT = 60_000; // 60 sec

// Max scrolling results, this might change in the future.
export const MAX_PLACES_PER_PAGE = 120;

// Max start requests that can be fed to the request queue synchronously.
// This is intentionally low to prevent JS event loop from being too busy when enqueueing is going on in the background.
export const MAX_START_REQUESTS_SYNC = 200;
export const ASYNC_START_REQUESTS_INTERVAL_MS = 20000;

export const LISTING_PAGINATION_KEY = 'lisState';
export const MAX_PAGE_RETRIES = 6;

export const PLACE_TITLE_SEL = 'h1.fontHeadlineLarge';
export const BACK_BUTTON_SEL = 'button[jsaction*=back], button[aria-label="Back"]';
export const NEXT_BUTTON_SELECTOR = '[jsaction="pane.paginationSection.nextPage"]';

export const NO_RESULT_XPATH = '//div[contains(text(), "No results found")]';

export const REGEXES = {
    PLACE_URL_NORMAL: /google\.[a-z.]+\/maps\/place/,
    PLACE_URL_CID: /google\.[a-z.]+.+cid=\d+(&|\b)/,
    SEARCH_URL_NORMAL: /google\.[a-z.]+\/maps\/search/,
};

export const LABELS = {
    PLACE: 'PLACE',
    SEARCH: 'SEARCH',
};

export const GEO_TO_DEFAULT_ZOOM = {
    country: 12,
    state: 12,
    county: 14,
    city: 15,
    postalCode: 16,
    default: 12,
};
