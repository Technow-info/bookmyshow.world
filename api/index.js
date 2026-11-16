'use strict';
// Vercel entry point: every request (pages, assets, API) goes through the same handler as `node server.js`.
// Storage on Vercel MUST be Upstash Redis (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN): the disk is temporary.
const { handler } = require('../server');

module.exports = handler;
