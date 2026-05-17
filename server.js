const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
  const words = text.split(/\s+/).map(w => w.replace(/[^a-zA-Z']/g, "")).filter(w => w.length > 0);
  if (!sentences.length || !words.length) return 0;
  const totalSyllables = words.reduce((sum, word) => sum + countSyllables(word), 0);
  const grade = 0.39 * (words.length / sentences.length) + 11.8 * (totalSyllables / words.length) - 15.59;
  return Math.max(0, Math.round(grade * 10) / 10);
}

function checkConciseAnswers($) {
  const results = [];
  $("p").each((_, el) => {
    const text = $(el).text().trim();
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
    if (wordCount >= 40 && wordCount <= 60) results.push({ text: text.substring(0, 120) + "...", wordCount });
  });
  return results;
}

function checkSchema(html, $) {
  const schemas = { faqPage: false, howTo: false, found: [] };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const items = Array.isArray(json) ? json : [json];
      items.forEach(item => {
        const type = item["@type"] || "";
        if (type === "FAQPage") { schemas.faqPage = true; schemas.found.push("FAQPage"); }
        if (type === "HowTo")   { schemas.howTo = true;   schemas.found.push("HowTo"); }
        if (item["@graph"]) item["@graph"].forEach(node => {
          if (node["@type"] === "FAQPage") { schemas.faqPage = true; schemas.found.push("FAQPage"); }
          if (node["@type"] === "HowTo")   { schemas.howTo = true;   schemas.found.push("HowTo"); }
        });
      });
    } catch (_) {}
  });
  if (!schemas.faqPage && html.includes('"FAQPage"')) { schemas.faqPage = true; schemas.found.push("FAQPage (inline)"); }
  if (!schemas.howTo  && html.includes('"HowTo"'))    { schemas.howTo  = true; schemas.found.push("HowTo (inline)"); }
  return schemas;
}

