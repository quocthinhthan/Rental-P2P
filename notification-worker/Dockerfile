FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PDF_FONT_REGULAR=/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf \
    PDF_FONT_BOLD=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf

RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && test -f "$PDF_FONT_REGULAR" \
    && test -f "$PDF_FONT_BOLD"

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

USER node

CMD ["node", "worker.js"]
