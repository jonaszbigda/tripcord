# The dashboard is built on Debian: Tailwind v4's native binary is resolved for
# the platform the lockfile was generated on (glibc), which alpine (musl) may lack.
# Its output is static files, so it builds once on the build machine's platform,
# whatever the target. That also avoids resolving Tailwind's binary under QEMU.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS dashboard-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/js/package.json packages/js/package.json
COPY server/package.json server/package.json
COPY dashboard/package.json dashboard/package.json
RUN npm ci
COPY dashboard dashboard
RUN npm run build -w dashboard

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/js/package.json packages/js/package.json
COPY server/package.json server/package.json
COPY dashboard/package.json dashboard/package.json
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
COPY --from=dashboard-build /app/dashboard/dist dashboard/dist
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
