import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { apply, internals } from '../index.js'

const {
  HEADER_EVENT,
  headerListener,
  matchesProvider,
  matchesUrl,
  normalizeConfig,
  sessionValue,
} = internals

/**
 * A miniature Cordis event bus that reproduces `waterfall` exactly: the first
 * argument may be a receiver, the next is the event name, the last is the
 * innermost `next`, and a listener that skips `next()` vetoes the rest.
 */
function createBus() {
  const hooks = new Map()
  return {
    on(nameOrArg, maybeName, maybeCallback) {
      const name = typeof maybeName === 'string' ? maybeName : nameOrArg
      const callback = typeof maybeName === 'function' ? maybeName : maybeCallback
      const list = hooks.get(name) ?? []
      list.push(callback)
      hooks.set(name, list)
      return () => {
        const index = list.indexOf(callback)
        if (index >= 0) list.splice(index, 1)
        return true
      }
    },
    waterfall(name, ...rest) {
      const inner = rest.pop()
      const args = rest
      const callbacks = [...(hooks.get(name) ?? [])]
      const dispatch = () => {
        const callback = callbacks.shift()
        if (callback === undefined) return inner()
        let called = false
        const next = () => {
          if (called) throw new Error('next() called multiple times')
          called = true
          return dispatch()
        }
        return callback(...args, next)
      }
      return dispatch()
    },
    count(name) {
      return (hooks.get(name) ?? []).length
    },
  }
}

/** The adapter's real call shape: profile headers first, ours in the middle. */
function dispatchHeaders(bus, request, initial = new Headers()) {
  return bus.waterfall(HEADER_EVENT, request, initial, () => initial)
}

