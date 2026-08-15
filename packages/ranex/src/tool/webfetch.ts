import { SecureHttp } from "@ranex/core/util/secure-http"
import { Context, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes
const MAX_REDIRECTS = 5

export type Lookup = SecureHttp.Lookup

// Injectable resolver seam: production falls back to node:dns when no layer provides a
// fake, so tests can stub resolution without touching the network.
export class DnsLookup extends Context.Service<DnsLookup, { readonly lookup: Lookup }>()(
  "@ranex/webfetch/DnsLookup",
) {}

// Injectable transport seam: production always pins DNS validation into the connection
// by building the node client from the resolver above; tests may provide a fake client
// to serve canned responses without networking.
export class HttpTransport extends Context.Service<HttpTransport, { readonly client: HttpClient.HttpClient }>()(
  "@ranex/webfetch/HttpTransport",
) {}

export const assertPublicHttpUrlResolved = SecureHttp.assertPublicHttpUrlResolved

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
})

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const dns = yield* Effect.serviceOption(DnsLookup)
    const lookup = Option.isSome(dns) ? dns.value.lookup : SecureHttp.lookupDns
    const transport = yield* Effect.serviceOption(HttpTransport)
    const http = Option.isSome(transport) ? transport.value.client : SecureHttp.secureHttpClient(lookup)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => assertPublicHttpUrlResolved(params.url, lookup),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          })

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: [params.url],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
            },
          })

          const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

          // Build Accept header based on requested format with q parameters for fallbacks
          let acceptHeader = "*/*"
          switch (params.format) {
            case "markdown":
              acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
              break
            case "text":
              acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
              break
            case "html":
              acceptHeader =
                "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
              break
            default:
              acceptHeader =
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
          }
          const headers = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: acceptHeader,
            "Accept-Language": "en-US,en;q=0.9",
          }

          const request = (url: string, userAgent: string) =>
            HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({ ...headers, "User-Agent": userAgent }))

          // node never follows redirects on its own, so every hop is a fresh request whose
          // URL re-passes the SSRF guard and whose connection re-runs the pinned resolver
          const fetchHop = (url: string, userAgent: string) => http.execute(request(url, userAgent))

          const response = yield* Effect.gen(function* () {
            let current = params.url
            for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
              let hopResponse = yield* fetchHop(current, headers["User-Agent"])
              // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch)
              if (hopResponse.status === 403 && hopResponse.headers["cf-mitigated"] === "challenge") {
                hopResponse = yield* fetchHop(current, "opencode")
              }
              const location = hopResponse.headers["location"]
              if (![301, 302, 303, 307, 308].includes(hopResponse.status) || !location) {
                return yield* HttpClientResponse.filterStatusOk(hopResponse)
              }
              if (hop === MAX_REDIRECTS) throw new Error("Too many redirects")
              current = yield* Effect.tryPromise({
                try: () =>
                  assertPublicHttpUrlResolved(new URL(location, current).toString(), lookup).then((url) =>
                    url.toString(),
                  ),
                catch: (error) => (error instanceof Error ? error : new Error(String(error))),
              })
            }
            throw new Error("Too many redirects")
          }).pipe(
            Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }),
          )

          // Check content length
          const contentLength = response.headers["content-length"]
          if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const arrayBuffer = yield* response.arrayBuffer
          if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const contentType = response.headers["content-type"] || ""
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
          const title = `${params.url} (${contentType})`

          if (isImageAttachment(mime)) {
            const base64Content = Buffer.from(arrayBuffer).toString("base64")
            return {
              title,
              output: "Image fetched successfully",
              metadata: {},
              attachments: [
                {
                  type: "file" as const,
                  mime,
                  url: `data:${mime};base64,${base64Content}`,
                },
              ],
            }
          }

          const content = new TextDecoder().decode(arrayBuffer)

          // Handle content based on requested format and actual content type
          switch (params.format) {
            case "markdown":
              if (contentType.includes("text/html")) {
                const markdown = convertHTMLToMarkdown(content)
                return {
                  output: markdown,
                  title,
                  metadata: {},
                }
              }
              return { output: content, title, metadata: {} }

            case "text":
              if (contentType.includes("text/html")) {
                return { output: extractTextFromHTML(content), title, metadata: {} }
              }
              return { output: content, title, metadata: {} }

            case "html":
              return { output: content, title, metadata: {} }

            default:
              return { output: content, title, metadata: {} }
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
