FROM node:20-alpine
RUN apk add --no-cache git docker-cli docker-cli-compose
WORKDIR /app
COPY server.js .
CMD ["node", "server.js"]
