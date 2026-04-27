/**
 * pdfjs-dist (loaded transitively via scrape2md → @opendocsg/pdf2md) emits
 * polyfill/native-binding warnings to stdout via `console.log` at module-eval
 * time. That corrupts our `--json` output. Filter out only those known
 * load-time warnings; pass everything else through untouched.
 */
const PDFJS_WARNING_PATTERNS = [
  /^Warning: Cannot load "@napi-rs\/canvas"/,
  /^Warning: Cannot polyfill `(DOMMatrix|ImageData|Path2D)`/,
  /^Warning: Cannot access the `require` function/,
];

const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && PDFJS_WARNING_PATTERNS.some((re) => re.test(args[0] as string))) {
    return;
  }
  originalLog(...args);
};
