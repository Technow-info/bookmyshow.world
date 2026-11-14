# Bookmyshow.world: zero-dependency Node app
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3000
# Bookings, queries and the ticket-signing key live here: mount a persistent volume on /data
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
