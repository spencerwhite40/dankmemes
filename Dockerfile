# Image for the processing machine (Fly.io or anywhere): the same code as the web app, started as the runner only.
FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
# default: the web app. The runner machine overrides this with `npm run worker` (see fly.toml).
CMD ["npm", "start"]
