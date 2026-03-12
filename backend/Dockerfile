FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["sh", "-c", "exec node --max-old-space-size=${NODE_HEAP_SIZE:-512} dist/main"]
