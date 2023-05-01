import bsky from '@atproto/api';
const { BskyAgent } = bsky;
import * as dotenv from 'dotenv';
import process from 'node:process';
import fs from 'fs';
import vision from '@google-cloud/vision';
import { createCanvas } from 'canvas';
import splitter from 'unicode-default-word-boundary';
dotenv.config();
// Set the desired polling interval (in milliseconds)
const POLLING_INTERVAL = 10000; // ten seconds
const visionClient = new vision.ImageAnnotatorClient();
// Create a Bsky Agent
const agent = new BskyAgent({
    service: 'https://bsky.social',
});
await agent.login({
    identifier: process.env.BSKY_USERNAME,
    password: process.env.BSKY_PASSWORD,
});
async function getNotifications() {
    if (!agent) {
        throw new Error('agent not set up');
    }
    const notifs = await agent.api.app.bsky.notification.listNotifications({ limit: 50 });
    if (!notifs.success) {
        throw new Error('failed to get notifications');
    }
    const out = [];
    for (const notif of notifs.data.notifications) {
        if (notif.reason !== 'mention') {
            continue;
        }
        if (notif.record?.text.startsWith(process.env.BSKY_USERNAME)) {
            continue;
        }
        if (notif.isRead) {
            continue;
        }
        out.push(notif);
    }
    return out;
}
const auxImageEdgeLength = 1000;
const auxImageFontPixels = 100;
// TODO: refactor this
function getAuxImage(imageNumber, totalImages, locale, num, totalAlts) {
    const canvas = createCanvas(auxImageEdgeLength, auxImageEdgeLength);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, auxImageEdgeLength, auxImageEdgeLength);
    ctx.fillStyle = 'black';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.font = `${auxImageFontPixels / 2}px sans-serif`;
    ctx.fillText(`Image ${imageNumber} of ${totalImages}, text ${num} of ${totalAlts}`, auxImageEdgeLength - 20, auxImageEdgeLength - 20);
    return canvas.toDataURL();
}
async function ocr(url) {
    console.log(`${new Date().toISOString()}: Attempting to recognize ${url}`);
    let [result] = await visionClient.textDetection(url).catch((err) => {
        console.log(err);
        return [];
    });
    if (result && result.textAnnotations) {
        const text = result.textAnnotations
            .filter((t) => !!t.locale)
            .map((t) => t.description)
            .join(' ')
            .replace(/(\r\n|\n|\r)/gm, ' ');
        if (!text) {
            return null;
        }
        const locales = result.textAnnotations
            .filter((t) => !!t.locale)
            .reduce((loc, t) => {
            loc[t.locale] = (loc[t.locale] || 0) + 1;
            return loc;
        }, {});
        const localeAndCount = Object.entries(locales).sort((entryA, entryB) => entryA[1] - entryB[1])[0] || [
            'default',
            0,
        ];
        return {
            text: text,
            locale: localeAndCount[0],
        };
    }
    else {
        return null;
    }
}
async function ocrSkeetImages(images, did) {
    if (images.length > 0) {
        return Promise.all(images.map((img) => {
            return agent.api.com.atproto.sync
                .getBlob({
                did: did,
                cid: img.image.original.ref.toString(),
            })
                .then((fetchedFile) => {
                return fs.promises
                    .writeFile(img.image.mimeType.replace('/', '.'), fetchedFile.data)
                    .then(() => {
                    return ocr(img.image.mimeType.replace('/', '.'))
                        .then((imgOcr) => {
                        if (imgOcr) {
                            return { img: img, text: imgOcr.text, locale: imgOcr.locale, extracted: true };
                        }
                        else {
                            return { img: img, text: 'No text extracted', locale: 'default', extracted: false };
                        }
                    })
                        .catch((e) => {
                        console.log(`Error fetching OCR for image: ${JSON.stringify(e)}`);
                        return { img: img, text: 'Error extracting text', locale: 'default', extracted: false };
                    });
                })
                    .catch((err) => console.error(err));
            });
        })).catch((err) => {
            console.log(`${new Date().toISOString()}: Error attempting to recognize images`);
            console.log(err);
            return null;
        });
    }
    else {
        return null;
    }
}
function splitText(text, maxLen) {
    let result = [];
    let lastSpan = { end: 0 };
    let lenBase = 0;
    let split = Array.from(splitter.findSpans(text));
    split.forEach((span) => {
        if (span.end - lenBase > maxLen) {
            result.push(text.substring(lenBase, lastSpan.end));
            lenBase = span.start;
        }
        lastSpan = span;
    });
    if (text.length > lenBase) {
        result.push(text.substring(lenBase, text.length));
    }
    return result;
}
function getRootCdiAndUri(notif) {
    return {
        cid: notif?.record?.reply?.root?.cid || notif.cid,
        uri: notif?.record?.reply?.root?.uri || notif.uri,
    };
}
async function pollApi() {
    try {
        // Request data from the API endpoint
        const notifs = await getNotifications();
        if (notifs.length > 0) {
            await agent.api.app.bsky.notification.updateSeen({ seenAt: notifs[notifs.length - 1]?.indexedAt });
        }
        for await (const notif of notifs) {
            const postUri = notif.uri;
            const parentPost = notif?.record?.reply.parent;
            const parentThread = await agent.api.app.bsky.feed.getPostThread({ uri: parentPost.uri });
            const imagesToOCR = parentThread?.data?.thread?.post?.record?.embed?.images;
            console.log('Images to OCR:', imagesToOCR);
            const replyRef = {
                parent: {
                    cid: notif.cid,
                    uri: notif.uri,
                },
                root: getRootCdiAndUri(notif),
            };
            if (imagesToOCR.length === 0 || !postUri) {
                continue;
            }
            let ocrs = await ocrSkeetImages(imagesToOCR, parentThread?.data?.thread?.post?.author?.did);
            if (ocrs && ocrs.length > 0) {
                const anySucceeded = ocrs.map((ocr) => ocr.extracted).reduce((a, b) => a || b, false);
                if (!anySucceeded) {
                    console.log(`Couldn't extract text from any images found`);
                    return;
                }
                let splitOcrs = ocrs.map((ocr) => ({
                    img: ocr.img,
                    text: ocr.text,
                    locale: ocr.locale,
                    split: splitText(ocr.text, 1000),
                }));
                console.log('Split OCRs:', splitOcrs);
                // TODO: refactor this
                let imageGroups = [];
                let uploadsForImage = [];
                let uploadFailures = false;
                let imageNumber = 0;
                for await (const ocrRecord of splitOcrs) {
                    imageNumber++;
                    let imageRecord = ocrRecord.img;
                    if (imageRecord) {
                        for (let j = 0; j < ocrRecord.split.length; j++) {
                            let auxImage = getAuxImage(imageNumber, splitOcrs.length, ocrRecord.locale, j + 1, ocrRecord.split.length);
                            let auxImageAltText = ocrRecord.split[j];
                            const res = await fetch(auxImage);
                            const blob = await res.blob();
                            await fs.promises.writeFile('aux-image.png', new DataView(await blob.arrayBuffer()));
                            const file = fs.readFileSync('aux-image.png');
                            const res2 = await agent.api.com.atproto.repo.uploadBlob(file, {
                                encoding: 'image/png',
                            });
                            const { data: { blob: smallBlob }, } = res2;
                            uploadsForImage.push({ image: smallBlob, alt: auxImageAltText });
                        }
                        imageGroups.push(uploadsForImage);
                    }
                    else {
                        console.log('Failed to fetch image');
                        break;
                    }
                }
                let totalImagesToUpload = imageGroups.map((group) => group.length).reduce((prev, cur) => prev + cur);
                console.log(`Image groups: ${JSON.stringify(imageGroups)}`);
                if (uploadFailures) {
                    console.log('Failed to upload images for response');
                }
                else {
                    if (totalImagesToUpload <= 4) {
                        // Upload all alt text within one skeet
                        await agent.post({
                            text: 'Alt text retrieved',
                            reply: replyRef,
                            embed: { images: imageGroups[0], $type: 'app.bsky.embed.images' },
                            createdAt: new Date().toISOString(),
                        });
                    }
                    else {
                        // TODO: refactor this
                        const group = imageGroups[0];
                        let currReplyRef = replyRef;
                        for (let idxStart = 0; idxStart < group.length; idxStart += 4) {
                            const chunk = group.slice(idxStart, idxStart + 4);
                            const postRes = await agent.post({
                                text: `Alt text ${(idxStart + 1).toString()} through ${group.length < idxStart + 4 ? group.length : idxStart + 4} of ${group.length}`,
                                reply: currReplyRef,
                                embed: { images: chunk, $type: 'app.bsky.embed.images' },
                                createdAt: new Date().toISOString(),
                            });
                            // Thread multiple skeets together with all alt text from ocr
                            currReplyRef = {
                                parent: {
                                    cid: postRes.cid,
                                    uri: postRes.uri,
                                },
                                root: getRootCdiAndUri(notif),
                            };
                        }
                    }
                }
            }
        }
    }
    catch (error) {
        console.error('Error:', error);
    }
    // Continue polling
    setTimeout(pollApi, POLLING_INTERVAL);
}
// Start polling the API
pollApi();
