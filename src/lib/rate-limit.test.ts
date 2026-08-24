/**
 * 세마포어(동시 실행 상한) 회귀 테스트 (순수 함수 — CI 상시)
 * Opus 리뷰 I3: fin_article의 병렬 fan-out이 DRF에 무제한 동시 버스트를
 * 만들지 않도록 상한(기본 4)을 박제한다.
 */

import { describe, it, expect } from "vitest"
import { createSemaphore } from "./rate-limit.js"

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe("createSemaphore", () => {
  it("동시 실행이 상한을 넘지 않는다", async () => {
    const sem = createSemaphore(2)
    let peak = 0
    const job = async () => {
      const release = await sem.acquire()
      peak = Math.max(peak, sem.active())
      await tick()
      release()
    }
    await Promise.all([job(), job(), job(), job(), job()])
    expect(peak).toBe(2)
    expect(sem.active()).toBe(0)
  })

  it("해제 순서대로 대기자가 깨어난다 (기아 없음)", async () => {
    const sem = createSemaphore(1)
    const order: number[] = []
    const job = async (n: number) => {
      const release = await sem.acquire()
      order.push(n)
      await tick()
      release()
    }
    await Promise.all([job(1), job(2), job(3)])
    expect(order).toEqual([1, 2, 3])
  })

  it("release를 두 번 호출해도 카운트가 깨지지 않는다", async () => {
    const sem = createSemaphore(1)
    const release = await sem.acquire()
    release()
    release() // 중복 해제 무시
    expect(sem.active()).toBe(0)
    const r2 = await sem.acquire()
    expect(sem.active()).toBe(1)
    r2()
  })
})
