/**
 * ChatJimmy OpenAI-Compatible API Proxy
 * Cloudflare Snippets / Workers — Pure JavaScript
 *
 * Env Variables:
 *   API_KEY  - Bearer token (空 = 不鉴权)
 *   DEBUG    - "true" 开启日志
 */

const CHATJIMMY_API_URL = "https://chatjimmy.ai/api/chat";
const DEFAULT_MODEL = "llama3.1-8B";
const CHUNK_SIZE = 32;
const UPSTREAM_TIMEOUT_MS = 15000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ✅ 新的（正确匹配 ChatJimmy 真实格式）
const THINK_RE      = /<\|think\|>[\s\S]*?<\|\/think\|>/gi;
const STATS_TAG_RE  = /<\|stats\|>[\s\S]*?<\|\/stats\|>/g;
const STATS_EXTRACT = /<\|stats\|>([\s\S]*?)<\|\/stats\|>/;

// ─── Utilities ────────────────────────────────────────────────────────────────

function generateId() {
  return "chatcmpl-" + Date.now();
}

function checkAuth(request, apiKey) {
  if (!apiKey) return true;
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === apiKey;
}

function jsonResp(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS),
  });
}

function errResp(message, status, code) {
  return jsonResp(
    { error: { message: message, type: "invalid_request_error", code: code || "server_error" } },
    status || 500
  );
}

// ★ 关键修复：流式请求的错误必须用 SSE 格式，否则 AI SDK 解析失败变 [undefined]
function sseErrResp(message) {
  const errChunk = "data: " + JSON.stringify({
    id: generateId(),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: DEFAULT_MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    error: { message: message, type: "server_error" },
  }) + "\n\ndata: [DONE]\n\n";

  return new Response(errChunk, {
    status: 200, // ★ AI SDK 对 200 才会正常走 SSE 解析路径
    headers: Object.assign({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }, CORS),
  });
}

// ─── Content Processing ───────────────────────────────────────────────────────

function extractText(msg) {
  const content = msg.content;
  if (typeof content === "string") return { text: content, attachment: null };

  if (Array.isArray(content)) {
    const parts = content
      .filter(function (p) { return p && p.type === "text" && p.text; })
      .map(function (p) { return p.text; });

    if (parts.length <= 1) return { text: parts[0] || "", attachment: null };

    for (var i = 1; i < parts.length; i++) {
      var lines = parts[i].split("\n");
      if (lines.length >= 2 && lines[0].includes(".")) {
        var body = lines.slice(1).join("\n");
        return {
          text: parts[0],
          attachment: { name: lines[0], size: body.length, content: body },
        };
      }
    }
    return { text: parts[0], attachment: null };
  }
  return { text: "", attachment: null };
}

// ─── Stats & Cleaning ─────────────────────────────────────────────────────────

function parseStats(content) {
  var m = content.match(STATS_EXTRACT);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

function parseUsage(content) {
  var s = parseStats(content);
  if (s) {
    return {
      prompt_tokens:     s.prefill_tokens  || 0,
      completion_tokens: s.decode_tokens   || 0,
      total_tokens:      s.total_tokens    || 0,
    };
  }
  var est = Math.floor(content.length / 4);
  return { prompt_tokens: est, completion_tokens: est, total_tokens: est * 2 };
}

function cleanContent(raw) {
  return raw.replace(THINK_RE, "").replace(STATS_TAG_RE, "").trim();
}

function chunkify(text, size) {
  size = size || CHUNK_SIZE;
  var chars = Array.from(text);
  var result = [];
  for (var i = 0; i < chars.length; i += size) {
    result.push(chars.slice(i, i + size).join(""));
  }
  return result;
}

// ─── ChatJimmy API ────────────────────────────────────────────────────────────

function makeAbortSignal(timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort("upstream timeout");
  }, timeoutMs || UPSTREAM_TIMEOUT_MS);
  return { signal: controller.signal, clear: function () { clearTimeout(timer); } };
}

