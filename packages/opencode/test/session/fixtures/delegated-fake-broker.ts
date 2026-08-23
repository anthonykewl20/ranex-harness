const fingerprint = "115c60229299f4769d01e88f4c4c758a0be6a9bbfd6090bb6ace9c2562f27ca2"
const capability = Buffer.alloc(32, 7).toString("base64url")
const session = "synthetic-session"

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
    const url = new URL(request.url)
    if (url.pathname === "/handshake")
      return Response.json({ protocolFingerprint: fingerprint, capability, session })
    if (url.pathname === "/chat")
      return new Response('data: {"type":"text-delta","text":"ok"}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      })
    return new Response("not found", { status: 404 })
  },
})

process.stdout.write(`${JSON.stringify({ endpoint: server.url.origin, protocolFingerprint: fingerprint })}\n`)

process.on("SIGTERM", () => server.stop())
