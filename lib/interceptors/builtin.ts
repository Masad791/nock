import http from 'node:http'
import * as common from '../common.ts'
import handleRequest from '../handle-request.ts'
import { setGetRequestBody } from '../utils/node/index.ts'
import { BatchInterceptor } from '@mswjs/interceptors'
import { FetchInterceptor } from '@mswjs/interceptors/fetch'
import { HttpRequestInterceptor } from '@mswjs/interceptors/http'

const interceptor = new BatchInterceptor({
  name: 'intercept',
  interceptors: [new HttpRequestInterceptor(), new FetchInterceptor()],
})

// A Fetch API `Request` can't have a body for GET, so @mswjs/interceptors drops it.
// Record what is written to GET `ClientRequest`s, so it can still be matched.
interface RecordedBody {
  chunks: Buffer[]
  onWrite?: () => void
}
const recordedGetBodies = new Map<http.ClientRequest, RecordedBody>()
let originalWrite: http.ClientRequest['write'] | undefined
let originalEnd: http.ClientRequest['end'] | undefined

function getRecordedBody(req: http.ClientRequest) {
  let recorded = recordedGetBodies.get(req)
  if (!recorded) {
    recorded = { chunks: [] }
    recordedGetBodies.set(req, recorded)
    req.once('close', () => recordedGetBodies.delete(req))
  }
  return recorded
}

function recordGetRequestChunk(
  req: http.ClientRequest,
  chunk: unknown,
  encoding: unknown,
) {
  if (req.method !== 'GET') {
    return
  }
  const { chunks } = getRecordedBody(req)
  if (typeof chunk === 'string') {
    const bufferEncoding = typeof encoding === 'string' ? encoding : 'utf8'
    chunks.push(Buffer.from(chunk, bufferEncoding as BufferEncoding))
  } else if (chunk instanceof Uint8Array) {
    chunks.push(Buffer.from(chunk))
  }
}

function startRecordingGetBodies() {
  const proto = http.ClientRequest.prototype
  const write = (originalWrite = proto.write)
  const end = (originalEnd = proto.end)

  proto.write = function (this: http.ClientRequest, ...args: any[]) {
    recordGetRequestChunk(this, args[0], args[1])
    const result = Reflect.apply(write, this, args)
    recordedGetBodies.get(this)?.onWrite?.()
    return result
  } as http.ClientRequest['write']

  proto.end = function (this: http.ClientRequest, ...args: any[]) {
    recordGetRequestChunk(this, args[0], args[1])
    const result = Reflect.apply(end, this, args)
    recordedGetBodies.get(this)?.onWrite?.()
    return result
  } as http.ClientRequest['end']
}

function stopRecordingGetBodies() {
  const proto = http.ClientRequest.prototype
  if (originalWrite) proto.write = originalWrite
  if (originalEnd) proto.end = originalEnd
  originalWrite = originalEnd = undefined
  recordedGetBodies.clear()
}

function findClientRequest(initiator: unknown, request: Request) {
  if (initiator instanceof http.ClientRequest) {
    // A `ClientRequest` initiator can come from an unrelated request context
    // (e.g. a request made while recording), so look for the request by its path.
    for (const req of recordedGetBodies.keys()) {
      if (new URL(req.path, request.url).href === request.url) {
        return req
      }
    }
    return undefined
  }
  // Otherwise the initiator is the socket that the `ClientRequest` writes to.
  const req = Reflect.get(Object(initiator), '_httpMessage')
  return req instanceof http.ClientRequest ? req : undefined
}

// Like a server, rely on the request framing to know whether more body is coming.
function isBodyComplete(req: http.ClientRequest, chunks: Buffer[]) {
  if (req.writableEnded) {
    return true
  }
  const contentLength = Number(req.getHeader('content-length'))
  if (contentLength > 0) {
    return Buffer.concat(chunks).byteLength >= contentLength
  }
  return !/chunked/i.test(String(req.getHeader('transfer-encoding') ?? ''))
}

async function readGetRequestBody(initiator: unknown, request: Request) {
  const req = findClientRequest(initiator, request)
  if (!req) {
    return new ArrayBuffer(0)
  }
  const recorded = getRecordedBody(req)
  while (!isBodyComplete(req, recorded.chunks)) {
    await new Promise<void>(resolve => (recorded.onWrite = resolve))
  }
  recordedGetBodies.delete(req)
  return Uint8Array.from(Buffer.concat(recorded.chunks)).buffer
}

function activate() {
  interceptor.apply()
  startRecordingGetBodies()

  // Force msw to forward Nock's error instead of coerce it into 500 error
  interceptor.on('unhandledException', ({ controller, error }: any) => {
    controller.errorWith(error)
  })
  interceptor.on(
    'request',
    async function ({ request, controller, initiator }) {
      if (request.headers.get('expect') === '100-continue') {
        // We currently do not support mocking 100-continue responses, so they are passed through for now.
        return
      }

      // If this is GET request with body, we need to read the body from the ClientRequest because Fetch API doesn't support this.
      const requestBodyBuffer: ArrayBuffer = common.decompressRequestBody(
        request.method === 'GET'
          ? await readGetRequestBody(initiator, request)
          : await request.clone().arrayBuffer(),
        request.headers.get('content-encoding') || '',
      ) as ArrayBuffer

      const decompressedRequest = new Request(request, {
        body:
          requestBodyBuffer.byteLength > 0 && request.method !== 'GET'
            ? requestBodyBuffer
            : undefined,
      })
      if (requestBodyBuffer.byteLength > 0 && request.method === 'GET') {
        setGetRequestBody(decompressedRequest, requestBodyBuffer)
      }

      const response = await handleRequest(decompressedRequest)
      if (response) {
        controller.respondWith(response)
      }
    },
  )
}

function deactivate() {
  interceptor.dispose()
  stopRecordingGetBodies()
}

export { activate, deactivate }
