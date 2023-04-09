import { Actor } from 'apify';
import { puppeteerUtils } from 'crawlee';

import type { Page } from 'puppeteer';

const BASE_MESSAGE = 'Operation failed';
const SNAPSHOT_PREFIX = 'ERROR-SNAPSHOT-';

interface TryWithSnapshotOptions {
    name?: string;
    returnError?: boolean;
    maxErrorCharacters?: number;
}

/**
 * Utility class that allows you to wrap your functions
 * with a try/catch that saves a screenshot on the first occurence
 * of that error
 */
export class ErrorSnapshotter {
    maxErrorCharacters: number;
    errorState: Record<string, number>;

    constructor({ maxErrorCharacters = 80 }: { maxErrorCharacters?: number} = {}) {
        this.maxErrorCharacters = maxErrorCharacters;
        this.errorState = {};
    }

    /**
     * Loads from state and initializes events
     */
    async initialize() {
        this.errorState = await Actor.getValue('ERROR-SNAPSHOTTER-STATE') || {};
        Actor.on('persistState', this.persistState.bind(this));
    }

    async persistState() {
        await Actor.setValue('ERROR-SNAPSHOTTER-STATE', this.errorState);
    }

    /**
     * Provide a page or HTML used to snapshot and a closure to be called
     * Optionally, you can name the action for nicer logging, otherwise name of the error is used
     * These functions can be nested, in that case only one snapshot is produced (for the bottom error)
     * Returns the return value of the provided function (awaits it) or an error (if configured)
     */
    async tryWithSnapshot(pageOrHtml: Page | string, fn: () => Promise<unknown>, options?: TryWithSnapshotOptions): Promise<unknown> {
        if (typeof pageOrHtml !== 'string' && typeof pageOrHtml !== 'object') {
            throw new Error('Try with snapshot: Wrong input! pageOrHtml must be Puppeteer page or HTML');
        }
        const { name, returnError = false, maxErrorCharacters } = (options || {});
        try {
            return await fn();
        } catch (e) {
            let err = e;
            // We don't want the Error: text, also we have to count with Error instances and string errors
            const errMessage = typeof err === 'string' ? err : (err as Error).message;
            // If error starts with BASE_MESSAGE, it means it was another nested tryWithScreenshot
            // In that case we just re-throw and skip all state updates and screenshots
            if (errMessage.startsWith(BASE_MESSAGE)) {
                throw err;
            }
            // Normalize error name
            const errorKey = (name ? `${name}-${errMessage}` : errMessage)
                .slice(0, maxErrorCharacters || this.maxErrorCharacters)
                .replace(/[^a-zA-Z0-9-_]/g, '-');

            if (!this.errorState[errorKey]) {
                this.errorState[errorKey] = 0;
            }
            this.errorState[errorKey]++;

            // We check the errorState because we save the screenshots only the first time for each error
            if (this.errorState[errorKey] === 1) {
                await this.saveSnapshot(pageOrHtml, errorKey);
            }
            const newMessage = `${BASE_MESSAGE}${name ? `: ${name}` : ''}. Error detail: ${errMessage}`;
            if (typeof err === 'string') {
                err = newMessage;
            } else {
                (err as Error).message = newMessage;
            }

            if (returnError) {
                return err;
            }
            throw err;
        }
    }

    /**
     * Works for both HTML and Puppeteer Page
     */
    async saveSnapshot(pageOrHtml: Page | string, errorKey: string) {
        if (typeof pageOrHtml === 'string') {
            await Actor.setValue(`${SNAPSHOT_PREFIX}${errorKey}`, pageOrHtml, { contentType: 'text/html' });
        } else {
            await puppeteerUtils.saveSnapshot(pageOrHtml, { key: `${SNAPSHOT_PREFIX}${errorKey}` });
        }
    }
}
