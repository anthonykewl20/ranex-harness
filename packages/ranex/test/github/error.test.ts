import { describe, expect, test } from "bun:test"
import { ApiError, toApiError } from "../../src/github/error"

describe("github.error.toApiError", () => {
  test("converts octokit-style error with status and message", () => {
    const result = toApiError({ status: 404, message: "Not Found" })

    expect(result).toBeInstanceOf(ApiError)
    expect(result.message).toBe("Not Found")
    expect(result.status).toBe(404)
  })

  test("converts error with message but no numeric status", () => {
    const result = toApiError({ status: "fail", message: "something broke" })

    expect(result).toBeInstanceOf(ApiError)
    expect(result.message).toBe("something broke")
    expect(result.status).toBeUndefined()
  })

  test("converts Error instance", () => {
    const result = toApiError(new Error("boom"))

    expect(result).toBeInstanceOf(ApiError)
    expect(result.message).toBe("boom")
    expect(result.status).toBeUndefined()
  })

  test("converts string", () => {
    const result = toApiError("plain string error")

    expect(result).toBeInstanceOf(ApiError)
    expect(result.message).toBe("plain string error")
    expect(result.status).toBeUndefined()
  })

  test("converts null and undefined to stringified messages", () => {
    const nullResult = toApiError(null)
    const undefinedResult = toApiError(undefined)

    expect(nullResult).toBeInstanceOf(ApiError)
    expect(nullResult.message).toBe("null")
    expect(nullResult.status).toBeUndefined()
    expect(undefinedResult).toBeInstanceOf(ApiError)
    expect(undefinedResult.message).toBe("undefined")
    expect(undefinedResult.status).toBeUndefined()
  })
})
