FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/js/package.json packages/js/package.json
COPY server/package.json server/package.json
RUN npm ci
COPY packages/js packages/js
COPY server server
RUN npm run build -w packages/js
RUN npm run build -w server

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/packages/js/dist packages/js/dist
COPY --from=build /app/packages/js/package.json packages/js/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/drizzle server/drizzle
COPY --from=build /app/server/package.json server/package.json
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
