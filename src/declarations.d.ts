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

declare module 'tesseract.js' {
  export function recognize(
    image: File | Blob | string,
    lang?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any,
  ): Promise<{ data: { text: string } }>
}
