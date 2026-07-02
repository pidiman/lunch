# Stage 1: build the Tailwind CSS from the classes used in server.js
FROM node:24-alpine AS assets

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tailwind.input.css server.js ./
RUN npm run build:css

# Stage 2: runtime image with production deps only
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js favicon.svg ./
COPY --from=assets /build/tailwind.css ./

USER node
EXPOSE 3000
CMD ["node", "server.js"]
