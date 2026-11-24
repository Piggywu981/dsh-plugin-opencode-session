/**
 * dsh-plugin-opencode-session
 *
 * Restores the `x-opencode-session` routing header that the OpenCode gateway
 * requires on every request it serves. Without it the gateway answers
 *
 *   400 {"type":"MissingSessionID","message":"Request is missing
 *   x-opencode-session and cannot be routed efficiently."}
 *
 * and the DSH turn fails before any token is produced.
 *
 * Why DSH loses the header: pi-ai ships OpenCode providers whose streams are
 * wrapped in `withOpenCodeSessionHeader`, but that wrapper only survives while
 * a route keeps its catalog provider. A route that names `api` explicitly is
 * rebuilt from the protocol table (`openai-completions`, `anthropic-messages`,
 * `openai-responses`, `google-generative-ai`) and loses the wrapper, and any
 * request dispatched without a `sessionId` skips the header as well. Hand-made
 * routes such as `opencode-free: { api: openai-completions, baseURL:
 * https://opencode.ai/inference/go/openai/v1/ }` are exactly that case.
 *
 * The plugin installs a listener on the `llm-pi-ai/request-headers` waterfall,
 * which the pi-ai adapter runs for every inference request after the profile
 * headers and before Harness attribution, so the header reaches the wire
 * whatever route shape produced the request. An optional `fetch` guard covers
 * the requests that never pass through that adapter (model discovery probes,
 * sign-in flows, anything else that talks to the gateway directly).
 *
 * @module dsh-plugin-opencode-session
 */

import { randomUUID } from 'node:crypto'

/** Header the gateway requires. */
const DEFAULT_HEADER = 'x-opencode-session'
/** Host names treated as the OpenCode gateway unless configuration says otherwise. */
const DEFAULT_HOSTS = ['opencode.ai']
/** Provider route prefixes treated as OpenCode routes unless configuration says otherwise. */
const DEFAULT_PROVIDERS = ['opencode']
/** Marks the patched `fetch` so a reload cannot wrap it twice. */
const FETCH_STATE = Symbol.for('dsh-plugin-opencode-session/fetch-guard')
/** Gateway event the pi-ai adapter waterfalls request headers through. */
const HEADER_EVENT = 'llm-pi-ai/request-headers'

/** Cordis plugin name shown by the loader. */
export const name = 'opencode-session'

/**
 * Read one string-or-array option, keeping order and dropping empties.
 * @param {unknown} value - raw configuration value.
 * @param {readonly string[]} fallback - value used when the option is absent.
 * @returns {string[]} the normalized list; an explicit empty list stays empty.
 */
function toList(value, fallback) {
  if (value === undefined || value === null) return [...fallback]
  if (typeof value === 'string') {
    const parts = value.split(',').map(part => part.trim()).filter(Boolean)
    return parts
  }
  if (Array.isArray(value)) return value.map(entry => String(entry).trim()).filter(Boolean)
  return [...fallback]
}

/**
 * Resolve the plugin configuration, filling every default.
 * @param {object} [config] - the loader row's `config` object.
 * @returns {{header: string, hosts: string[], providers: string[], session: string, sessionPrefix: string, patchFetch: boolean, debug: boolean}} resolved settings.
 */
export function normalizeConfig(config = {}) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const header = String(source.header ?? DEFAULT_HEADER).trim() || DEFAULT_HEADER
  return {
    header,
    hosts: toList(source.hosts, DEFAULT_HOSTS),
    providers: toList(source.providers, DEFAULT_PROVIDERS),
    session: typeof source.session === 'string' ? source.session.trim() : '',
    sessionPrefix: String(source.sessionPrefix ?? 'dsh').trim() || 'dsh',
    patchFetch: source.patchFetch !== false,
    debug: source.debug === true,
  }
}

/**
 * Whether a URL points at a configured gateway host.
 * @param {string | undefined} url - absolute request URL.
 * @param {ReturnType<typeof normalizeConfig>} settings - resolved settings.
 * @returns {boolean} true when the host (or `host:port`) matches an entry.
 */
export function matchesUrl(url, settings) {
  if (typeof url !== 'string' || url === '') return false
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const hostname = parsed.hostname.toLowerCase()
  const host = parsed.host.toLowerCase()
  for (const entry of settings.hosts) {
    const rule = entry.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    const bare = rule.startsWith('*.') ? rule.slice(2) : rule
    if (host === rule || hostname === bare) return true
    if (hostname.endsWith(`.${bare}`)) return true
  }
  return false
}

/**
 * Whether a provider route key belongs to the OpenCode family.
 * An entry matches the exact key, any `entry-*` key, or a `prefix*` pattern.
 * @param {string | undefined} provider - the adapter's route key.
 * @param {ReturnType<typeof normalizeConfig>} settings - resolved settings.
 * @returns {boolean} true when the route matches an entry.
 */
export function matchesProvider(provider, settings) {
  if (typeof provider !== 'string' || provider === '') return false
  const key = provider.toLowerCase()
  for (const entry of settings.providers) {
    const rule = entry.toLowerCase()
    if (rule.endsWith('*')) {
      if (key.startsWith(rule.slice(0, -1))) return true
      continue
    }
    if (key === rule || key.startsWith(`${rule}-`)) return true
  }
  return false
}

/**
 * Whether one request needs the routing header.
 * A route key match is enough even without a known endpoint, because a catalog
 * route may keep pi-ai's own base URL; a matching endpoint is enough even for
 * a route named something else.
 * @param {{provider?: string, baseURL?: string}} request - the adapter's header context.
 * @param {ReturnType<typeof normalizeConfig>} settings - resolved settings.
 * @returns {boolean} true when the header belongs on this request.
 */
