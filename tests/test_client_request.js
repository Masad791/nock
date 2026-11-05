import { expect } from 'chai'
import { once } from 'node:events'
import http from 'node:http'
import sinon from 'sinon'
import nock from '../index.ts'

import { startHttpServer } from './servers/index.js'

// Because `Got` makes use of the `http(s).request` convenience function, it can not be used during these tests.
describe('Direct use of `ClientRequest`', () => {
  it('should intercept GET requests', done => {
    const dataSpy = sinon.spy()

    const scope = nock('http://example.test').get('/dsad').reply(202, 'HEHE!')

    const req = new http.ClientRequest({
      host: 'example.test',
      path: '/dsad',
    })

    req.on('response', function (res) {
      expect(res.statusCode).to.equal(202)
      res.on('end', function () {
        expect(dataSpy).to.have.been.calledOnce()
        scope.done()
        done()
      })
      res.on('data', function (data) {
        dataSpy()
        expect(data).to.be.instanceof(Buffer)
        expect(data.toString()).to.equal('HEHE!')
      })
    })

    req.end()
  })

  it('should intercept POST requests', done => {
    const dataSpy = sinon.spy()

    const scope = nock('http://example.test')
      .post('/posthere/please', 'heyhey this is the body')
      .reply(201, 'DOOONE!')

    const req = new http.ClientRequest({
      host: 'example.test',
      path: '/posthere/please',
      method: 'POST',
    })
    req.write('heyhey this is the body')

    req.on('response', function (res) {
      expect(res.statusCode).to.equal(201)
      res.on('end', function () {
        expect(dataSpy).to.have.been.calledOnce()
        scope.done()
        done()
      })
      res.on('data', function (data) {
        dataSpy()
        expect(data).to.be.instanceof(Buffer)
        expect(data.toString()).to.equal('DOOONE!')
      })
    })

    req.end()
  })

  // https://github.com/nock/nock/issues/3047
  it('should match the body of GET requests', async () => {
    const body = JSON.stringify({ foo: 'bar' })
    const scope = nock('http://example.test')
      .get('/search', { foo: 'bar' })
      .reply(200, 'matched')

    const req = new http.ClientRequest({
      host: 'example.test',
      path: '/search',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    })
    // Write the body in two chunks to make sure all of it is captured.
    req.write(Buffer.from(body.slice(0, 5)))
    setTimeout(() => req.end(body.slice(5)), 10)

    const [res] = await once(req, 'response')
    expect(res.statusCode).to.equal(200)
    res.setEncoding('utf8')
    let data = ''
    for await (const chunk of res) {
      data += chunk
    }
    expect(data).to.equal('matched')
    scope.done()
  })

  it('should execute optional callback', done => {
    const scope = nock('http://example.test').get('/').reply(201)

    const reqOpts = {
      host: 'example.test',
      path: '/',
      method: 'GET',
    }
    const req = new http.ClientRequest(reqOpts, res => {
      expect(res.statusCode).to.equal(201)
      scope.done()
      done()
    })
    req.end()
  })

  it('should pass thru a live request when no interceptors and net connect is allowed', async () => {
    const { origin } = await startHttpServer((request, response) => {
      response.writeHead(201)
      response.end()
    })

    const req = new http.ClientRequest(origin)

    await new Promise(resolve => {
      req.on('response', res => {
        expect(res.statusCode).to.equal(201)
        resolve()
      })
      req.end()
    })
  })

  it('should emit an expected error when no interceptors and net connect is disallowed', done => {
    nock.disableNetConnect()
    const req = new http.ClientRequest({ port: 12345, path: '/' }).on(
      'error',
      err => {
        expect(err.message).to.equal(
          'Nock: Disallowed net connect for "localhost:12345/"',
        )
        done()
      },
    )
    req.end()
  })
})