function extractText($) {
  $("script, style, noscript, nav, footer, header, aside, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

function checkMetaTags($) {
  const title = $("title").text().trim();
  const metaDesc = $('meta[name="description"]').attr("content") || "";
  const canonical = $('link[rel="canonical"]').attr("href") || "";

  // Try multiple H1 selectors — covers WordPress, GeneratePress, Yoast, custom themes
  const h1Selectors = [
    "h1",
    "h1.entry-title",
    "h1.post-title",
    "h1.page-title",
    ".entry-title",
    ".post-title",
    ".page-title",
    "[itemprop='headline']",
    ".entry-header h1",
    "article h1",
    "#main h1",
    ".site-main h1",
    ".content-area h1",
    ".inside-article h1",
  ];

  let h1 = "";
  for (const sel of h1Selectors) {
    const found = $(sel).first().text().trim();
    if (found && found.length > 2) {
      h1 = found;
      break;
    }
  }

  return {
    title: { value: title, length: title.length, ok: title.length >= 40 && title.length <= 60 },
    metaDesc: { value: metaDesc.substring(0, 160), length: metaDesc.length, ok: metaDesc.length >= 120 && metaDesc.length <= 160 },
    h1: { value: h1, exists: h1.length > 0 },
    canonical: { value: canonical, exists: canonical.length > 0 },
  };
}

function checkQuestionContent($) {
  const questionPatterns = /\b(what|how|why|when|where|who|which|can|does|is|are|will|should)\b.*\?/gi;
  let count = 0;
  $("h2, h3, h4").each((_, el) => { if (questionPatterns.test($(el).text())) count++; });
  return count;
}

function extractFAQs($) {
  const faqs = [];
  const qPattern = /\b(what|how|why|when|where|who|which|can|does|is|are|will|should)\b.*\?/i;
  $("h2, h3, h4").each((_, el) => {
    const question = $(el).text().trim();
    if (!qPattern.test(question)) return;
    let answer = "";
    let next = $(el).next();
    while (next.length && !next.is("h2,h3,h4,hr") && answer.length < 300) {
      const txt = next.text().trim();
      if (txt) answer += (answer ? " " : "") + txt;
      next = next.next();
    }
    if (question && answer) faqs.push({ question, answer: answer.substring(0, 250) });
  });
  return faqs.slice(0, 8);
}

function extractHowToSteps($) {
  const steps = [];
  $("ol").each((_, ol) => {
    $(ol).find("li").each((i, li) => {
      const text = $(li).text().trim();
      if (text.length > 10) steps.push({ text, index: i + 1 });
    });
  });
  return steps.slice(0, 10);
}

function generateFixes(data, $) {
  const fixes = {};

  // FAQPage Schema
  if (!data.schema.faqPage) {
    const faqs = extractFAQs($);
    if (faqs.length > 0) {
      const schemaObj = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": faqs.map(f => ({
          "@type": "Question",
          "name": f.question,
          "acceptedAnswer": { "@type": "Answer", "text": f.answer }
        }))
      };
      fixes.faqSchema = {
        type: "code",
        label: `Ready-to-use FAQPage JSON-LD — extracted ${faqs.length} Q&As from your page`,
        code: `<script type="application/ld+json">\n${JSON.stringify(schemaObj, null, 2)}\n<\/script>`,
        steps: ["Go to WordPress Dashboard → WPCode → Add New Snippet", 'Select "HTML Snippet"', "Paste the code below", 'Set Insert Location to "Footer" → Activate']
      };
    } else {
      fixes.faqSchema = {
        type: "template",
        label: "FAQPage Schema Template — add your Q&As",
        code: `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Your first question here?",
      "acceptedAnswer": { "@type": "Answer", "text": "Your answer here." }
    },
    {
      "@type": "Question",
      "name": "Your second question here?",
      "acceptedAnswer": { "@type": "Answer", "text": "Your answer here." }
    }
  ]
}
<\/script>`,
        steps: ["Replace the sample Q&As with your actual FAQ content", "Go to WPCode → Add New Snippet → HTML Snippet", "Paste and set location to Footer → Activate"]
      };
    }
  }

  // HowTo Schema
  if (!data.schema.howTo) {
    const steps = extractHowToSteps($);
    const title = data.meta.h1.value || data.meta.title.value || "Guide";
    if (steps.length >= 2) {
      fixes.howToSchema = {
        type: "code",
        label: `HowTo JSON-LD — generated from ${steps.length} steps found on your page`,
        code: `<script type="application/ld+json">\n${JSON.stringify({ "@context": "https://schema.org", "@type": "HowTo", "name": title, "step": steps.map(s => ({ "@type": "HowToStep", "text": s.text })) }, null, 2)}\n<\/script>`,
        steps: ["Go to WPCode → Add New Snippet → HTML Snippet", "Paste the code", "Set location to Footer → Activate"]
      };
    } else {
      fixes.howToSchema = {
        type: "info",
        label: "HowTo Schema — Not needed unless page has step-by-step instructions",
        tip: "Add a numbered list (ol > li) for each step in your content, then re-audit to auto-generate the schema code."
      };
    }
  }

  // Title Fix
  if (!data.meta.title.ok) {
    const current = data.meta.title.value;
    const tooLong = data.meta.title.length > 60;
    let suggested = current;
    if (tooLong) {
      const words = current.split(" ");
      let s = "";
      for (const w of words) { if ((s + " " + w).trim().length <= 57) s = (s + " " + w).trim(); else break; }
      suggested = s || current.substring(0, 57);
    }
    fixes.metaTitle = {
      type: "suggestion",
      label: "Page Title Fix",
      current, currentLength: current.length,
      suggested: suggested.trim(), suggestedLength: suggested.trim().length,
      steps: ["Go to WordPress → Edit Post → Yoast SEO panel (bottom)", `In 'SEO Title' field, use: "${suggested.trim()}"`, "Keep your main keyword near the start", "Aim for 50–60 characters"]
    };
  }

  // Meta Description Fix
  if (!data.meta.metaDesc.ok) {
    const tooShort = data.meta.metaDesc.length < 120;
    fixes.metaDesc = {
      type: "suggestion",
      label: "Meta Description Fix",
      current: data.meta.metaDesc.value || "(none found)",
      currentLength: data.meta.metaDesc.length,
      tooShort,
      steps: tooShort
        ? ["Go to Yoast SEO → Meta Description field", "Write 120–160 chars that answer the page's core question", "Start with the key answer or benefit", "Include your main keyword naturally"]
        : ["Shorten your meta description to 120–160 characters", "Keep the most important info at the start"]
    };
  }

  // H1 Fix
  if (!data.meta.h1.exists) {
    const suggested = (data.meta.title.value || "").split(" ").slice(0, 8).join(" ");
    fixes.h1 = {
      type: "suggestion",
      label: "Add H1 Heading",
      suggested,
      steps: ["In WordPress, the post Title field is usually your H1", "If not showing, add a Heading block set to H1 at top of content", `Suggested H1: "${suggested}"`, "Make sure only ONE H1 exists on the page"]
    };
  }

  // Concise Paragraph Fix
  if (data.conciseParagraphs.length === 0) {
    const topic = data.meta.h1.value || data.meta.title.value || "this topic";
    fixes.conciseAnswer = {
      type: "template",
      label: "Add a Featured Snippet Paragraph (40–60 words)",
      example: `[${topic}] is [brief definition]. [Explain the core concept in 1–2 simple sentences]. This is important because [key reason]. [End with one practical example or takeaway that directly answers what the user is looking for].`,
      steps: ["Add this paragraph near the TOP of your article (before other sections)", "Keep total word count between 40–60 words", "Answer the main question directly — no introduction fluff", "Use simple, everyday words"]
    };
  }

  // Readability Fix
  const fk = data.readability.grade;
  if (fk > 12) {
    fixes.readability = {
      type: "tips",
      label: `Writing Simplification Tips — Current Grade ${fk} → Target Grade 8–10`,
      tips: [
        "Break long sentences: if a sentence has more than 20 words, split it into two",
        "Use simple words: 'utilize' → 'use', 'subsequently' → 'then', 'approximately' → 'about'",
        "Use active voice: 'The team fixed it' not 'It was fixed by the team'",
        "Add bullet points to break up long paragraphs",
        "Start sentences with simple words: 'You', 'This', 'It', 'Here'"
      ]
    };
  }

  // Question Headings Fix
  if (data.questionHeadings === 0) {
    const topic = data.meta.h1.value || data.meta.title.value || "your topic";
    fixes.questionHeadings = {
      type: "examples",
      label: "Convert Your Headings to Questions",
      examples: [
        `What is ${topic}?`,
        `How does ${topic} work?`,
        `Why is ${topic} important?`,
        `When should you use ${topic}?`,
        `What are the main benefits of ${topic}?`
      ],
      steps: ["Edit your post in WordPress", "Change H2/H3 section titles to question format", "Each question should match real user search queries", "Keep questions natural and conversational"]
    };
  }

  return fixes;
}

