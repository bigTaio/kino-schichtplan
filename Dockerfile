FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Europe/Berlin DATABASE_FILE=/data/kino.db
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
