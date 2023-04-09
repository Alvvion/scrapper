/* eslint-env jquery */
import { log } from 'apify';

import type { Page } from 'puppeteer';

import type { PlacePaginationData, PopularTimesOutput } from '../typedefs.js';

import { PLACE_TITLE_SEL } from '../consts.js';
import { fixFloatNumber, navigateBack, unstringifyGoogleXrhResponse } from '../utils/misc-utils.js';

/**
 * TODO: There is much of this data in the JSON
*/
const parseJsonResult = (placeData: any, isAdvertisement: boolean) => {
    if (!placeData) {
        return;
    }

    const categories = placeData[13];

    // Some places don't have any address
    const addressDetail = placeData[183]?.[1];
    const addressParsed = {
        neighborhood: addressDetail?.[1],
        street: addressDetail?.[2],
        city: addressDetail?.[3],
        postalCode: addressDetail?.[4],
        state: addressDetail?.[5],
        countryCode: addressDetail?.[6],
    };

    const coordsArr = placeData[9];
    // TODO: Very rarely place[9] is empty, figure out why
    const coords = coordsArr
        ? { lat: fixFloatNumber(coordsArr[2]), lng: fixFloatNumber(coordsArr[3]) }
        : { lat: null, lng: null };

    return {
        placeId: placeData[78],
        coords,
        addressParsed,
        isAdvertisement,
        website: placeData[7]?.[0] || null,
        categories,
        title: placeData[11],
    };
};

/**
 * Response from google xhr is kind a weird. Mix of array of array.
 * This function parse places from the response body.
 */
export const parseSearchPlacesResponseBody = (responseBodyText: string, isAllPacesNoSearch: boolean) => {
    const placesPaginationData: PlacePaginationData[] = [];

    const replaceString = isAllPacesNoSearch ? ")]}'" : '/*""*/';

    const jsonString = responseBodyText
        .replace(replaceString, '');
    let jsonObject;
    try {
        jsonObject = JSON.parse(jsonString);
    } catch (e) {
        return {
            placesPaginationData,
            error: 'Response body doesn\'t contain a valid JSON',
        };
    }

    // TODO: Maybe split this into more try/catches
    try {
        if (isAllPacesNoSearch) {
            const placeData = parseJsonResult(jsonObject[6], false);
            if (placeData) {
                placesPaginationData.push(placeData);
            } else {
                log.warning(`[SEARCH]: Cannot find place data while browsing with mouse over displayed places.`);
            }
            return { placesPaginationData, error: null };
        }
        const data = unstringifyGoogleXrhResponse(jsonObject.d);

        // We are paring ads but seems Google is not showing them to the scraper right now
        const ads = (data[2] && data[2][1] && data[2][1][0]) || [];

        ads.forEach((ad: any) => {
            const placeData = parseJsonResult(ad[15], true);
            if (placeData) {
                placesPaginationData.push(placeData);
            } else {
                log.warning(`[SEARCH]: Cannot find place data for advertisement in search.`);
            }
        });

        /** @type {any} Too complex to type out */
        let organicResults = data[0][1];
        // If the search goes to search results, the first one is not a place
        // If the search goes to a place directly, the first one is that place
        if (organicResults.length > 1) {
            organicResults = organicResults.slice(1);
        }
        organicResults.forEach((result: any) => {
            const placeData = parseJsonResult(result[14], false);
            if (placeData) {
                placesPaginationData.push(placeData);
            } else {
                log.warning(`[SEARCH]: Cannot find place data in search.`);
            }
        });
    } catch (e) {
        return {
            placesPaginationData,
            error: `Failed parsing JSON response: ${(e as Error).message}`,
        };
    }
    return { placesPaginationData, error: null };
};

/**
 * We combine page and rich JSON data, but all we need is in the JSON
 */
