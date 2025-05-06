const fetch = require("node-fetch");

// In-memory store for rate limits (per session; resets with cold start)
const rateLimitMap = new Map();

exports.handler = async (event) => {
  const allowOrigin = "https://www.rythmworks.com";

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders(allowOrigin),
      body: "OK",
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return errorResponse(500, "OPENAI_API_KEY is not set", allowOrigin);
  }

  // Extract user IP
  const userIP = event.headers["x-nf-client-connection-ip"] || "unknown";
  const usage = rateLimitMap.get(userIP) || { count: 0, lastUsed: Date.now() };
  const today = new Date().toDateString();
  const lastUsedDay = new Date(usage.lastUsed).toDateString();

  if (usage.count >= 3 && today === lastUsedDay) {
    return {
      statusCode: 429,
      headers: corsHeaders(allowOrigin),
      body: JSON.stringify({
        error: "⛔ You’ve reached your daily limit of 3 blog posts. Please come back tomorrow.",
      }),
    };
  }

  let topic, keywords, tone, length;
  try {
    const parsedBody = JSON.parse(event.body || "{}");
    topic = parsedBody.topic;
    keywords = parsedBody.keywords;
    tone = parsedBody.tone || "informative";
    length = parsedBody.length || "medium";

    if (!topic || !keywords) throw new Error("Topic and keywords are required.");
  } catch (err) {
    return errorResponse(400, "Invalid input: " + err.message, allowOrigin);
  }

  const prompt = buildPrompt(topic, keywords, tone, length);
  console.log("Prompt sent to OpenAI:", prompt);
  console.log("User IP:", userIP);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1200,
      }),
    });

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) throw new Error("No content returned by OpenAI");

    const blogHtml = markdownToHTML(raw);

    rateLimitMap.set(userIP, {
      count: today === lastUsedDay ? usage.count + 1 : 1,
      lastUsed: Date.now(),
    });

    return {
      statusCode: 200,
      headers: corsHeaders(allowOrigin),
      body: JSON.stringify({ blog: blogHtml }),
    };
  } catch (error) {
    return errorResponse(500, "OpenAI API error: " + error.message, allowOrigin);
  }
};

// Helpers

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function errorResponse(status, message, origin) {
  return {
    statusCode: status,
    headers: corsHeaders(origin),
    body: JSON.stringify({ error: message }),
  };
}

function buildPrompt(topic, keywords, tone, length) {
  const wordCount = {
    short: "around 300 words",
    medium: "around 600 words",
    long: "around 1000 words or more",
  };

  return `Write a detailed, SEO-optimized blog post on the topic: "${topic}".
Include these keywords: ${keywords}.
Use a ${tone} tone and make it ${wordCount[length] || "medium length"}.
Use proper structure with headers, subheadings, and readable formatting. Write it in markdown.`;
}

function markdownToHTML(md) {
  return md
    .replace(/^### (.*$)/gim, "<h3>$1</h3>")
    .replace(/^## (.*$)/gim, "<h2>$1</h2>")
    .replace(/^# (.*$)/gim, "<h1>$1</h1>")
    .replace(/^\- (.*$)/gim, "<li>$1</li>")
    .replace(/\*\*(.*?)\*\*/gim, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/gim, "<em>$1</em>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>")
    .replace(/^<p>/, "")
    .replace(/<\/p>$/, "")
    .trim()
    .replace(/<\/p><p>/g, "<br><br>")
    .replace(/<li>(.*?)<\/li>/gim, "<li>$1</li>");
}
