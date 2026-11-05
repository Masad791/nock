import { Readable as ReadableStream } from 'node:stream'

const kGetRequestBody: unique symbol = Symbol('kGetRequestBody') as any

function getGetRequestBody(request: Request) {
  if (request.method !== 'GET') {
    throw new Error('The request method must be GET')
  }
  return ReadableStream.from(Buffer.from(readGetRequestBody(request)))
}

function readGetRequestBody(request: Request): ArrayBuffer {
  const body: Buffer | undefined = Reflect.get(request, kGetRequestBody)
  return body ? Uint8Array.from(body).buffer : new ArrayBuffer(0)
}

function setGetRequestBody(request: Request, body: ArrayBuffer) {
  Reflect.set(request, kGetRequestBody, Buffer.from(body))
}

export { getGetRequestBody, readGetRequestBody, setGetRequestBody }