describe('header injection through the pi-ai waterfall', () => {
  it('adds the header for a route rebuilt from the protocol table', () => {
    const bus = createBus()
    bus.on(HEADER_EVENT, headerListener(normalizeConfig({}), 'dsh-fallback'))
    const request = {
      provider: 'opencode-free',
      model: 'hy4-flash-free',
      baseURL: 'https://opencode.ai/inference/go/openai/v1/',
      sessionId: 'session-abc',
    }
    const headers = dispatchHeaders(bus, request)
    assert.equal(headers.get('x-opencode-session'), 'session-abc')
  })

  it('matches by endpoint even when the route is named something else', () => {
    const bus = createBus()
    bus.on(HEADER_EVENT, headerListener(normalizeConfig({}), 'dsh-fallback'))
    const headers = dispatchHeaders(bus, {
      provider: 'my-gateway',
      baseURL: 'https://opencode.ai/zen/v1/',
    })
    assert.ok(headers.get('x-opencode-session').startsWith('dsh-'))
  })

  it('matches a catalog route without a configured endpoint by provider key', () => {
    const bus = createBus()
    bus.on(HEADER_EVENT, headerListener(normalizeConfig({}), 'dsh-fallback'))
    const headers = dispatchHeaders(bus, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
    assert.ok(headers.get('x-opencode-session').startsWith('dsh-'))
  })

  it('leaves unrelated providers and endpoints untouched', () => {
    const bus = createBus()
    bus.on(HEADER_EVENT, headerListener(normalizeConfig({}), 'dsh-fallback'))
    assert.equal(dispatchHeaders(bus, { provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1/' }).has('x-opencode-session'), false)
    assert.equal(dispatchHeaders(bus, { provider: 'local-vllm', baseURL: 'http://127.0.0.1:8000/v1/' }).has('x-opencode-session'), false)
  })

  it('never overwrites a value another contributor set', () => {
    const bus = createBus()
    bus.on(HEADER_EVENT, (request, headers, next) => {
      const out = next()
      out.set('x-opencode-session', 'from-another-plugin')
      return out
    })
    // Registered later, so it runs inside the other contributor and sees its value.
    bus.on(HEADER_EVENT, headerListener(normalizeConfig({}), 'dsh-fallback'))
    const headers = dispatchHeaders(bus, { provider: 'opencode-go', sessionId: 'session-abc' })
    assert.equal(headers.get('x-opencode-session'), 'from-another-plugin')
  })

  it('honours a fixed configured session and a custom header name', () => {
    const bus = createBus()
    const settings = normalizeConfig({ session: 'fixed-session', header: 'X-Custom-Route' })
    bus.on(HEADER_EVENT, headerListener(settings, 'dsh-fallback'))
    const headers = dispatchHeaders(bus, { provider: 'opencode-go', sessionId: 'ignored' })
    assert.equal(headers.get('x-custom-route'), 'fixed-session')
    assert.equal(headers.has('x-opencode-session'), false)
  })

  it('keeps profile headers that were already on the request', () => {
    const bus = createBus()
    bus.on(HEADER_EVENT, headerListener(normalizeConfig({}), 'dsh-fallback'))
    const initial = new Headers({ 'x-api-key': 'secret', 'x-opencode-session': 'preset' })
    const headers = dispatchHeaders(bus, { provider: 'opencode-go', sessionId: 'session-abc' }, initial)
    assert.equal(headers.get('x-opencode-session'), 'preset')
    assert.equal(headers.get('x-api-key'), 'secret')
  })

  it('sanitizes a session id the gateway would reject as a header value', () => {
    const settings = normalizeConfig({})
    assert.equal(sessionValue({ sessionId: 'a\r\nb c' }, settings, 'dsh-x'), 'ab c')
    assert.equal(sessionValue({ sessionId: '会话-1' }, settings, 'dsh-x'), '-1')
    assert.equal(sessionValue({}, settings, 'dsh-x'), 'dsh-x')
  })
})

describe('matching rules', () => {
  it('matches host suffixes and explicit ports but not lookalikes', () => {
    const settings = normalizeConfig({})
    assert.equal(matchesUrl('https://opencode.ai/zen/v1', settings), true)
    assert.equal(matchesUrl('https://api.opencode.ai/v1', settings), true)
    assert.equal(matchesUrl('https://notopencode.ai/v1', settings), false)
    assert.equal(matchesUrl('https://opencode.ai.evil.test/v1', settings), false)
    assert.equal(matchesUrl('not a url', settings), false)
    assert.equal(matchesUrl('http://127.0.0.1:8080/v1', normalizeConfig({ hosts: ['127.0.0.1:8080'] })), true)
  })

  it('matches provider keys by exact name, dash suffix, and wildcard', () => {
    const settings = normalizeConfig({})
    assert.equal(matchesProvider('opencode', settings), true)
    assert.equal(matchesProvider('opencode-go', settings), true)
    assert.equal(matchesProvider('opencode-free', settings), true)
    assert.equal(matchesProvider('opencodex', settings), false)
    assert.equal(matchesProvider('zen-opencode', settings), false)
    assert.equal(matchesProvider('zen-opencode', normalizeConfig({ providers: ['zen-*'] })), true)
  })

  it('treats an explicit empty host list as provider-only matching', () => {
    const settings = normalizeConfig({ hosts: [] })
    assert.equal(settings.hosts.length, 0)
    assert.equal(matchesUrl('https://opencode.ai/zen/v1', settings), false)
    assert.equal(matchesProvider('opencode-go', settings), true)
  })
})

describe('plugin activation', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      return new Response(JSON.stringify({ url: String(input), session: headers.get('x-opencode-session') }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    delete globalThis[Symbol.for('dsh-plugin-opencode-session/fetch-guard')]
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    delete globalThis[Symbol.for('dsh-plugin-opencode-session/fetch-guard')]
  })

  it('registers on the adapter event and covers gateway traffic outside it', async () => {
    const bus = createBus()
    const cleanups = []
    const ctx = {
      on: (name, callback) => {
        const dispose = bus.on(name, callback)
        cleanups.push(dispose)
        return dispose
      },
      effect: factory => {
        const dispose = factory()
        cleanups.push(dispose)
        return dispose
      },
    }

    // The guard replaces fetch; cleanup must put back exactly this value.
    const beforeInstall = globalThis.fetch

    apply(ctx, {})
    assert.equal(bus.count(HEADER_EVENT), 1)

    // In-adapter path: the waterfall adds the session identity.
    const headers = dispatchHeaders(bus, { provider: 'opencode-go', sessionId: 'session-xyz' })
    assert.equal(headers.get('x-opencode-session'), 'session-xyz')

    // Out-of-adapter path: the fetch guard adds a stable per-process value.
    const response = await globalThis.fetch('https://opencode.ai/inference/go/openai/v1/models', {
      headers: { authorization: 'Bearer key' },
    })
    const body = await response.json()
    assert.ok(body.session.startsWith('dsh-'))
    assert.match(body.url, /opencode\.ai/)

    const other = await (await globalThis.fetch('https://api.deepseek.com/v1/models')).json()
    assert.equal(other.session, null)

    for (const cleanup of cleanups) cleanup()
    assert.equal(bus.count(HEADER_EVENT), 0)
    assert.equal(globalThis.fetch, beforeInstall)
  })

  it('leaves fetch alone when the guard is disabled', () => {
    const bus = createBus()
    const patched = globalThis.fetch
    apply({ on: bus.on, effect: () => {} }, { patchFetch: false })
    assert.equal(globalThis.fetch, patched)
  })
})
