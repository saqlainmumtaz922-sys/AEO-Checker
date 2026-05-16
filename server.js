const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Flesch-Kincaid Grade Level ──────────────────────────────────────────────
function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!word) return 0;
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  word = word.replace(/^y/, "");
  const matches = word.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 1;
}

function fleschKincaidGrade(text) {
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z']/g, ""))
    .filter((w) => w.length > 0);

  if (sentences.length === 0 || words.length === 0) return 0;

  const totalSyllables = words.reduce(
    (sum, word) => sum + countSyllables(word),
    0
  );
  const avgWordsPerSentence = words.length / sentences.length;
  const avgSyllablesPerWord = totalSyllables / words.length;

  const grade = 0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59;
  return Math.max(0, Math.round(grade * 10) / 10);
}

// ─── Check Concise Answer Paragraphs ─────────────────────────────────────────
function checkConciseAnswers($) {
  const results = [];
  $("p").each((_, el) => {
    const text = $(el).text().trim();
    const wordCount = text
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
    if (wordCount >= 40 && wordCount <= 60) {
      results.push({ text: text.substring(0, 120) + "...", wordCount });
    }
  });
  return results;
}

// ─── Schema Validation ───────────────────────────────────────────────────────
function checkSchema(html, $) {
  const schemas = { faqPage: false, howTo: false, found: [] };

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      const json = JSON.parse(raw);
      const items = Array.isArray(json) ? json : [json];
      items.forEach((item) => {
        const type = item["@type"] || "";
        if (type === "FAQPage") {
          schemas.faqPage = true;
          schemas.found.push("FAQPage");
        }
        if (type === "HowTo") {
          schemas.howTo = true;
          schemas.found.push("HowTo");
        }
        if (item["@graph"]) {
          item["@graph"].forEach((node) => {
            const t = node["@type"] || "";
            if (t === "FAQPage") { schemas.faqPage = true; schemas.found.push("FAQPage"); }
            if (t === "HowTo")   { schemas.howTo = true;   schemas.found.push("HowTo");   }
          });
        }
      });
    } catch (_) {}
  });

  // Also check inline JSON strings as fallback
  if (!schemas.faqPage && html.includes('"FAQPage"'))   { schemas.faqPage = true; schemas.found.push("FAQPage (inline)"); }
  if (!schemas.howTo  && html.includes('"HowTo"'))     { schemas.howTo  = true; schemas.found.push("HowTo (inline)");   }

  return schemas;
}

