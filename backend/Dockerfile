FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json ./
RUN npm install --omit=dev

# Copy backend source
COPY . .

# Data directory (mounted from host)
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "server.js"]
