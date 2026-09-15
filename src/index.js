export default {
  async fetch(request) {
    const urlObj = new URL(request.url)
    const targetParam = urlObj.searchParams.get("url");

    if (!targetParam) {
      return new Response("Missing 'url' parameter", { status: 400 });
    }

    try {
      const targetUrl = new URL(targetParam);
      const originResponse = await fetch(targetUrl.toString(), {
        method: "GET",
        headers: {
          "Host": urlObj.searchParams.get("host"), // Automatically extracts domain (e.g. cloudfront-domain.com)
          'User-Agent': 'PostmanRuntime/7.56.1',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate, br',        
        }
      });

      return new Response(originResponse.body, {
        status: originResponse.status,
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }
};