export default {
  async fetch(request) {
    const urlObj = new URL(request.url);
    const targetParam = urlObj.searchParams.get("url");
    const host = urlObj.searchParams.get("host");

    if (!targetParam) {
      return new Response("Missing 'url' parameter", { status: 400 });
    }

    try {
      const targetUrl = new URL(targetParam);

      const headers = new Headers(request.headers);

      // Override the upstream Host if one was provided
      if (host) {
        headers.set("Host", host);
      }

      // Don't force JSON
      headers.delete("Accept-Encoding");

      const originResponse = await fetch(targetUrl.toString(), {
        method: request.method,
        headers,
        body:
          request.method !== "GET" && request.method !== "HEAD"
            ? request.body
            : undefined,
      });

      // Forward the upstream response headers as-is
      const responseHeaders = new Headers(originResponse.headers);

      return new Response(
        request.method === "HEAD" ? null : originResponse.body,
        {
          status: originResponse.status,
          statusText: originResponse.statusText,
          headers: responseHeaders,
        }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
  },
};
