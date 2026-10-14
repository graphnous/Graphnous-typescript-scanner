# The TypeScript scanner as an image. Its entrypoint runs the scanner, so
# arguments go straight to it:
#
#   docker run --rm -v "$PWD:/repository:ro" -v "$PWD/out:/output" \
#     ghcr.io/graphnous/graphnous-typescript-scanner:0.1.0 \
#     --path /repository --target . --output /output/scan-result.json
#
# The Graphnous server instead overrides the entrypoint with the full
# command from its configuration: node /opt/graphnous/scanner.js ...

FROM node:24-alpine AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts scripts
COPY src src
RUN npm run build


FROM node:24-alpine

# The scanner, with TypeScript's built-in library next to it
COPY --from=build /build/build/ /opt/graphnous/

# The package cache, for a volume to keep downloaded packages for the next
# scans; scans run as the image's unprivileged user, and the repository is
# mounted read-only
RUN mkdir /npm-cache && chown node /npm-cache

# Downloads go through the proxy of HTTPS_PROXY and NO_PROXY, when set
ENV NODE_USE_ENV_PROXY=1

USER node

ENTRYPOINT ["node", "/opt/graphnous/scanner.js"]