async function callChatJimmy(req, debug) {
  var body = JSON.stringify(req);
  if (debug) console.log("[ChatJimmy Request]", body);

  var abortCtl = makeAbortSignal(UPSTREAM_TIMEOUT_MS);
  var start = Date.now();
  var res;
  try {
    res = await fetch(CHATJIMMY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept":        "*/*",
        "Origin":        "https://chatjimmy.ai",
        "Referer":       "https://chatjimmy.ai/",
        "User-Agent":    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: body,
      signal: abortCtl.signal,
    });
  } finally {
    abortCtl.clear();
  }

  var upstreamLatency = Date.now() - start;

  if (!res.ok) {
    var errBody = "";
    try { errBody = await res.text(); } catch(e) {}
    throw new Error("ChatJimmy " + res.status + ": " + (errBody || res.statusText));
  }

  var text = await res.text();
  if (debug) console.log("[ChatJimmy Response]", text);

  if (!text || text.trim() === "") {
    throw new Error("ChatJimmy returned empty response");
  }

  return { text: text, upstreamLatencyMs: upstreamLatency };
}

async function callChatJimmyStream(req, debug) {
  var body = JSON.stringify(req);
  if (debug) console.log("[ChatJimmy Request(stream)]", body);

  var abortCtl = makeAbortSignal(UPSTREAM_TIMEOUT_MS);
  var start = Date.now();
  var res;
  try {
    res = await fetch(CHATJIMMY_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept":        "*/*",
        "Origin":        "https://chatjimmy.ai",
        "Referer":       "https://chatjimmy.ai/",
        "User-Agent":    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: body,
      signal: abortCtl.signal,
    });
  } finally {
    abortCtl.clear();
  }

  var upstreamLatency = Date.now() - start;

  if (!res.ok) {
    var errBody = "";
    try { errBody = await res.text(); } catch(e) {}
    throw new Error("ChatJimmy " + res.status + ": " + (errBody || res.statusText));
  }

  if (!res.body) throw new Error("ChatJimmy stream body is empty");
  return { body: res.body, upstreamLatencyMs: upstreamLatency };
}

// ─── Build Request ────────────────────────────────────────────────────────────

function buildRequest(req) {
  var systemPrompt = "";
  var messages = [];
  var lastUserAttachment = null;
  var lastUserIdx = -1;

  (req.messages || []).forEach(function (msg, i) {
    if (msg.role === "system") {
      systemPrompt = typeof msg.content === "string" ? msg.content : extractText(msg).text;
      return;
    }
    var result = extractText(msg);
    if (msg.role === "user" && result.attachment) {
      lastUserAttachment = result.attachment;
      lastUserIdx = i;
    }
    messages.push({ role: msg.role, content: result.text });
  });

  var lastIdx = (req.messages || []).length - 1;
  var attachment = null;
  if (
    req.messages[lastIdx] &&
    req.messages[lastIdx].role === "user" &&
    lastUserIdx === lastIdx &&
    lastUserAttachment
  ) {
    attachment = lastUserAttachment;
  }
  if (!attachment && req.attachment) attachment = req.attachment;

  return {
    messages: messages,
    chatOptions: {
      selectedModel: req.model || DEFAULT_MODEL,
      systemPrompt:  systemPrompt,
      topK:          req.top_k || 8,
    },
    attachment: attachment,
  };
}

// ─── Response Builders ────────────────────────────────────────────────────────

function makeCompletion(raw, model) {
  return {
    id:      generateId(),
    object:  "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model:   model,
    choices: [{
      index:         0,
      message:       { role: "assistant", content: cleanContent(raw) },
      finish_reason: "stop",
    }],
    usage: parseUsage(raw),
  };
}

