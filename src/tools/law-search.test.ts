/**
 * fin_law_search 기준일 검색 회귀 테스트 (fixture 기반 — CI 상시)
 *
 * 핵심 계약: 기준일 검색은 eflaw + efYd **범위** 문법으로만 동작한다.
 * 단일 efYd는 법제처가 조용히 무시하고 현행 결과를 주므로, 헤더에는 기준일이
 * 찍히는데 내용은 현행인 "조용한 거짓"이 된다 (실측 2026-08-25).
 */

import { describe, it, expect } from "vitest"
import { handleFinLawSearch } from "./law-search.js"
import type { LawApiClient } from "../lib/api-client.js"

const MULTI_VERSION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LawSearch><totalCnt>4</totalCnt>
  <law id="1"><법령명한글>법인세법</법령명한글><법령일련번호>212775</법령일련번호><법령ID>1</법령ID>
    <법령구분명>법률</법령구분명><소관부처명>기획재정부</소관부처명><소관부처코드>1051000</소관부처코드>
    <시행일자>20200101</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>연혁</현행연혁코드></law>
  <law id="2"><법령명한글>법인세법</법령명한글><법령일련번호>165308</법령일련번호><법령ID>1</법령ID>
    <법령구분명>법률</법령구분명><소관부처명>기획재정부</소관부처명><소관부처코드>1051000</소관부처코드>
    <시행일자>20150701</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>연혁</현행연혁코드></law>
  <law id="3"><법령명한글>법인세법</법령명한글><법령일련번호>140000</법령일련번호><법령ID>1</법령ID>
    <법령구분명>법률</법령구분명><소관부처명>기획재정부</소관부처명><소관부처코드>1051000</소관부처코드>
    <시행일자>20120101</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>연혁</현행연혁코드></law>
  <law id="4"><법령명한글>법인세법 시행령</법령명한글><법령일련번호>172604</법령일련번호><법령ID>2</법령ID>
    <법령구분명>대통령령</법령구분명><소관부처명>기획재정부</소관부처명><소관부처코드>1051000</소관부처코드>
    <시행일자>20150701</시행일자><제개정구분명>일부개정</제개정구분명><현행연혁코드>연혁</현행연혁코드></law>
</LawSearch>`

function stub(xml: string, capture?: (p: Record<string, string>) => void): LawApiClient {
  return {
    fetchApi: async (p: { extraParams?: Record<string, string> }) => {
      capture?.(p.extraParams ?? {})
      return xml
    },
    searchLaw: async () => xml,
  } as unknown as LawApiClient
}

describe("fin_law_search — 기준일 검색", () => {
  it("범위 문법(from~to)으로 조회한다 — 단일 efYd는 법제처가 무시하므로", async () => {
    let seen: Record<string, string> = {}
    await handleFinLawSearch(stub(MULTI_VERSION_XML, (p) => (seen = p)), {
      query: "법인세법",
      basis_date: "2015-07-01",
    })
    expect(seen.efYd).toBe("19000101~20150701")
  })

  it("법령별로 기준일 시점 1건만 남긴다 (여러 개정본 나열 금지)", async () => {
    const r = await handleFinLawSearch(stub(MULTI_VERSION_XML), { query: "법인세법", basis_date: "2015-07-01" })
    const text = r.content[0].text
    // 20150701본은 남고, 기준일 이후인 20200101본은 빠진다
    expect(text).toContain("165308")
    expect(text).not.toContain("212775")
    // 기준일 이전 구본(20120101)도 최신 하나로 접힌다
    expect(text).not.toContain("140000")
  })

  it("헤더에 기준일을 명시한다", async () => {
    const r = await handleFinLawSearch(stub(MULTI_VERSION_XML), { query: "법인세법", basis_date: "2015-07-01" })
    expect(r.content[0].text).toContain("[기준일: 2015-07-01 시행 기준]")
  })

  it("기준일 모드에서는 연혁 경고를 붙이지 않는다 (과거본이 정상 결과)", async () => {
    const r = await handleFinLawSearch(stub(MULTI_VERSION_XML), { query: "법인세법", basis_date: "2015-07-01" })
    expect(r.content[0].text).not.toContain("⚠연혁")
  })

  it("기준일 이전 시행본이 없으면 사유를 붙여 0건으로 보고한다", async () => {
    const r = await handleFinLawSearch(stub(MULTI_VERSION_XML), { query: "법인세법", basis_date: "1900-01-01" })
    const text = r.content[0].text
    expect(text).toContain("[LAW_NOT_FOUND]")
    expect(text).toContain("시행 중이던 법령 없음")
  })

  it("기준일이 없으면 현행 검색 경로를 쓴다 (회귀 없음)", async () => {
    let called = false
    const client = {
      fetchApi: async () => {
        called = true
        return MULTI_VERSION_XML
      },
      searchLaw: async () => MULTI_VERSION_XML,
    } as unknown as LawApiClient
    const r = await handleFinLawSearch(client, { query: "법인세법" })
    expect(called).toBe(false) // 범위 검색 경로를 타지 않는다
    expect(r.content[0].text).toContain("[기준: 현행]")
  })

  it("잘못된 기준일 형식은 INVALID_PARAMETER", async () => {
    const r = await handleFinLawSearch(stub(MULTI_VERSION_XML), { query: "법인세법", basis_date: "2015/07/01" })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("INVALID_PARAMETER")
  })
})