// ─── Extract Visible Text ─────────────────────────────────────────────────────
function extractText($) {
  $("script, style, noscript, nav, footer, header, aside, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

// ─── Title & Meta Checks ─────────────────────────────────────────────────────
function checkMetaTags($) {
  const title = $("title").text().trim();
  const metaDesc = $('meta[name="description"]').attr("content") || "";
  const h1 = $("h1").first().text().trim();
  const canonical = $('link[rel="canonical"]').attr("href") || "";

  return {
    title: { value: title, length: title.length, ok: title.length >= 40 && title.length <= 60 },
    metaDesc: { value: metaDesc.substring(0, 100), length: metaDesc.length, ok: metaDesc.length >= 120 && metaDesc.length <= 160 },
    h1: { value: h1, exists: h1.length > 0 },
    canonical: { value: canonical, exists: canonical.length > 0 },
  };
}

// ─── Check FAQ / Question Content ────────────────────────────────────────────
function checkQuestionContent($) {
  const questionPatterns = /\b(what|how|why|when|where|who|which|can|does|is|are|will|should)\b.*\?/gi;
  let questionCount = 0;
  $("h2, h3, h4").each((_, el) => {
    if (questionPatterns.test($(el).text())) questionCount++;
  });
  return questionCount;
}

// ─── Scoring Engine ───────────────────────────────────────────────────────────
function calculateScore(data) {
  let score = 0;
  const weights = {
    conciseAnswer: 25,   // Has 40-60 word paragraphs
    faqSchema:     20,   // FAQPage schema
    howToSchema:   10,   // HowTo schema
    readability:   20,   // FK Grade 6-12
    metaTitle:     10,   // Title length
    metaDesc:       5,   // Meta description
    h1:             5,   // H1 present
    questionHeads:  5,   // Question-based headings
  };

  if (data.conciseParagraphs.length > 0) score += weights.conciseAnswer;
  if (data.schema.faqPage) score += weights.faqSchema;
  if (data.schema.howTo)   score += weights.howToSchema;

  const fk = data.readability.grade;
  if (fk >= 6 && fk <= 12) score += weights.readability;
  else if (fk > 12 || (fk >= 4 && fk < 6)) score += Math.floor(weights.readability * 0.5);

  if (data.meta.title.ok)    score += weights.metaTitle;
  if (data.meta.metaDesc.ok) score += weights.metaDesc;
  if (data.meta.h1.exists)   score += weights.h1;
  if (data.questionHeadings > 0) score += weights.questionHeads;

  return Math.min(100, score);
}

// ─── Recommendations ─────────────────────────────────────────────────────────
function generateRecommendations(data, score) {
  const recs = [];

  if (data.conciseParagraphs.length === 0) {
    recs.push({
      priority: "high",
      icon: "✦",
      title: "Add Featured Snippet Paragraphs",
      detail: "Write at least 2–3 paragraphs with 40–60 words each. AI engines extract these as direct answers to user queries.",
    });
  }
  if (!data.schema.faqPage) {
    recs.push({
      priority: "high",
      icon: "✦",
      title: "Implement FAQPage Schema Markup",
      detail: "Add JSON-LD FAQPage structured data. This is the #1 signal for AI answer engines and dramatically improves snippet chances.",
    });
  }
  if (!data.schema.howTo) {
    recs.push({
      priority: "medium",
      icon: "◈",
      title: "Add HowTo Schema for Instructional Content",
      detail: "If your page includes step-by-step instructions, wrap them in HowTo JSON-LD schema for voice assistant compatibility.",
    });
  }
  const fk = data.readability.grade;
  if (fk > 12) {
    recs.push({
      priority: "high",
      icon: "✦",
      title: `Simplify Writing (FK Grade: ${fk})`,
      detail: "Your text reads at a college+ level. Voice search targets Grade 8–10. Use shorter sentences and simpler vocabulary.",
    });
  } else if (fk < 6) {
    recs.push({
      priority: "medium",
      icon: "◈",
      title: `Expand Content Depth (FK Grade: ${fk})`,
      detail: "Content may be too simplistic. Aim for Grade 6–10 to balance readability with topical authority.",
    });
  }
  if (!data.meta.title.ok) {
    recs.push({
      priority: "medium",
      icon: "◈",
      title: "Optimize Page Title Length",
      detail: `Current title is ${data.meta.title.length} characters. Target 40–60 chars for optimal AI and search engine display.`,
    });
  }
  if (!data.meta.metaDesc.ok) {
    recs.push({
      priority: "medium",
      icon: "◈",
      title: "Fix Meta Description",
      detail: `Meta description is ${data.meta.metaDesc.length} characters. Target 120–160 chars with a clear answer to the page's core question.`,
    });
  }
  if (!data.meta.h1.exists) {
    recs.push({
      priority: "medium",
      icon: "◈",
      title: "Add a Primary H1 Heading",
      detail: "No H1 found. Every AEO-optimized page needs a clear H1 that matches the user's search intent.",
    });
  }
  if (data.questionHeadings === 0) {
    recs.push({
      priority: "low",
      icon: "◇",
      title: "Use Question-Based Subheadings",
      detail: 'Structure H2/H3 headings as questions (e.g., "How does X work?"). This mirrors voice search queries directly.',
    });
  }
  if (score >= 85) {
    recs.push({
      priority: "low",
      icon: "◇",
      title: "Consider Speakable Schema",
      detail: "Your page is well-optimized. Add Speakable schema to designate which sections should be read aloud by Google Assistant.",
    });
  }

  return recs;
}

// ─── Main API Endpoint ────────────────────────────────────────────────────────
app.post("/api/audit", async (req, res) => {
  let { url } = req.body;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Please provide a valid URL." });
  }

  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL format. Please include a valid domain." });
  }

  try {
    const response = await axios.get(url, {
      timeout: 12000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AEO-Checker/1.0; +https://aeo-checker.tool)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Cache-Control": "no-cache",
      },
      validateStatus: (s) => s < 400,
    });

    const html = response.data;
    const $ = cheerio.load(html);
    const bodyText = extractText($);

    if (bodyText.length < 100) {
      return res.status(422).json({ error: "Could not extract meaningful content from this page. It may require JavaScript rendering." });
    }

    const conciseParagraphs = checkConciseAnswers($);
    const schema = checkSchema(html, $);
    const fkGrade = fleschKincaidGrade(bodyText);
    const meta = checkMetaTags($);
    const questionHeadings = checkQuestionContent($);
    const wordCount = bodyText.split(/\s+/).filter((w) => w.length > 0).length;

    const auditData = {
      url,
      conciseParagraphs,
      schema,
      readability: { grade: fkGrade, target: "6–10 (Voice Search Optimal)" },
      meta,
      questionHeadings,
      wordCount,
    };

    const score = calculateScore(auditData);
    const recommendations = generateRecommendations(auditData, score);

    const grade =
      score >= 85 ? { label: "Excellent", color: "#00d4a0" } :
      score >= 65 ? { label: "Good",      color: "#f0b429" } :
      score >= 40 ? { label: "Fair",       color: "#f06449" } :
                    { label: "Poor",       color: "#e63757" };

    return res.json({
      success: true,
      url,
      score,
      grade,
      checks: {
        conciseAnswer: {
          passed: conciseParagraphs.length > 0,
          value: conciseParagraphs.length,
          detail: `${conciseParagraphs.length} paragraph(s) in the 40–60 word sweet spot`,
          samples: conciseParagraphs.slice(0, 2),
        },
        faqSchema: {
          passed: schema.faqPage,
          detail: schema.faqPage ? "FAQPage JSON-LD schema detected" : "No FAQPage schema found",
        },
        howToSchema: {
          passed: schema.howTo,
          detail: schema.howTo ? "HowTo JSON-LD schema detected" : "No HowTo schema found",
        },
        readability: {
          passed: fkGrade >= 6 && fkGrade <= 12,
          value: fkGrade,
          detail: `Flesch-Kincaid Grade Level: ${fkGrade} (target 6–10 for voice search)`,
        },
        metaTitle: {
          passed: meta.title.ok,
          value: meta.title.length,
          detail: `Title: "${meta.title.value.substring(0, 60)}${meta.title.value.length > 60 ? "…" : ""}" (${meta.title.length} chars)`,
        },
        metaDesc: {
          passed: meta.metaDesc.ok,
          value: meta.metaDesc.length,
          detail: `Meta description: ${meta.metaDesc.length} characters (target 120–160)`,
        },
        h1: {
          passed: meta.h1.exists,
          detail: meta.h1.exists ? `H1: "${meta.h1.value.substring(0, 60)}"` : "No H1 heading found",
        },
        questionHeadings: {
          passed: questionHeadings > 0,
          value: questionHeadings,
          detail: `${questionHeadings} question-based heading(s) found`,
        },
      },
      stats: { wordCount },
      recommendations,
    });
  } catch (err) {
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
      return res.status(502).json({ error: "Could not connect to the URL. Please check the domain is accessible." });
    }
    if (err.code === "ETIMEDOUT" || err.code === "ECONNABORTED") {
      return res.status(504).json({ error: "Request timed out. The server took too long to respond." });
    }
    if (err.response?.status === 403 || err.response?.status === 401) {
      return res.status(403).json({ error: "Access denied by the target server. The site may block automated requests." });
    }
    if (err.response?.status === 404) {
      return res.status(404).json({ error: "Page not found (404). Please check the URL." });
    }
    console.error("Audit error:", err.message);
    return res.status(500).json({ error: "An unexpected error occurred. Please try again." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ AEO Checker running → http://localhost:${PORT}`));
