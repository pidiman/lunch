FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js entrypoint.js favicon.svg ./

EXPOSE 3000
CMD ["node", "entrypoint.js"]
