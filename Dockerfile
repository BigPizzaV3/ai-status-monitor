FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache chromium font-noto-cjk
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
RUN mkdir -p /app/data /app/config && chown -R node:node /app

USER node
EXPOSE 3000
CMD ["node", "src/server.mjs"]
