PREFIX ?= /usr/local/bin
BIN = safari-tabgroups

.PHONY: build install uninstall clean

build:
	bun build src/index.ts --compile --outfile $(BIN)

install: build
	cp $(BIN) $(PREFIX)/$(BIN)

uninstall:
	rm -f $(PREFIX)/$(BIN)

clean:
	rm -f $(BIN)
