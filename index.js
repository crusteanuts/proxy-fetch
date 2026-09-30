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
       *
       * Keeping this out avoids introducing a potentially
       * misleading Host header into the outbound fetch.
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
     * Build detailed exception information.
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
     * Build diagnostic information about the request.
     *
     * IMPORTANT:
     * Do not include Cookie / Authorization / IP identity
     * headers in the diagnostic output.
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
     * Single URL fetch helper
     * ------------------------------------------------------------
     */
    const fetchSingle = async (targetParam) => {
      if (!targetParam) {
        return {
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
         * If fetch() succeeds, even a 404/403/500 is NOT a
         * Worker exception.
         *
         * This means the target server actually responded.
         */
        return {
          status: "origin-response",
          url: targetUrl.toString(),
          statusCode: originResponse.status,
          statusText: originResponse.statusText,
          responseHeaders: Object.fromEntries(
            originResponse.headers.entries()
          ),
        };
      } catch (err) {
        /*
         * This is the important case.
         *
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
      } catch (err) {
        /*
         * Invalid JSON is intentionally ignored here so that
         * the original single-URL behavior remains intact.
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
              status: "origin-response",
              url: targetUrl.toString(),
              statusCode: originResponse.status,
              statusText:
                originResponse.statusText,
              headers: Object.fromEntries(
                originResponse.headers.entries()
              ),
              data,
            };
          } catch (err) {
            return {
              status: "worker-fetch-exception",
              url: targetUrl.toString(),
              error: getErrorDetails(err),
              request: {
                method: batchMethod,
                workerUrl: request.url,
                requestedHost: host || null,
              },
            };
          }
        })
      );

      return new Response(
        JSON.stringify(
          {
            status: "batch-complete",
            count: results.length,
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
     * If no batch was supplied, behavior remains the
     * original ?url=... behavior.
     * ------------------------------------------------------------
     */
    if (!targetParam) {
      return new Response(
        JSON.stringify(
          {
            status: "validation-error",
            error: "Missing 'url' parameter",
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
      targetUrl = new URL(targetParam);
    } catch (err) {
      return new Response(
        JSON.stringify(
          {
            status: "invalid-url",
            targetUrl: targetParam,
            error: getErrorDetails(err),
            request: getRequestDiagnostics(),
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
      headers = buildHeaders();
    } catch (err) {
      return new Response(
        JSON.stringify(
          {
            status:
              "header-construction-error",
            targetUrl: targetUrl.toString(),
            error: getErrorDetails(err),
            request: getRequestDiagnostics(),
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
       * IMPORTANT:
       *
       * A 404 / 403 / 500 here means the origin actually
       * returned that status.
       *
       * It is NOT converted into a Worker 500.
       * ----------------------------------------------------------
       */
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
      /*
       * ----------------------------------------------------------
       * THIS IS THE CRITICAL DEBUGGING PATH.
       *
       * If we get here, fetch() itself threw.
       *
       * Therefore there was no normal HTTP response from
       * the target available to return.
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

            /*
             * Explicitly state that these client identity
             * headers were removed before fetch().
             */
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
              "This response was generated by the Worker because fetch() threw an exception. It was not generated from an HTTP status returned by the target server.",
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
