PREFIX ?= $(HOME)/.local/bin
OUTDIR = dist
CONFIGDIR = $(HOME)/.config/safari-tabgroups
BIN = safari-tabgroups
BIN_FETCH = fetch-tabgroup
BIN_DESCRIBE = describe-tabgroup
BIN_RAINDROP = raindrop-tabgroups
BIN_LIST = list-tabgroups
BIN_SAFARI_SYNC = safari-sync
BIN_RAINDROP_SYNC = raindrop-sync
BIN_INDEX = bookmark-index
BIN_RAINDROP_ADD = raindrop-add
BIN_SERVER = bookmark-index-server

.PHONY: build install uninstall clean raycast

build:
	mkdir -p $(OUTDIR)
	cd $(OUTDIR) && bun build ../src/safari.ts --compile --outfile $(BIN)
	cd $(OUTDIR) && bun build ../src/fetch.ts --compile --outfile $(BIN_FETCH)
	cd $(OUTDIR) && bun build ../src/describe.ts --compile --outfile $(BIN_DESCRIBE)
	cd $(OUTDIR) && bun build ../src/raindrop.ts --compile --outfile $(BIN_RAINDROP)
	cd $(OUTDIR) && bun build ../src/list.ts --compile --outfile $(BIN_LIST)
	cd $(OUTDIR) && bun build ../src/safari-sync.ts --compile --outfile $(BIN_SAFARI_SYNC)
	cd $(OUTDIR) && bun build ../src/raindrop-sync.ts --compile --outfile $(BIN_RAINDROP_SYNC)
	cd $(OUTDIR) && bun build ../src/index.ts --compile --outfile $(BIN_INDEX)
	cd $(OUTDIR) && bun build ../src/raindrop-add.ts --compile --outfile $(BIN_RAINDROP_ADD)
	cd $(OUTDIR) && bun build ../src/server.ts --compile --outfile $(BIN_SERVER)

install: build
	@mkdir -p $(PREFIX)
	cp $(OUTDIR)/$(BIN) $(PREFIX)/$(BIN)
	cp $(OUTDIR)/$(BIN_FETCH) $(PREFIX)/$(BIN_FETCH)
	cp $(OUTDIR)/$(BIN_DESCRIBE) $(PREFIX)/$(BIN_DESCRIBE)
	cp $(OUTDIR)/$(BIN_RAINDROP) $(PREFIX)/$(BIN_RAINDROP)
	cp $(OUTDIR)/$(BIN_LIST) $(PREFIX)/$(BIN_LIST)
	cp $(OUTDIR)/$(BIN_SAFARI_SYNC) $(PREFIX)/$(BIN_SAFARI_SYNC)
	cp $(OUTDIR)/$(BIN_RAINDROP_SYNC) $(PREFIX)/$(BIN_RAINDROP_SYNC)
	cp $(OUTDIR)/$(BIN_INDEX) $(PREFIX)/$(BIN_INDEX)
	cp $(OUTDIR)/$(BIN_RAINDROP_ADD) $(PREFIX)/$(BIN_RAINDROP_ADD)
	cp $(OUTDIR)/$(BIN_SERVER) $(PREFIX)/$(BIN_SERVER)
	@echo "Installed binaries to $(PREFIX)"
	@mkdir -p $(CONFIGDIR)
	@if [ ! -f $(CONFIGDIR)/config.toml ]; then \
		cp fetch.config.toml $(CONFIGDIR)/config.toml; \
		echo "Installed config to $(CONFIGDIR)/config.toml"; \
	else \
		echo "Config already exists at $(CONFIGDIR)/config.toml, skipping"; \
	fi

uninstall:
	rm -f $(PREFIX)/$(BIN)
	rm -f $(PREFIX)/$(BIN_FETCH)
	rm -f $(PREFIX)/$(BIN_DESCRIBE)
	rm -f $(PREFIX)/$(BIN_RAINDROP)
	rm -f $(PREFIX)/$(BIN_LIST)
	rm -f $(PREFIX)/$(BIN_SAFARI_SYNC)
	rm -f $(PREFIX)/$(BIN_RAINDROP_SYNC)
	rm -f $(PREFIX)/$(BIN_INDEX)
	rm -f $(PREFIX)/$(BIN_RAINDROP_ADD)
	rm -f $(PREFIX)/$(BIN_SERVER)
	@echo "Note: config at $(CONFIGDIR)/config.toml was preserved"

clean:
	rm -rf $(OUTDIR)
	rm -f .*.bun-build

raycast:
	cd raycast-extension && npm install && npm run build

cleandb:
	rm -rf bookmarks.db*
