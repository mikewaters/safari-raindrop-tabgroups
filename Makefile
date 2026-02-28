PREFIX ?= /usr/local/bin
BIN = safari-tabgroups
BIN_FETCH = fetch-tabgroup
BIN_DESCRIBE = describe-tabgroup
BIN_RAINDROP = raindrop-tabgroups
BIN_LIST = list-tabgroups
BIN_SYNC = sync-tabgroups

.PHONY: build install uninstall clean

build:
	bun build src/safari.ts --compile --outfile $(BIN)
	bun build src/fetch.ts --compile --outfile $(BIN_FETCH)
	bun build src/describe.ts --compile --outfile $(BIN_DESCRIBE)
	bun build src/raindrop.ts --compile --outfile $(BIN_RAINDROP)
	bun build src/list.ts --compile --outfile $(BIN_LIST)
	bun build src/sync.ts --compile --outfile $(BIN_SYNC)

install: build
	cp $(BIN) $(PREFIX)/$(BIN)
	cp $(BIN_FETCH) $(PREFIX)/$(BIN_FETCH)
	cp $(BIN_DESCRIBE) $(PREFIX)/$(BIN_DESCRIBE)
	cp $(BIN_RAINDROP) $(PREFIX)/$(BIN_RAINDROP)
	cp $(BIN_LIST) $(PREFIX)/$(BIN_LIST)
	cp $(BIN_SYNC) $(PREFIX)/$(BIN_SYNC)

uninstall:
	rm -f $(PREFIX)/$(BIN)
	rm -f $(PREFIX)/$(BIN_FETCH)
	rm -f $(PREFIX)/$(BIN_DESCRIBE)
	rm -f $(PREFIX)/$(BIN_RAINDROP)
	rm -f $(PREFIX)/$(BIN_LIST)
	rm -f $(PREFIX)/$(BIN_SYNC)

clean:
	rm -f $(BIN)
	rm -f $(BIN_FETCH)
	rm -f $(BIN_DESCRIBE)
	rm -f $(BIN_RAINDROP)
	rm -f $(BIN_LIST)
	rm -f $(BIN_SYNC)
	rm -f .*.bun-build
