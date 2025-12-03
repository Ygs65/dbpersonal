# Multi-stage Dockerfile: build client, then run node server
FROM node:18-alpine AS builder
WORKDIR /app

# copy client first and build
COPY client ./client
WORKDIR /app/client
RUN npm install
RUN npm run build

# final image
FROM node:18-alpine
WORKDIR /app
COPY package.json package.json
RUN npm install --production
COPY server.js server.js
COPY admin.js admin.js
# copy built client into public
COPY --from=builder /app/client/dist ./public

EXPOSE 3000
CMD ["node", "server.js"]