export const extractPageData = async ({ page, jsonData }: { page: Page, jsonData: any }) => {
    const jsonResult = parseJsonResult(jsonData, false);
    return page.evaluate((placeTitleSel, jsonResultEval: any) => {
        const address = $('[data-section-id="ad"] .section-info-line').text().trim();
        const addressAlt = $("button[data-tooltip*='address']").text().trim();
        const addressAlt2 = $("button[data-item-id*='address']").text().trim();
        const secondaryAddressLine = $('[data-section-id="ad"] .section-info-secondary-text').text().replace('Located in:', '').trim();
        const secondaryAddressLineAlt = $("button[data-tooltip*='locatedin']").text().replace('Located in:', '').trim();
        const secondaryAddressLineAlt2 = $("button[data-item-id*='locatedin']").text().replace('Located in:', '').trim();
        // Sometimes this includes weird postfixes like "door phone4" so we prefer phoneAlt
        const phone = $('[data-section-id="pn0"].section-info-speak-numeral').length
            ? $('[data-section-id="pn0"].section-info-speak-numeral').attr('data-href')!.replace('tel:', '')
            : $("button[data-tooltip*='phone']").text().trim();
        const phoneAlt = $('button[data-item-id*=phone]').text().trim();
        const categoryName = ((jsonResultEval.categories) && (jsonResultEval.categories.length > 0)) ? jsonResultEval.categories[0] : null;
        const description = $('span.PYvSYb').text().trim() || $('div[aria-label^="About"] button > div > div > div > span').text().trim() || null;

        const details: any = {
            title: $(placeTitleSel).text().trim(),
            subTitle: $(`*:has(> ${placeTitleSel})+h2`).first().text().trim() || null,
            description,
            price: $('span.mgr77e > span > span > span > span').text().trim() || $("span[aria-label^='Price: ']").text().trim() || null,
            menu: $("button[aria-label='Menu']").text().replace(/Menu/g, '').trim() || null,
            // Getting from JSON now
            // totalScore: $('span.section-star-display').eq(0).text().trim(),
            categoryName: $('[jsaction="pane.rating.category"]').text().trim() || categoryName,
            address: address || addressAlt || addressAlt2 || null,
            locatedIn: secondaryAddressLine || secondaryAddressLineAlt || secondaryAddressLineAlt2 || null,
            ...jsonResultEval.addressParsed || {},
            plusCode: $('[data-section-id="ol"] .widget-pane-link').text().trim()
                || $("button[data-tooltip*='plus code']").text().trim()
                || $("button[data-item-id*='oloc']").text().trim() || null,
            website: jsonResultEval.website,
            phone: phoneAlt || phone || null,
            temporarilyClosed: $('#pane,.skqShb').text().includes('Temporarily closed'),
            // TODO: Find this in jsonData, non-english language could mess this selector
            claimThisBusiness: $('[aria-label="Claim this business"]').length > 0,
            location: jsonResultEval.coords,
            reserveTableUrl: $('a:contains("Reserve a table")').attr('href') || undefined,
        };

        if (details.categoryName === 'Hotel') {
            // More hotels options sections for hotels
            let moreHotelsOptionsSections = $('[class="m6QErb UhIuC"]').slice(0, -1);
            // We want to ignore that `Featured options` section if it exists
            if (moreHotelsOptionsSections.length === 2) {
                moreHotelsOptionsSections = moreHotelsOptionsSections.slice(1);
            }

            const moreHotelsOptions = $(moreHotelsOptionsSections[0]).find('a').map((_, el) => {
                const url = $(el).attr('href');
                const title = $(el).find('.PZvKWc > span:first-child').text().trim() || null;
                const price = $(el).find('div[class="pUBf3e oiQUX"] > span:first-child').text().trim() || null;
                return {
                    url,
                    title,
                    price,
                };
            })
                .get()
                .filter((h: any) => h.title !== details.title && h.url && h.title && h.price);

            details.moreHotelsOptions = moreHotelsOptions.length > 0 ? moreHotelsOptions : undefined;
        }

        return details;
    }, PLACE_TITLE_SEL, jsonResult || {});
};