function calculateScore(data) {
  let score = 0;
  if (data.conciseParagraphs.length > 0) score += 25;
  if (data.schema.faqPage) score += 20;
  if (data.schema.howTo)   score += 10;
  const fk = data.readability.grade;
  if (fk >= 6 && fk <= 12) score += 20;
  else if (fk > 4) score += 10;
  if (data.meta.title.ok)    score += 10;
  if (data.meta.metaDesc.ok) score += 5;
  if (data.meta.h1.exists)   score += 5;
  if (data.questionHeadings > 0) score += 5;
  return Math.min(100, score);
}

function generateRecommendations(data, score) {
  const recs = [];
  if (data.conciseParagraphs.length === 0) recs.push({ priority: "high", icon: "✦", title: "Add Featured Snippet Paragraphs", detail: "Write 2–3 paragraphs with exactly 40–60 words. AI engines extract these as direct answers.", fixKey: "conciseAnswer" });
  if (!data.schema.faqPage) recs.push({ priority: "high", icon: "✦", title: "Implement FAQPage Schema Markup", detail: "Add JSON-LD FAQPage schema — the #1 signal for AI answer engines.", fixKey: "faqSchema" });
  if (!data.schema.howTo)   recs.push({ priority: "medium", icon: "◈", title: "Add HowTo Schema", detail: "If your page has step-by-step instructions, add HowTo JSON-LD schema.", fixKey: "howToSchema" });
  const fk = data.readability.grade;
  if (fk > 12) recs.push({ priority: "high", icon: "✦", title: `Simplify Writing (FK Grade: ${fk})`, detail: "Text is too complex. Voice search targets Grade 8–10.", fixKey: "readability" });
  else if (fk < 6) recs.push({ priority: "medium", icon: "◈", title: `Deepen Content (FK Grade: ${fk})`, detail: "Content may be too simplistic. Aim for Grade 6–10.", fixKey: "readability" });
  if (!data.meta.title.ok)    recs.push({ priority: "medium", icon: "◈", title: "Optimize Page Title Length", detail: `Title is ${data.meta.title.length} chars. Target 40–60.`, fixKey: "metaTitle" });
  if (!data.meta.metaDesc.ok) recs.push({ priority: "medium", icon: "◈", title: "Fix Meta Description", detail: `Description is ${data.meta.metaDesc.length} chars. Target 120–160.`, fixKey: "metaDesc" });
  if (!data.meta.h1.exists)   recs.push({ priority: "medium", icon: "◈", title: "Add Primary H1 Heading", detail: "No H1 found. Every AEO page needs a clear H1.", fixKey: "h1" });
  if (data.questionHeadings === 0) recs.push({ priority: "low", icon: "◇", title: "Use Question-Based Subheadings", detail: "Rephrase H2/H3 as questions to match voice search queries.", fixKey: "questionHeadings" });
  if (score >= 85) recs.push({ priority: "low", icon: "◇", title: "Consider Speakable Schema", detail: "Add Speakable schema to mark sections for Google Assistant.", fixKey: null });
  return recs;
}

