export default {
  async fetch(request) {
    const urlObj = new URL(request.url);

    const targetParam = urlObj.searchParams.get("url");
    const requestedMethod =
      (urlObj.searchParams.get("method") || request.method).toUpperCase();

    if (!targetParam) {
      return new Response("Missing url parameter", {
        status: 400,
      });
    }

    let targetUrl;

    try {
      targetUrl = new URL(targetParam);
    } catch {
      return new Response("Invalid target URL", {
        status: 400,
      });
    }

    /*
     * ------------------------------------------------------------
     * IMPORTANT:
     *
     * Do NOT forward any headers from the client.
     *
     * The Worker creates a completely new outbound request.
     * This prevents browser cookies, client IP headers,
     * authorization, referer, origin, browser fingerprints, etc.
     * from being forwarded to the target.
     * ------------------------------------------------------------
     */
    const outboundHeaders = new Headers();

    outboundHeaders.set("Accept", "*/*");

    /*
     * Use a generic User-Agent rather than the caller's User-Agent.
     */
    outboundHeaders.set(
      "User-Agent",
      "Mozilla/5.0 (compatible; Cloudflare-Proxy/1.0)"
    );

    /*
     * Explicitly make sure no client identity headers exist.
     */
    for (const name of [
      "Cookie",
      "Authorization",
      "Referer",
      "Origin",
      "X-Forwarded-For",
      "X-Real-IP",
      "True-Client-IP",
      "CF-Connecting-IP",
      "CF-Connecting-IPv6",
      "CF-Worker",
      "Forwarded",
      "Via",
      "X-Client-IP",
      "X-Real-IP",
      "Client-IP",
      "X-Original-Forwarded-For",
      "X-Forwarded",
      "X-Forwarded-Host",
      "X-Forwarded-Proto",
      "X-Forwarded-Port",
    ]) {
      outboundHeaders.delete(name);
    }

    /*
     * ------------------------------------------------------------
     * Worker -> SmugMug
     *
     * The ?method=head parameter controls THIS request.
     * ------------------------------------------------------------
     */
    const method =
      requestedMethod === "HEAD"
        ? "HEAD"
        : requestedMethod === "GET"
          ? "GET"
          : requestedMethod;

    try {
      const originResponse = await fetch(
        targetUrl.toString(),
        {
          method,
          headers: outboundHeaders,
          redirect: "manual",
        }
      );

      /*
       * ----------------------------------------------------------
       * HEAD requests
       *
       * Return the actual origin response directly.
       *
       * This means:
       *
       * SmugMug 404 -> Worker 404
       * SmugMug 200 -> Worker 200
       * SmugMug 403 -> Worker 403
       * ----------------------------------------------------------
       */
      if (method === "HEAD") {
        return new Response(null, {
          status: originResponse.status,
          statusText: originResponse.statusText,
          headers: originResponse.headers,
        });
      }

      /*
       * ----------------------------------------------------------
       * GET requests
       *
       * Pass the origin response through unchanged.
       * ----------------------------------------------------------
       */
      return new Response(originResponse.body, {
        status: originResponse.status,
        statusText: originResponse.statusText,
        headers: originResponse.headers,
      });

    } catch (error) {
      /*
       * This is a genuine Worker-side fetch failure.
       */
      return new Response(
        JSON.stringify(
          {
            error: "worker-fetch-failed",
            message:
              error instanceof Error
                ? error.message
                : String(error),
            target: targetUrl.toString(),
            method,
          },
          null,
          2
        ),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
  },
};