export const extractPopularTimes = ({ jsonData }: { jsonData: any }): PopularTimesOutput | object => {
    if (!jsonData) {
        return {};
    }
    const popularTimesData = jsonData[84];
    if (!popularTimesData) {
        return {};
    }

    const output: PopularTimesOutput = {
        // Live data are not present if it is outside opening hours now
        popularTimesLiveText: popularTimesData[6] || null,
        popularTimesLivePercent: popularTimesData[7]?.[1] || null,
        popularTimesHistogram: {},
    };

    // Format of histogram we want for output is
    // { day: [{ hour, occupancyPercent}, ...], ...}

    // Format Google has is
    // [day][1][hour] => [0] for hour, [1] for occupancy

    const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    const daysData = popularTimesData[0];
    daysData.forEach((dayData: any, i: number) => {
        output.popularTimesHistogram[DAYS[i]] = [];
        const hoursData = dayData[1];
        if (Array.isArray(hoursData)) {
            for (const hourData of hoursData) {
                const hourOutput = { hour: hourData[0], occupancyPercent: hourData[1] };
                output.popularTimesHistogram[DAYS[i]].push(hourOutput);
            }
        }
    });
    return output;
};

// This should have been just an object but we cannot do breaking change now
type OpeningHours = [
    { day: 'Monday', hours: string },
    { day: 'Tuesday', hours: string },
    { day: 'Wednesday', hours: string },
    { day: 'Thursday', hours: string },
    { day: 'Friday', hours: string },
    { day: 'Saturday', hours: string },
    { day: 'Sunday', hours: string },
]

export const extractOpeningHours = async ({ page, jsonData }: { page: Page, jsonData: any }) => {
    let unsortedOpeningHours: ({ day: string, hours: string } | undefined)[] = [];

    if (jsonData?.[34]?.[1]?.[0] && jsonData?.[34]?.[1]?.[1]) {
        unsortedOpeningHours = jsonData[34][1].map((entry: any) => ({
            day: entry[0],
            // replace "–" by " to " to make it consistent to extracting data from the DOM
            hours: entry[1].map((hourInterval: string) => hourInterval.replace('–', ' to ')).join(', '),
        }));
    } else {
        const openingHoursSel = '.section-open-hours-container.section-open-hours-container-hoverable';
        const openingHoursSelAlt = '.section-open-hours-container.section-open-hours';
        const openingHoursSelAlt2 = '.section-open-hours-container';
        const openingHoursSelAlt3 = '[jsaction*=openhours]+[class*=open]';
        const openingHoursEl = (await page.$(openingHoursSel))
            || (await page.$(openingHoursSelAlt))
            || (await page.$(openingHoursSelAlt2))
            || (await page.$(openingHoursSelAlt3));
        if (openingHoursEl) {
            const openingHoursText = await page.evaluate((openingHoursElem) => {
                return openingHoursElem.getAttribute('aria-label');
            }, openingHoursEl);

            const openingHours = openingHoursText!.split(openingHoursText!.includes(';') ? ';' : ',');
            if (openingHours.length) {
                unsortedOpeningHours = openingHours.map((line) => {
                    const regexpResult = line.trim().match(/(\S+)\s(.*)/);
                    if (regexpResult) {
                        // eslint-disable-next-line prefer-const
                        let [, day, hours] = regexpResult;
                        ([hours] = hours.split('.'));
                        return { day: day.replace(',', ''), hours };
                    }
                    log.debug(`[PLACE]: Not able to parse opening hours: ${line}`);
                    return undefined;
                });
            }
        }
    }

    // Order from Monday to Sunday, Google by default starts with current day
    // Unfortunately, we do this only for English language, we would have to translate all other langauges
    const openingHoursSorted: OpeningHours = [] as any;

    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    for (const day of DAYS) {
        const openingHours = unsortedOpeningHours.find((entry) => entry?.day === day);
        if (openingHours) {
            openingHoursSorted.push(openingHours as any);
        }
    }

    if (openingHoursSorted.length === 7) {
        return openingHoursSorted;
    }

    return unsortedOpeningHours;
};

/**
 * Essentially a list of similar places by categories
 */
