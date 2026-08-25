FROM node:20.20.2-bookworm-slim

WORKDIR /opt/andflow

# The acceptance command does not execute Cypress. Avoid downloading its
# separate browser bundle while still running all native dependency install
# scripts, including sqlite3 and faiss-node.
ENV CYPRESS_INSTALL_BINARY=0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git cmake python3 make g++ libopenblas-dev pkg-config libvips-dev \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global --force pnpm@9.15.9 \
  && pnpm --version | grep -Fx '9.15.9'

RUN apt-get update \
  && apt-get install -y --no-install-recommends patchelf \
  && rm -rf /var/lib/apt/lists/*

# The external repository's .dockerignore excludes its host node_modules. The
# install therefore compiles sqlite3 for this image's Linux architecture rather
# than reusing the macOS dependency tree from the developer workstation.
COPY . .
RUN pnpm --filter andflow... --filter andflow-ui... install --frozen-lockfile --ignore-scripts \
  && pnpm rebuild @swc/core cypress esbuild faiss-node protobufjs sqlite3 \
  && find /opt/andflow/node_modules/.pnpm -path '*/faiss-node@0.5.1/node_modules/faiss-node' -prune -exec sh -c 'cd "$1" && CMAKE_BUILD_PARALLEL_LEVEL=4 npm run install' sh {} \; \
  && find /opt/andflow/node_modules/.pnpm -path '*/sharp@0.32.6/node_modules/sharp' -prune -exec sh -c 'cd "$1" && SHARP_FORCE_GLOBAL_LIBVIPS=1 npm run install' sh {} \; \
  && find /opt/andflow/node_modules/.pnpm -path '*/sharp@0.33.5/node_modules/sharp' -prune -exec sh -c 'cd "$1" && npm run install' sh {} \; \
  && node -e "const sqlite3 = require('sqlite3'); const db = new sqlite3.Database(':memory:'); db.close(); console.log('linux-native-sqlite3=' + sqlite3.VERSION)"

CMD ["node", "-e", "console.log('andflow-linux-dependencies-ready')"]
