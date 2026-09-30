export default {
  async fetch(request) {
    const urlObj = new URL(request.url);
    const targetParam = urlObj.searchParams.get("url");
    const host = urlObj.searchParams.get("host");

    /*
     * ------------------------------------------------------------
     * Build the headers exactly as the existing worker does,
     * except that client identity / proxy headers are explicitly
     * removed.
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

      /*
       * Do NOT manually override Host.
       *
       * The target URL already determines the destination host.
       */

      /*
       * ----------------------------------------------------------
       * Never intentionally forward client identity / proxy
       * headers to the target.
       * ----------------------------------------------------------
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
      ]) {
        headers.delete(name);
      }

      /*
       * Let Cloudflare manage compression for the outbound
       * request rather than forwarding the client's value.
       */
      headers.delete("Accept-Encoding");

      return headers;
    };

    /*
     * ------------------------------------------------------------
     * Detailed exception information.
     * ------------------------------------------------------------
     */
    const getErrorDetails = (err) => {
      if (err instanceof Error) {
        return {
          name: err.name,
          message: err.message,
          stack: err.stack || null,
          cause:
            err.cause instanceof Error
              ? {
                  name: err.cause.name,
                  message: err.cause.message,
                  stack: err.cause.stack || null,
                }
              : err.cause != null
                ? String(err.cause)
                : null,
        };
      }

      return {
        name: typeof err,
        message: String(err),
        stack: null,
        cause: null,
      };
    };

    /*
     * ------------------------------------------------------------
     * Safe request diagnostics.
     *
     * Deliberately does NOT expose client IP identity headers,
     * cookies, authorization, etc.
     * ------------------------------------------------------------
     */
    const getRequestDiagnostics = () => {
      const safeHeaders = {};

      for (const name of [
        "Accept",
        "Accept-Language",
        "Content-Type",
        "User-Agent",
      ]) {
        const value = request.headers.get(name);

        if (value) {
          safeHeaders[name] = value;
        }
      }

      return {
        method: request.method,
        workerUrl: request.url,
        requestedHost: host || null,
        headers: safeHeaders,
      };
    };

    /*
     * ------------------------------------------------------------
     * Single URL fetch helper.
     *
     * This is retained for compatibility with the existing
     * worker structure.
     * ------------------------------------------------------------
     */
    const fetchSingle = async (targetParam) => {
      if (!targetParam) {
        return {
          status: "validation-error",
          error: "Missing 'url' parameter",
        };
      }

      let targetUrl;

      try {
        targetUrl = new URL(targetParam);
      } catch (err) {
        return {
          status: "invalid-url",
          url: targetParam,
          error: getErrorDetails(err),
        };
      }

      let headers;

      try {
        headers = buildHeaders();
      } catch (err) {
        return {
          status: "header-construction-error",
          url: targetUrl.toString(),
          error: getErrorDetails(err),
        };
      }

      try {
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

        /*
         * fetch() succeeded.
         *
         * A 404 / 403 / 500 is still a successful fetch()
         * from the Worker perspective because the origin returned
         * an HTTP response.
         */
        return {
          status: "origin-response",
          url: targetUrl.toString(),
          statusCode: originResponse.status,
          statusText: originResponse.statusText,
          ok: originResponse.ok,
          responseHeaders: Object.fromEntries(
            originResponse.headers.entries()
          ),
        };
      } catch (err) {
        /*
         * fetch() itself failed before an origin Response
         * was returned.
         */
        return {
          status: "worker-fetch-exception",
          url: targetUrl.toString(),
          error: getErrorDetails(err),
          request: getRequestDiagnostics(),
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
     * Optional:
     *
     * {
     *   "urls": [...],
     *   "method": "GET"
     * }
     *
     * If method is omitted, it defaults to HEAD.
     * ------------------------------------------------------------
     */
    let batchUrls = null;
    let batchMethod = "HEAD";

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
            batchMethod = body?.method ?? "HEAD";
          }
        }
      } catch {
        /*
         * Invalid JSON is intentionally ignored so that the
         * existing single-URL behavior remains intact.
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
       */
      if (
        batchUrls.some(
          (value) =>
            typeof value !== "string" ||
            value.length === 0
        )
      ) {
        return new Response(
          JSON.stringify(
            {
              status: "validation-error",
              error:
                "'urls' must contain only non-empty strings",
            },
            null,
            2
          ),
          {
            status: 400,
            headers: {
              "Content-Type":
                "application/json",
            },
          }
        );
      }

      /*
       * Process all URLs concurrently.
       *
       * Each URL gets its own result.
       */
      const results = await Promise.all(
        batchUrls.map(async (targetParam) => {
          let targetUrl;

          try {
            targetUrl =
              new URL(targetParam);
          } catch (err) {
            return {
              status: "invalid-url",
              url: targetParam,
              error: getErrorDetails(err),
            };
          }

          let headers;

          try {
            headers = buildHeaders();
          } catch (err) {
            return {
              status:
                "header-construction-error",
              url:
                targetUrl.toString(),
              error:
                getErrorDetails(err),
            };
          }

          try {
            const originResponse =
              await fetch(
                targetUrl.toString(),
                {
                  method: batchMethod,
                  headers,
                }
              );

            /*
             * Only read the response body when the
             * requested method is not HEAD.
             */
            let data = null;

            if (batchMethod !== "HEAD") {
              const contentType =
                originResponse.headers.get(
                  "content-type"
                ) || "";

              if (
                contentType
                  .toLowerCase()
                  .includes("application/json")
              ) {
                try {
                  data =
                    await originResponse.json();
                } catch {
                  data = null;
                }
              }
            }

            return {
              status:
                "origin-response",
              url:
                targetUrl.toString(),
              statusCode:
                originResponse.status,
              statusText:
                originResponse.statusText,
              ok:
                originResponse.ok,
              headers:
                Object.fromEntries(
                  originResponse.headers.entries()
                ),
              data,
            };
          } catch (err) {
            return {
              status:
                "worker-fetch-exception",
              url:
                targetUrl.toString(),
              error:
                getErrorDetails(err),
              request: {
                method:
                  batchMethod,
                workerUrl:
                  request.url,
                requestedHost:
                  host || null,
              },
            };
          }
        })
      );

      return new Response(
        JSON.stringify(
          {
            status:
              "batch-complete",
            count:
              results.length,
            results,
          },
          null,
          2
        ),
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
     * If no batch was supplied, use ?url=...
     * ------------------------------------------------------------
     */
    if (!targetParam) {
      return new Response(
        JSON.stringify(
          {
            status:
              "validation-error",
            error:
              "Missing 'url' parameter",
          },
          null,
          2
        ),
        {
          status: 400,
          headers: {
            "Content-Type":
              "application/json",
          },
        }
      );
    }

    let targetUrl;

    try {
      targetUrl =
        new URL(targetParam);
    } catch (err) {
      return new Response(
        JSON.stringify(
          {
            status:
              "invalid-url",
            targetUrl:
              targetParam,
            error:
              getErrorDetails(err),
            request:
              getRequestDiagnostics(),
          },
          null,
          2
        ),
        {
          status: 400,
          headers: {
            "Content-Type":
              "application/json",
          },
        }
      );
    }

    let headers;

    try {
      headers =
        buildHeaders();
    } catch (err) {
      return new Response(
        JSON.stringify(
          {
            status:
              "header-construction-error",
            targetUrl:
              targetUrl.toString(),
            error:
              getErrorDetails(err),
            request:
              getRequestDiagnostics(),
          },
          null,
          2
        ),
        {
          status: 500,
          headers: {
            "Content-Type":
              "application/json",
          },
        }
      );
    }

    /*
     * ------------------------------------------------------------
     * SINGLE URL FETCH
     * ------------------------------------------------------------
     */
    try {
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

      /*
       * ----------------------------------------------------------
       * HEAD DIAGNOSTIC MODE
       *
       * Instead of passing the HEAD response straight through,
       * return detailed JSON so we can see exactly what the
       * origin returned.
       *
       * This is intentionally HTTP 200 because the JSON itself
       * is the diagnostic response. The actual origin status is
       * inside origin.statusCode.
       * ----------------------------------------------------------
       */
      if (request.method === "HEAD") {
        return new Response(
          JSON.stringify(
            {
              status:
                "origin-response",

              target: {
                url:
                  targetUrl.toString(),
                host:
                  targetUrl.hostname,
                protocol:
                  targetUrl.protocol,
                port:
                  targetUrl.port ||
                  (
                    targetUrl.protocol ===
                    "https:"
                      ? "443"
                      : "80"
                  ),
                pathname:
                  targetUrl.pathname,
                method:
                  request.method,
              },

              origin: {
                statusCode:
                  originResponse.status,
                statusText:
                  originResponse.statusText,
                ok:
                  originResponse.ok,
                headers:
                  Object.fromEntries(
                    originResponse.headers.entries()
                  ),
              },

              worker: {
                url:
                  request.url,
                requestedHost:
                  host || null,
              },

              outboundHeaders:
                Object.fromEntries(
                  headers.entries()
                ),

              removedClientIdentityHeaders: [
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
                "Accept-Encoding",
              ],

              interpretation:
                "fetch() completed successfully and the origin returned an HTTP response. origin.statusCode is the actual origin HTTP status."
            },
            null,
            2
          ),
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
       * ----------------------------------------------------------
       * NORMAL GET / non-HEAD behavior
       *
       * Pass the actual origin response through unchanged.
       * ----------------------------------------------------------
       */
      const responseHeaders =
        new Headers(
          originResponse.headers
        );

      return new Response(
        originResponse.body,
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
      /*
       * ----------------------------------------------------------
       * WORKER FETCH EXCEPTION
       *
       * fetch() itself failed.
       *
       * Therefore there was no normal HTTP response from the
       * origin available to return.
       * ----------------------------------------------------------
       */
      const errorDetails =
        getErrorDetails(err);

      return new Response(
        JSON.stringify(
          {
            status:
              "worker-fetch-exception",

            message:
              "The Cloudflare Worker fetch() itself threw an exception. No normal origin HTTP response was received by the Worker.",

            target: {
              url:
                targetUrl.toString(),
              host:
                targetUrl.hostname,
              protocol:
                targetUrl.protocol,
              port:
                targetUrl.port ||
                (
                  targetUrl.protocol ===
                  "https:"
                    ? "443"
                    : "80"
                ),
              pathname:
                targetUrl.pathname,
              method:
                request.method,
            },

            requestedHost:
              host || null,

            worker: {
              url:
                request.url,
              method:
                request.method,
            },

            error:
              errorDetails,

            outboundHeaders:
              Object.fromEntries(
                headers.entries()
              ),

            removedClientIdentityHeaders: [
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
              "Accept-Encoding",
            ],

            interpretation:
              "fetch() itself failed. This is a Worker-side fetch exception, not an HTTP status returned by the origin."
          },
          null,
          2
        ),
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
