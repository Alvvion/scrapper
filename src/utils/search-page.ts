import { sleep, log } from 'crawlee';

import type { Page } from 'puppeteer';

import { waitForGoogleMapLoader } from './misc-utils.js';

/**
 * Types keyword into search box, retries if needed and wait for navigation
 */
export const searchInputBoxFlow = async (page: Page, searchString: string) => {
    // there is no searchString when startUrls are used
    if (searchString) {
        await page.waitForSelector('#searchboxinput', { timeout: 15000 });
        await page.type('#searchboxinput', searchString);
    }

    await sleep(5000);
    try {
        await page.click('#searchbox-searchbutton');
    } catch (e) {
        log.warning(`click#searchbox-searchbutton ${(e as Error).message}`);
        try {
            const retryClickSearchButton = await page.$('#searchbox-searchbutton');
            if (!retryClickSearchButton) {
                throw new Error('Retry click search button was not found on the page.');
            }
            await retryClickSearchButton.evaluate((b) => (b as any).click());
        } catch (eOnRetry) {
            log.warning(`retryClickSearchButton ${(eOnRetry as Error).message}`);
            await page.keyboard.press('Enter');
        }
    }
    await sleep(5000);
    await waitForGoogleMapLoader(page);
};

export const getPlacesCountInUI = async (page: Page): Promise<number> => {
    return page.evaluate(() => $('[role="article"]').length);
};
