# AEO Checker — Answer Engine Optimization Auditor

Audit any webpage to measure how well it's optimized for AI search engines
(Perplexity, ChatGPT Search) and Voice Assistants (Siri, Alexa, Google Assistant).

---

## What It Checks

| Check | Weight | Details |
|---|---|---|
| Concise Answer Paragraphs | 25% | Paragraphs of 40–60 words (featured snippet sweet spot) |
| FAQPage Schema | 20% | JSON-LD FAQPage structured data |
| Readability (FK Grade) | 20% | Flesch-Kincaid grade 6–10 targets voice search |
| HowTo Schema | 10% | JSON-LD HowTo structured data |
| Page Title | 10% | Title 40–60 characters |
| Meta Description | 5% | Description 120–160 characters |
| H1 Heading | 5% | Primary heading present |
| Question Headings | 5% | H2/H3 phrased as questions |

Score Range: 0–100  
85–100 = Excellent · 65–84 = Good · 40–64 = Fair · 0–39 = Poor

---

## Requirements

- **Node.js** v16 or higher  
- **npm** v7 or higher

---

## Installation & Running Locally

```bash
# 1. Clone or unzip the project
cd aeo-checker

# 2. Install dependencies
npm install

# 3. Start the server
node server.js
# → Server running at http://localhost:3000

# 4. Open in your browser
open http://localhost:3000
```

---

## Project Structure

```
aeo-checker/
├── server.js          # Express backend — all AEO analysis logic
├── package.json
└── public/
    └── index.html     # Frontend UI (single file, no build step)
```

---

## Configuration

Change the port by setting the `PORT` environment variable:

```bash
PORT=8080 node server.js
```

---

## Notes

- Some sites block automated requests (403 responses). This is expected.
- JavaScript-heavy SPAs may return limited content without a headless browser.
- All analysis runs server-side; no external APIs required.
