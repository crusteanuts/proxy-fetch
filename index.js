export default {
  async fetch(request) {
    const urlObj = new URL(request.url);
    const targetParam = urlObj.searchParams.get("url");
    const host = urlObj.searchParams.get("host");

    /*
     * ------------------------------------------------------------
     * Build the headers exactly as the existing worker does.
     * ------------------------------------------------------------
     */
    const buildHeaders = () => {
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

      return headers;
    };

    /*
     * ------------------------------------------------------------
     * Single URL fetch
     *
     * This preserves the original behavior.
     * ------------------------------------------------------------
     */
    const fetchSingle = async (targetParam) => {
      if (!targetParam) {
        return {
          error: "Missing 'url' parameter",
        };
      }

      try {
        const targetUrl = new URL(targetParam);
        const headers = buildHeaders();

        const originResponse = await fetch(
          targetUrl.toString(),
          {
            method: request.method,
            headers,
            body:
              request.method !== "GET" &&
              request.method !== "HEAD"
                ? request.body
                : undefined,
          }
        );

        return {
          url: targetUrl.toString(),
          status: originResponse.status,
          statusText: originResponse.statusText,
        };
      } catch (err) {
        return {
          url: targetParam,
          error:
            err instanceof Error
              ? err.message
              : String(err),
        };
      }
    };

    /*
     * ------------------------------------------------------------
     * Batch mode
     *
     * POST JSON:
     *
     * {
     *   "urls": [
     *     "https://example.com/1",
     *     "https://example.com/2"
     *   ]
     * }
     *
     * If no valid "urls" array is supplied, we fall back to
     * the original single-URL behavior.
     * ------------------------------------------------------------
     */
    let batchUrls = null;

    if (request.method === "POST") {
      try {
        const contentType =
          request.headers.get("Content-Type") || "";

        if (
          contentType
            .toLowerCase()
            .includes("application/json")
        ) {
          const body = await request.json();

          if (Array.isArray(body?.urls)) {
            batchUrls = body.urls;
          }
        }
      } catch {
        /*
         * Invalid JSON simply falls through to the
         * original single-URL behavior.
         */
      }
    }

    /*
     * ------------------------------------------------------------
     * Batch request
     * ------------------------------------------------------------
     */
    if (Array.isArray(batchUrls)) {
      /*
       * Basic validation.
       *
       * Empty arrays are allowed and simply return an
       * empty result array.
       */
      if (
        batchUrls.some(
          (value) =>
            typeof value !== "string" ||
            value.length === 0
        )
      ) {
        return new Response(
          JSON.stringify({
            error:
              "'urls' must contain only non-empty strings",
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }

      /*
       * Process all URLs concurrently.
       *
       * Each URL gets its own result, so one failed URL
       * does not cause the entire batch to fail.
       */
      const results = await Promise.all(
        batchUrls.map(async (targetParam) => {
          try {
            const targetUrl =
              new URL(targetParam);

            const headers = buildHeaders();

            const originResponse =
              await fetch(
                targetUrl.toString(),
                {
                  method: request.method === "POST"
                    ? "HEAD"
                    : request.method,
                  headers,
                }
              );

            return {
              url: targetUrl.toString(),
              status: originResponse.status,
              statusText:
                originResponse.statusText,
            };
          } catch (err) {
            return {
              url: targetParam,
              error:
                err instanceof Error
                  ? err.message
                  : String(err),
            };
          }
        })
      );

      return new Response(
        JSON.stringify({
          count: results.length,
          results,
        }),
        {
          status: 200,
          headers: {
            "Content-Type":
              "application/json",
          },
        }
      );
    }

    /*
     * ------------------------------------------------------------
     * ORIGINAL SINGLE-URL FALLBACK
     *
     * If no batch was supplied, behavior remains the
     * original ?url=... behavior.
     * ------------------------------------------------------------
     */
    if (!targetParam) {
      return new Response(
        "Missing 'url' parameter",
        { status: 400 }
      );
    }

    try {
      const targetUrl =
        new URL(targetParam);

      const headers =
        buildHeaders();

      const originResponse =
        await fetch(
          targetUrl.toString(),
          {
            method:
              request.method,
            headers,
            body:
              request.method !== "GET" &&
              request.method !== "HEAD"
                ? request.body
                : undefined,
          }
        );

      const responseHeaders =
        new Headers(
          originResponse.headers
        );

      return new Response(
        request.method === "HEAD"
          ? null
          : originResponse.body,
        {
          status:
            originResponse.status,
          statusText:
            originResponse.statusText,
          headers:
            responseHeaders,
        }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({
          error:
            err instanceof Error
              ? err.message
              : String(err),
        }),
        {
          status: 500,
          headers: {
            "Content-Type":
              "application/json",
          },
        }
      );
    }
  },
};
