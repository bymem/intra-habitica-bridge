# Base image is pinned here rather than via build.yaml.
#
# Two reasons, both learned the hard way on sibling add-ons:
#   - build.yaml is deprecated; the Supervisor wants build parameters in the
#     Dockerfile. Its build_from values must be namespaced paths, so a bare
#     "node:24-alpine" fails validation and the Supervisor silently falls back
#     to its default base — which has no Node in it.
#   - The Supervisor always passes --build-arg BUILD_FROM=<ha base image>. An
#     `ARG BUILD_FROM=node:24-alpine` default can therefore never win; the
#     injected value does, and the build dies on "node: not found". So we
#     deliberately do NOT consume BUILD_FROM. Docker warns that the build arg
#     is unused; that warning is expected and correct.
FROM node:24-alpine

# Node 24 specifically: state lives in the built-in node:sqlite module, which
# still needs an --experimental flag (and warns on every start) on 22.
# The Supervisor passes the add-on's version from config.yaml as a build arg;
# exposing it puts the running version in the log.
ARG BUILD_VERSION=unknown
ENV ADDON_VERSION=${BUILD_VERSION}

ENV NODE_ENV=production

WORKDIR /app

# Dependencies first so a source-only change doesn't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Configuration comes from /data/options.json, which the Supervisor writes
# whenever the Configuration tab is saved. No bashio or shell parsing needed.
CMD ["node", "src/index.js"]
