/**
 * 요청별 컨텍스트 (AsyncLocalStorage 기반 - stateless 모드)
 *
 * HTTP stateless 전환 후: 세션 Map 없음. 매 요청마다 ALS에 API 키를 주입하고
 * api-client가 getStore()로 조회. 요청 끝나면 자동 소멸.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import type { RequestExecutionBudget } from "./execution-limits.js"

export interface RequestContext {
  apiKey?: string
  /** HTTP disconnect signal, optionally combined with one MCP item's cancellation signal. */
  signal?: AbortSignal
  /** Shared by all tools in one outer HTTP request (including a JSON-RPC batch). */
  budget?: RequestExecutionBudget
}

export const requestContext = new AsyncLocalStorage<RequestContext>()

/** A consistent cancellation error that callers can recognise without leaking transport details. */
export function requestCancelledError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error(reason ? `Request cancelled: ${String(reason)}` : "Request cancelled.")
  error.name = "AbortError"
  return error
}

/**
 * Combine signals without making a cancelled MCP item poison its sibling
 * batch items.  The caller supplies only its own item signal; the shared
 * request context contains the connection-level signal.
 */
export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(active)
  }

  const controller = new AbortController()
  const abort = (signal: AbortSignal) => controller.abort(signal.reason)
  for (const signal of active) {
    if (signal.aborted) {
      abort(signal)
      break
    }
    signal.addEventListener("abort", () => abort(signal), { once: true })
  }
  return controller.signal
}

/** Run work with the current request values retained and an additional item-scoped signal. */
export function runWithRequestContext<T>(
  values: Partial<RequestContext>,
  work: () => T,
): T {
  const current = requestContext.getStore()
  const signal = combineAbortSignals(current?.signal, values.signal)
  return requestContext.run({ ...current, ...values, signal }, work)
}

export function getRequestSignal(): AbortSignal | undefined {
  return requestContext.getStore()?.signal
}

export function throwIfRequestCancelled(): void {
  const signal = getRequestSignal()
  if (signal?.aborted) throw requestCancelledError(signal.reason)
}
