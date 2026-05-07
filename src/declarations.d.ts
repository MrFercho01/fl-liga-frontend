// Declaración manual para xlsx (SheetJS) — necesaria porque moduleResolution: "bundler"
// no resuelve el campo "types" del package.json de xlsx 0.18.x automáticamente.
declare module 'xlsx' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function read(data: any, opts?: any): any
  const utils: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sheet_to_json<T = unknown>(worksheet: any, opts?: any): T[]
  }
}
