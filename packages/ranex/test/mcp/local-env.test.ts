import { describe, expect, test } from "bun:test"
import { localServerEnv, remoteURL } from "@/mcp"

const parent = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/tester",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm-256color",
  SHELL: "/bin/bash",
  http_proxy: "http://proxy.local:7890",
  HTTPS_PROXY: "http://proxy.local:7890",
  no_proxy: "localhost",
  SSL_CERT_FILE: "/etc/ssl/certs.pem",
  SSL_CERT_DIR: "/etc/ssl/certs",
  XDG_CONFIG_HOME: "/home/tester/.config",
  XDG_DATA_HOME: "/home/tester/.local/share",
  XDG_CACHE_HOME: "/home/tester/.cache",
  OPENAI_API_KEY: "sk-test-planted-secret",
  ANTHROPIC_AUTH_TOKEN: "sk-ant-planted-secret",
  GITHUB_TOKEN: "ghp_plantedsecret",
  AWS_SECRET_ACCESS_KEY: "planted-aws-secret",
}

describe("mcp localServerEnv", () => {
  test("passes only allowlisted parent vars plus configured environment by default", () => {
    const env = localServerEnv(parent, { environment: { MCP_CUSTOM: "1" } })
    expect(env).toEqual({
      PATH: parent.PATH,
      HOME: parent.HOME,
      TMPDIR: parent.TMPDIR,
      LANG: parent.LANG,
      LC_ALL: parent.LC_ALL,
      TERM: parent.TERM,
      SHELL: parent.SHELL,
      http_proxy: parent.http_proxy,
      HTTPS_PROXY: parent.HTTPS_PROXY,
      no_proxy: parent.no_proxy,
      SSL_CERT_FILE: parent.SSL_CERT_FILE,
      SSL_CERT_DIR: parent.SSL_CERT_DIR,
      XDG_CONFIG_HOME: parent.XDG_CONFIG_HOME,
      XDG_DATA_HOME: parent.XDG_DATA_HOME,
      XDG_CACHE_HOME: parent.XDG_CACHE_HOME,
      MCP_CUSTOM: "1",
    })
  })

  test("drops provider credentials planted in the parent environment", () => {
    const env = localServerEnv(parent, {})
    expect(env).not.toHaveProperty("OPENAI_API_KEY")
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN")
    expect(env).not.toHaveProperty("GITHUB_TOKEN")
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")
  })

  test("config environment always wins over inherited values", () => {
    const env = localServerEnv(parent, { environment: { HOME: "/srv/mcp", MCP_CUSTOM: "1" } })
    expect(env.HOME).toBe("/srv/mcp")
    expect(env.MCP_CUSTOM).toBe("1")
  })

  test("inheritEnv passes the full parent environment for trusted servers", () => {
    const env = localServerEnv(parent, { inheritEnv: true })
    expect(env.OPENAI_API_KEY).toBe("sk-test-planted-secret")
    expect(env.GITHUB_TOKEN).toBe("ghp_plantedsecret")
    expect(env).not.toHaveProperty("MCP_CUSTOM")
  })
})

describe("mcp remoteURL", () => {
  test("accepts http and https URLs", () => {
    expect(remoteURL("https://mcp.example.com/sse")?.protocol).toBe("https:")
    expect(remoteURL("http://mcp.example.com")?.protocol).toBe("http:")
  })

  test("rejects non-http schemes", () => {
    expect(remoteURL("file:///etc/passwd")).toBeUndefined()
    expect(remoteURL("ftp://mcp.example.com")).toBeUndefined()
  })
})
