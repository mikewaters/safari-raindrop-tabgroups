FROM oven/bun:latest

WORKDIR /app

# Predictable XDG paths inside the container
ENV XDG_CONFIG_HOME=/config
ENV XDG_DATA_HOME=/data
ENV XDG_CACHE_HOME=/cache

# make is needed for the build system
RUN apt-get update && apt-get install -y --no-install-recommends make && rm -rf /var/lib/apt/lists/*

# Install deps (layer-cached)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source + build support
COPY src/ src/
COPY schema/ schema/
COPY Makefile ./
COPY fetch.config.toml ./

# Compile all binaries and install to PATH
RUN make build && make install PREFIX=/usr/local/bin

# Place config at the XDG path compiled binaries expect,
# with database.path pointing to the container volume
RUN mkdir -p /config/safari-tabgroups /data /cache \
    && sed 's|path = "./bookmarks.db"|path = "/data/bookmarks.db"|' \
       fetch.config.toml > /config/safari-tabgroups/config.toml

EXPOSE 8435

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://localhost:8435/healthz').then(r=>{if(!r.ok)process.exit(1)})" || exit 1

# Default: run the server. Override to run any CLI.
CMD ["bookmark-index-server"]