export const extractPeopleAlsoSearch = (jsonData: any) => {
    const similarPlaces = [];
    const peopleAlsoSearchRaw = jsonData?.[99]?.[0];
    if (Array.isArray(peopleAlsoSearchRaw)) {
        for (const categoryPlaces of peopleAlsoSearchRaw) {
            if (Array.isArray(categoryPlaces)) {
                const category = categoryPlaces[0];
                const places = categoryPlaces[1];
                if (Array.isArray(places)) {
                    for (const place of places) {
                        // There are also places that have just ID, we ignore them for now but could be added
                        if (Array.isArray(place) && place.length >= 2) {
                            const placeDetail = place[1];
                            // This has almost full place data but we don't want to overload the output here
                            similarPlaces.push({
                                category,
                                title: placeDetail?.[11],
                                reviewsCount: placeDetail?.[4]?.[8],
                                totalScore: placeDetail?.[4]?.[7],
                                // TODO: Figure out the CID ID conversions to output placeId and url
                            });
                        }
                    }
                }
            }
        }
    }
    return similarPlaces;
};

export const extractAdditionalInfo = async ({ page, placeUrl, jsonData }: { page: Page, placeUrl: string, jsonData: any[] }) => {
    log.debug('[PLACE]: Scraping additional info.');
    let result;
    try {
        result = extractAdditionalInfoFromJson({ jsonData });
    } catch (err) {
        log.warning(`[PLACE]: Couldn't extract additionalInfo from jsonData: ${(err as Error).message}; page: ${placeUrl}. Will extract from DOM`);
    }
    if (result) {
        return result;
    }
    // We fallback to DOM extraction, it will give us time to fix JSON extraction
    await page.waitForSelector('button[jsaction*="pane.attributes.expand"]', { timeout: 5000 }).catch(() => { /* ignore */ });
    const button = await page.$('button[jsaction*="pane.attributes.expand"]');
    if (button) {
        try {
            await button.click({ delay: 200 });
            await page.waitForSelector(PLACE_TITLE_SEL, { timeout: 30000, hidden: true });
            result = await page.evaluate(() => {
                const innerResult: Record<string, any> = {};
                $('div[role="region"]').each((_, section) => {
                    const key = $(section).find('*[class*="fontTitleSmall"]').text().trim();
                    const values: Record<string, boolean>[] = [];
                    $(section).find('li:has(span[aria-label])').each((_i, sub) => {
                        const res: Record<string, boolean> = {};
                        const title = $(sub).text().trim();
                        const isChecked = $(sub).find('img[src*=check_black]').length > 0;

                        res[title] = isChecked;
                        values.push(res);
                    });
                    innerResult[key] = values;
                });
                return innerResult;
            });
            if (result && Object.keys(result).length > 0) {
                log.info(`[PLACE]: Additional info scraped from HTML for page: ${placeUrl}`);
            } else {
                log.info(`[PLACE]: Empty additional info section for page: ${placeUrl}`);
            }
        } catch (e) {
            log.info(`[PLACE]: ${e}Additional info not parsed`);
        } finally {
            await navigateBack(page, 'additional info', placeUrl);
        }
    } else {
        // DIV for "Hotel details" has the CSS class "WKLD0c"
        const hotelAvailAmenities = await page.$$eval('div[class="WKLD0c"] div:not([aria-disabled=true]) > span',
            (elements) => {
                return elements.map((element) => {
                    return element.textContent ? element.textContent.trim() : '';
                });
            },
        );
        const hotelDisabledAmenities = await page.$$eval('div[class="WKLD0c"] div[aria-disabled=true] > span',
            (elements) => {
                return elements.map((element) => {
                    return element.textContent ? element.textContent.trim() : '';
                });
            },
        );
        if (hotelAvailAmenities.length > 0) {
            const values = [];
            for (const name of hotelAvailAmenities) {
                values.push({ [name]: true });
            }
            for (const name of hotelDisabledAmenities) {
                values.push({ [name]: false });
            }
            log.info(`[PLACE]: Additional info (Amenities) scraped from HTML for page: ${placeUrl}`);
            return { Amenities: values };
        }
        log.warning(`Didn't find additional data, skipping - ${page.url()}`);
    }
    return result;
};

