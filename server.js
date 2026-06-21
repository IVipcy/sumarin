require("dotenv").config();

const express = require("express");
const path = require("path");
const OpenAI = require("openai");
const {
  EVALUATION_AXES,
  GRADE_DESCRIPTIONS,
  buildSystemPrompt,
} = require("./evaluation-criteria");
const { SOURCE_TEXT } = require("./source-text");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/info", (_req, res) => {
  res.json({
    title: SOURCE_TEXT.title,
    author: SOURCE_TEXT.author,
    axes: EVALUATION_AXES,
    gradeDescriptions: GRADE_DESCRIPTIONS,
  });
});

app.post("/api/evaluate", async (req, res) => {
  const { summaryText } = req.body;

  if (!summaryText?.trim()) {
    return res.status(400).json({ error: "要約を入力してください" });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res
      .status(500)
      .json({ error: "OpenAI APIキーが設定されていません" });
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const userMessage = `【子どもが書いた要約】
${summaryText.trim()}

【要約の字数】${summaryText.trim().length}字`;

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: buildSystemPrompt(SOURCE_TEXT) },
        { role: "user", content: userMessage },
      ],
      temperature: 0.4,
      response_format: { type: "json_object" },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("AIからの応答がありませんでした");
    }

    const result = JSON.parse(content);
    result.submittedCharacterCount = summaryText.trim().length;
    result.sourceTitle = SOURCE_TEXT.title;
    result.gradeDescriptions = GRADE_DESCRIPTIONS;

    res.json(result);
  } catch (err) {
    console.error("Evaluation error:", err.message);
    res.status(500).json({
      error: "評価中にエラーが発生しました。もう一度お試しください。",
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Sumarin app running on port ${PORT}`);
});