export function shouldInject(request, settings) {
  if (matchesProvider(request?.provider, settings)) return true
  return matchesUrl(request?.baseURL, settings)
}

/**
 * Pick the value carried by the routing header.
 * @param {{sessionId?: unknown}} request - the adapter's header context.
 * @param {ReturnType<typeof normalizeConfig>} settings - resolved settings.
 * @param {string} fallback - stable per-instance identifier.
 * @returns {string} a header-safe value, never empty.
 */
export function sessionValue(request, settings, fallback) {
  const candidates = [settings.session, request?.sessionId, fallback]
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue
    const text = String(candidate).replace(/[^\t\x20-\x7e]/g, '').trim()
    if (text !== '') return text
  }
  return settings.sessionPrefix
}

/**
 * Header value a request that carries no session identity can still use.
 * One value per plugin instance keeps gateway affinity stable for the process.
 * @param {ReturnType<typeof normalizeConfig>} settings - resolved settings.
 * @returns {string} the instance session identifier.
 */
function createFallbackSession(settings) {
  const suffix = typeof randomUUID === 'function' ? randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${settings.sessionPrefix}-${suffix}`
}

/**
 * Build the `llm-pi-ai/request-headers` listener.
 * The waterfall runs outermost-first; calling `next()` lets the built-in
 * behavior and every other contributor answer first, then this listener adds
 * the routing header to the headers that will actually be sent.
 * @param {ReturnType<typeof normalizeConfig>} settings - resolved settings.
 * @param {string} fallbackSession - stable per-instance identifier.
 * @param {{debug?: (message: string) => void}} [log] - optional debug sink.
 * @returns {(request: object, headers: Headers, next: () => Headers) => Headers} the listener.
 */
export function headerListener(settings, fallbackSession, log) {
  return function opencodeSessionHeader(request, headers, next) {
    const result = typeof next === 'function' ? next() : headers
    const target = result !== null && typeof result === 'object' && typeof result.set === 'function' ? result : headers
    if (target === null || typeof target !== 'object' || typeof target.set !== 'function') return result
    if (!shouldInject(request, settings)) return target
    if (typeof target.has === 'function' && target.has(settings.header)) return target
    const value = sessionValue(request, settings, fallbackSession)
    target.set(settings.header, value)
    log?.debug?.(`added ${settings.header} for provider "${request?.provider ?? '?'}"`)
    return target
  }
}

/**
 * Install the `fetch` guard that covers gateway traffic outside the pi-ai
 * adapter. Registrations stack, so several plugin rows with different hosts
 * coexist; the last registration wins for a URL they both match.
 * @param {{settings: ReturnType<typeof normalizeConfig>, fallbackSession: string}} registration - one plugin instance.
 * @returns {() => void} cleanup restoring the original `fetch` on the last release.
 */
function installFetchGuard(registration) {
  if (typeof globalThis.fetch !== 'function' || typeof Headers !== 'function') return () => {}
  let state = globalThis[FETCH_STATE]
  if (state === undefined) {
    const original = globalThis.fetch
    const patched = function patchedFetch(input, init) {
      const current = globalThis[FETCH_STATE]
      if (current === undefined) return original.call(this, input, init)
      let url
      try {
        url = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : typeof input?.url === 'string' ? input.url : undefined
      } catch {
        url = undefined
      }
      if (typeof url !== 'string') return original.call(this, input, init)
      for (let index = current.registrations.length - 1; index >= 0; index -= 1) {
        const { settings, fallbackSession } = current.registrations[index]
        if (!matchesUrl(url, settings)) continue
        const incoming = init?.headers ?? (typeof input?.headers === 'object' && input.headers !== null ? input.headers : undefined)
        const headers = new Headers(incoming)
        if (headers.has(settings.header)) return original.call(this, input, init)
        headers.set(settings.header, fallbackSession)
        return original.call(this, input, { ...(init ?? {}), headers })
      }
      return original.call(this, input, init)
    }
    state = { original, patched, registrations: [registration] }
    globalThis[FETCH_STATE] = state
    globalThis.fetch = patched
  } else {
    state.registrations.push(registration)
  }
  return () => {
    const current = globalThis[FETCH_STATE]
    if (current === undefined) return
    const index = current.registrations.indexOf(registration)
    if (index >= 0) current.registrations.splice(index, 1)
    if (current.registrations.length > 0) return
    if (globalThis.fetch === current.patched) globalThis.fetch = current.original
    delete globalThis[FETCH_STATE]
  }
}

/** Resolve a namespaced debug sink from the plugin context, tolerating a bare logger. */
function debugSink(ctx, enabled) {
  if (!enabled) return undefined
  try {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('opencode-session') : ctx?.logger
    if (logger !== undefined && logger !== null && typeof logger.debug === 'function') {
      return { debug: message => logger.debug(message) }
    }
  } catch {
    // A logger shape this build does not expose must not fail activation.
  }
  return undefined
}

/**
 * Activate the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} [config] - the loader row's `config`.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const fallbackSession = createFallbackSession(settings)
  const log = debugSink(ctx, settings.debug)

  ctx.on(HEADER_EVENT, headerListener(settings, fallbackSession, log))

  if (!settings.patchFetch) return
  const release = installFetchGuard({ settings, fallbackSession })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => release)
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', release)
  }
}

/** Pure helpers exposed for tests and for tools that want the same decisions. */
export const internals = Object.freeze({
  HEADER_EVENT,
  DEFAULT_HEADER,
  normalizeConfig,
  matchesUrl,
  matchesProvider,
  shouldInject,
  sessionValue,
  headerListener,
  createFallbackSession,
  installFetchGuard,
})
