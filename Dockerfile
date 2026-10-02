FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
ARG LITESPEED_API_URL=
ENV LITESPEED_API_URL=$LITESPEED_API_URL HOST=0.0.0.0 PORT=8787 NODE_ENV=production
RUN node scripts/build-web.mjs
USER node
EXPOSE 8787
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "src/server.js"]