app.post("/api/audit", async (req, res) => {
  let { url } = req.body;
  if (!url || typeof url !== "string") return res.status(400).json({ error: "Please provide a valid URL." });
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try { new URL(url); } catch { return res.status(400).json({ error: "Invalid URL format." }); }

  try {
    const response = await axios.get(url, {
      timeout: 12000, maxRedirects: 5,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AEO-Checker/1.0)", "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.5" },
      validateStatus: s => s < 400,
    });

    const html = response.data;
    const $ = cheerio.load(html);
    const bodyText = extractText($);
    if (bodyText.length < 100) return res.status(422).json({ error: "Could not extract meaningful content." });

    const conciseParagraphs = checkConciseAnswers($);
    const schema = checkSchema(html, $);
    const fkGrade = fleschKincaidGrade(bodyText);
    const meta = checkMetaTags($);
    const questionHeadings = checkQuestionContent($);
    const wordCount = bodyText.split(/\s+/).filter(w => w.length > 0).length;

    const auditData = { url, conciseParagraphs, schema, readability: { grade: fkGrade }, meta, questionHeadings, wordCount };
    const score = calculateScore(auditData);
    const recommendations = generateRecommendations(auditData, score);
    const fixes = generateFixes(auditData, $);

    const grade =
      score >= 85 ? { label: "Excellent", color: "#00d4a0" } :
      score >= 65 ? { label: "Good",      color: "#f0b429" } :
      score >= 40 ? { label: "Fair",      color: "#f06449" } :
                   { label: "Poor",       color: "#e63757" };

    return res.json({
      success: true, url, score, grade,
      checks: {
        conciseAnswer:    { passed: conciseParagraphs.length > 0, value: conciseParagraphs.length, detail: `${conciseParagraphs.length} paragraph(s) in 40–60 word range`, samples: conciseParagraphs.slice(0, 2) },
        faqSchema:        { passed: schema.faqPage, detail: schema.faqPage ? "FAQPage JSON-LD detected" : "No FAQPage schema found" },
        howToSchema:      { passed: schema.howTo,   detail: schema.howTo   ? "HowTo JSON-LD detected"   : "No HowTo schema found" },
        readability:      { passed: fkGrade >= 6 && fkGrade <= 12, value: fkGrade, detail: `Flesch-Kincaid Grade: ${fkGrade} (target 6–10)` },
        metaTitle:        { passed: meta.title.ok,    value: meta.title.length,   detail: `Title: "${meta.title.value.substring(0,60)}${meta.title.value.length>60?"…":""}" (${meta.title.length} chars)` },
        metaDesc:         { passed: meta.metaDesc.ok, value: meta.metaDesc.length, detail: `Meta description: ${meta.metaDesc.length} chars (target 120–160)` },
        h1:               { passed: meta.h1.exists,   detail: meta.h1.exists ? `H1: "${meta.h1.value.substring(0,60)}"` : "No H1 heading found" },
        questionHeadings: { passed: questionHeadings > 0, value: questionHeadings, detail: `${questionHeadings} question-based heading(s) found` },
      },
      stats: { wordCount },
      recommendations,
      fixes,
    });
  } catch (err) {
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") return res.status(502).json({ error: "Could not connect to the URL." });
    if (err.code === "ETIMEDOUT" || err.code === "ECONNABORTED") return res.status(504).json({ error: "Request timed out." });
    if (err.response?.status === 403 || err.response?.status === 401) return res.status(403).json({ error: "Access denied by target server." });
    if (err.response?.status === 404) return res.status(404).json({ error: "Page not found (404)." });
    console.error("Audit error:", err.message);
    return res.status(500).json({ error: "An unexpected error occurred." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ AEO Checker running → http://localhost:${PORT}`));
