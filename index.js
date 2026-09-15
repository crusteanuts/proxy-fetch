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

      // Only forward headers that are actually needed.
      const headers = new Headers();

      for (const name of [
        "Accept",
        "Accept-Language",
        "Content-Type",
        "User-Agent",
      ]) {
        const value = request.headers.get(name);

        if (value) {
          headers.set(name, value);
        }
      }

      if (host) {
        headers.set("Host", host);
      }

      headers.delete("Accept-Encoding");

      const originResponse = await fetch(targetUrl.toString(), {
        method: request.method,
        headers,
        body:
          request.method !== "GET" && request.method !== "HEAD"
            ? request.body
            : undefined,
      });

      const responseHeaders = new Headers(originResponse.headers);

      return new Response(
        request.method === "HEAD"
          ? null
          : originResponse.body,
        {
          status: originResponse.status,
          statusText: originResponse.statusText,
          headers: responseHeaders,
        }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: err instanceof Error
            ? err.message
            : String(err),
        }),
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