/**
 * Extracts additional infos for hotels and other categories according to the passed jsonData.
 *
 * Note: For hotels the jsonData often contains more infos than the Google-Maps page.
 * For some other places sometimes also additionInfos are in jsonData but not displayed on the page.
 * It never seems to be the other way around.
 */
const extractAdditionalInfoFromJson = ({ jsonData }: { jsonData: any[] }) => {
    // additional info for categories != hotel
    const resultBasic = extractAdditionalInfoBasicFromJson({ jsonData }) as { Amenities: any } | undefined;
    // hotel amenities
    const resultHotel = extractHotelAmenitiesFromJson({ jsonData });
    if (resultBasic && resultHotel) {
        if (resultBasic?.Amenities) {
            resultBasic.Amenities = [...resultBasic.Amenities, ...resultHotel.Amenities];
            return resultBasic;
        }
        return { ...resultBasic, ...resultHotel };
    }
    return resultBasic || resultHotel;
};

/**
 * Extracts additional infos which are visible for Google categories != hotel
 */
const extractAdditionalInfoBasicFromJson = ({ jsonData }: { jsonData: any }) => {
    if (!jsonData?.[100]) {
        return undefined;
    }
    if (!jsonData[100][1]?.[0]?.[1]
        || !Array.isArray(jsonData[100][1]?.[0]?.[2])) {
        throw new TypeError('wrong format');
    }
    const result: any = {};
    for (const section of jsonData[100][1]) {
        result[section[1]] = section[2].flatMap((option: any) => {
            if (typeof option?.[1] !== 'string') {
                throw new TypeError('wrong format for option name');
            }
            if (typeof option?.[2]?.[2]?.[0] === 'number') {
                return { [option[1]]: option[2][2][0] === 1 };
            }
            // accepted types of credit cards are listed in JSON
            // (although the Google Maps Frontend doesn't show the specific types)
            if (option?.[0] === '/geo/type/establishment_poi/pay_credit_card_types_accepted') {
                const acceptedCards = option?.[2]?.[4]?.[1]?.[0]?.[0];
                if (Array.isArray(acceptedCards)) {
                    const firstCard = acceptedCards?.[0];
                    // each card is stored in an array with >= 4 elements
                    return { [option[1]]: Array.isArray(firstCard) && firstCard.length >= 4 };
                }
                throw new TypeError(`${option[1]}: wrong format for accepted cards`);
            }
            // wifi options are sometimes listed in JSON
            if (option?.[0] === '/geo/type/establishment_poi/wi_fi') {
                if (!Array.isArray(option?.[2]?.[3])) {
                    throw new TypeError(`wrong format for wifi options`);
                }
                const wifiOptions = option?.[2].slice(3);
                return wifiOptions.map((wifiOption: any) => {
                    if (typeof wifiOption?.[2] !== 'string') {
                        throw new TypeError(`wrong format for wifi option`);
                    }
                    return { [wifiOption[2]]: true };
                });
            }
            throw new TypeError(`${option[1]}: wrong format for option value`);
        });
    };
    return result;
};

/**
 * Extracts the hotel details from the passed jsonData.
 * The return value will have the key "Amenities" to make it consistent to the old scraping from HTML.
 */
const extractHotelAmenitiesFromJson = ({ jsonData }: { jsonData: any }) => {
    // When Google doesn't display amenities, mostly jsonData[64] is null but
    // sometimes jsonData[64] also has a non-nested array with mostly nulls in it.
    // -> !jsonData?.[64] wouldn't be sufficient here
    if (!jsonData?.[64]?.[2]?.[0]) {
        return undefined;
    }
    if (!jsonData[64][2][0][2]
        || typeof jsonData[64][2][0][3] !== 'number') {
        throw new TypeError('wrong format for hotel amenities');
    }
    return {
        Amenities: jsonData[64][2].map((option: any) => ({
            [option[2]]: option[3] === 1,
        })),
    };
};