function makeStreamResponseFromUpstream(upstreamBody, model, upstreamLatencyMs, startedAt) {
  var id      = generateId();
  var created = Math.floor(Date.now() / 1000);
  var enc     = new TextEncoder();
  var dec     = new TextDecoder();
  var ts      = new TransformStream();
  var writer  = ts.writable.getWriter();
  var reader  = upstreamBody.getReader();

  function emit(delta, finish) {
    var payload = JSON.stringify({
      id:      id,
      object:  "chat.completion.chunk",
      created: created,
      model:   model,
      choices: [{ index: 0, delta: delta, finish_reason: finish || null }],
    });
    return writer.write(enc.encode("data: " + payload + "\n\n"));
  }

  (async function () {
    var carry = "";
    try {
      await emit({ role: "assistant" });

      while (true) {
        var result = await reader.read();
        if (result.done) break;

        var text = dec.decode(result.value, { stream: true });
        if (!text) continue;

        carry += text;
        var safe = carry
          .replace(THINK_RE, "")
          .replace(STATS_TAG_RE, "");

        if (safe.length < CHUNK_SIZE) {
          carry = safe;
          continue;
        }

        var chunks = chunkify(safe, CHUNK_SIZE);
        carry = chunks.pop() || "";
        for (var i = 0; i < chunks.length; i++) {
          if (chunks[i]) await emit({ content: chunks[i] });
        }
      }

      carry += dec.decode();
      var tail = cleanContent(carry);
      if (tail) {
        var lastChunks = chunkify(tail, CHUNK_SIZE);
        for (var j = 0; j < lastChunks.length; j++) {
          if (lastChunks[j]) await emit({ content: lastChunks[j] });
        }
      }

      await emit({}, "stop");
      await writer.write(enc.encode("data: [DONE]\n\n"));
    } catch (e) {
      try {
        var errPayload = "data: " + JSON.stringify({ error: { message: String(e) } }) + "\n\n";
        await writer.write(enc.encode(errPayload));
        await writer.write(enc.encode("data: [DONE]\n\n"));
      } catch (_) {}
    } finally {
      try { reader.releaseLock(); } catch (_) {}
      try { writer.close(); } catch (_) {}
    }
  })();

  var headers = Object.assign({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Upstream-Latency-Ms": String(upstreamLatencyMs || 0),
    "X-Proxy-Start-Ms": String(Date.now() - (startedAt || Date.now())),
  }, CORS);

  return new Response(ts.readable, { headers: headers });
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

function routeRoot() {
  return new Response(
    "<!DOCTYPE html><html><head><title>ChatJimmy API</title></head><body>" +
    "<h1>ChatJimmy API</h1><ul>" +
    "<li><code>POST /v1/chat/completions</code></li>" +
    "<li><code>GET  /v1/models</code></li>" +
    "<li><code>GET  /health</code> - 连接测试</li>" +
    "</ul></body></html>",
    { headers: Object.assign({ "Content-Type": "text/html;charset=utf-8" }, CORS) }
  );
}

function routeModels() {
  return jsonResp({
    object: "list",
    data: [{
      id:       DEFAULT_MODEL,
      object:   "model",
      created:  Math.floor(Date.now() / 1000),
      owned_by: "chatjimmy",
    }],
  });
}

// ★ 诊断端点：测试 ChatJimmy 是否可达
async function routeHealth() {
  var start = Date.now();
  try {
    var testReq = {
      messages: [{ role: "user", content: "hi" }],
      chatOptions: { selectedModel: DEFAULT_MODEL, systemPrompt: "", topK: 1 },
      attachment: null,
    };
    var ret = await callChatJimmy(testReq, false);
    return jsonResp({
      status: "ok",
      upstream: "chatjimmy.ai",
      latency_ms: Date.now() - start,
      upstream_latency_ms: ret.upstreamLatencyMs,
      response_length: ret.text.length,
    });
  } catch (e) {
    return jsonResp({
      status: "error",
      upstream: "chatjimmy.ai",
      latency_ms: Date.now() - start,
      error: String(e),
    }, 502);
  }
}

// ★ 核心修复：流式与非流式错误分开处理
async function routeChat(request, debug) {
  if (request.method !== "POST") return errResp("Method not allowed", 405);

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return errResp("Invalid JSON body", 400);
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return body.stream
      ? sseErrResp("messages field is required and must be an array")
      : errResp("messages field is required", 400);
  }

  var jimmyReq = buildRequest(body);
  var model    = body.model || DEFAULT_MODEL;
  var isStream = !!body.stream;

  var startedAt = Date.now();

  try {
    if (isStream) {
      var streamRet = await callChatJimmyStream(jimmyReq, debug);
      return makeStreamResponseFromUpstream(streamRet.body, model, streamRet.upstreamLatencyMs, startedAt);
    }

    var ret = await callChatJimmy(jimmyReq, debug);
    var response = jsonResp(makeCompletion(ret.text, model));
    response.headers.set("X-Upstream-Latency-Ms", String(ret.upstreamLatencyMs || 0));
    response.headers.set("X-Total-Latency-Ms", String(Date.now() - startedAt));
    return response;
  } catch (e) {
    // ★ 流式错误用 SSE 格式，非流式用 JSON —— 这是 [undefined] 的根本修复
    return isStream
      ? sseErrResp(String(e))
      : errResp(String(e), 502, "upstream_error");
  }
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    var url     = new URL(request.url);
    var path    = url.pathname;
    var apiKey  = (env && env.API_KEY) || "";
    var debug   = !!(env && env.DEBUG === "true");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (path === "/" || path === "") return routeRoot();

    // /health 不需要鉴权，方便诊断
    if (path === "/health") return routeHealth();

    if (!checkAuth(request, apiKey)) {
      return errResp("Invalid API key", 401, "invalid_api_key");
    }

    if (path === "/v1/chat/completions") return routeChat(request, debug);
    if (path === "/v1/models")           return routeModels();

    return errResp("Not found", 404);
  },
};
