FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npm run build

# H-28: Laufzeit-Abhängigkeiten in einer eigenen Stage, ohne devDependencies.
# Vorher kam der volle node_modules-Baum der Build-Stage ins Image —
# typescript, eslint, @types/*, die Nest-CLI: mehr CVE-Fläche, ein grösseres
# Image (Jetson-Transfer per docker save | ssh docker load) und bei einer RCE
# eine fertige Toolchain für den Angreifer.
FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
RUN mkdir -p /app/data/lancedb && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["sh", "-c", "exec node --max-old-space-size=${NODE_HEAP_SIZE:-512} dist/main"]
