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
const REQUEST_TIMEOUT_MS = 90000;
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

function cleanApiKey(key) {
  if (!key) return "";
  return key.trim().replace(/^\uFEFF/, "").replace(/^["']|["']$/g, "");
}

const OPENAI_API_KEY = cleanApiKey(process.env.OPENAI_API_KEY);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const openai = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 2,
    })
  : null;

let apiKeyStatus = {
  checked: false,
  valid: false,
  error: null,
};

async function validateApiKey() {
  if (!openai) {
    apiKeyStatus = {
      checked: true,
      valid: false,
      error: "OPENAI_API_KEY is not set",
    };
    return;
  }

  try {
    await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: "user", content: "OK" }],
      max_tokens: 5,
    });
    apiKeyStatus = { checked: true, valid: true, error: null };
    console.log("OpenAI API key validation: OK");
  } catch (err) {
    const message = err.error?.message || err.message;
    apiKeyStatus = { checked: true, valid: false, error: message };
    console.error("OpenAI API key validation: FAILED", err.status, message);
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    apiKeyConfigured: Boolean(OPENAI_API_KEY),
    apiKeyValid: apiKeyStatus.valid,
    apiKeyChecked: apiKeyStatus.checked,
    apiKeyError: apiKeyStatus.error,
    model: OPENAI_MODEL,
    apiKeyPrefix: OPENAI_API_KEY ? OPENAI_API_KEY.slice(0, 8) + "..." : null,
  });
});

app.get("/api/info", (_req, res) => {
  res.json({
    title: SOURCE_TEXT.title,
    author: SOURCE_TEXT.author,
    axes: EVALUATION_AXES,
    gradeDescriptions: GRADE_DESCRIPTIONS,
  });
});

function parseAiJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("AIの回答を読み取れませんでした");
  }
}

function toUserError(err) {
  const status = err.status || err.response?.status;
  const code = err.code || err.error?.code;
  const apiMessage = err.error?.message || err.message;

  if (status === 401) {
    return "APIキーが正しくありません。Renderの環境変数 OPENAI_API_KEY を確認してください。";
  }
  if (status === 429) {
    return "ただいま混み合っています。30秒ほど待ってからもう一度お試しください。";
  }
  if (status === 402 || code === "insufficient_quota") {
    return "OpenAIの利用上限に達しています。APIの残高を確認してください。";
  }
  if (code === "ETIMEDOUT" || apiMessage?.includes("timeout")) {
    return "評価に時間がかかりすぎました。もう一度お試しください。";
  }
  if (apiMessage === "AIの回答を読み取れませんでした") {
    return apiMessage;
  }
  if (apiMessage?.includes("model") && status === 404) {
    return `モデル「${OPENAI_MODEL}」が使えません。OPENAI_MODEL を gpt-4o-mini に設定してください。`;
  }
  if (apiMessage && !apiMessage.includes("sk-")) {
    return `評価エラー: ${apiMessage}`;
  }

  return "評価中にエラーが発生しました。もう一度お試しください。";
}

app.post("/api/evaluate", async (req, res) => {
  const { summaryText } = req.body;

  if (!summaryText?.trim()) {
    return res.status(400).json({ error: "要約を入力してください" });
  }
  if (!openai) {
    return res
      .status(500)
      .json({ error: "OpenAI APIキーが設定されていません" });
  }
  if (apiKeyStatus.checked && !apiKeyStatus.valid) {
    return res.status(500).json({
      error: `OpenAI APIキーに問題があります: ${apiKeyStatus.error}`,
    });
  }

  const userMessage = `【子どもが書いた要約】
${summaryText.trim()}

【要約の字数】${summaryText.trim().length}字`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
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

    const result = parseAiJson(content);
    result.submittedCharacterCount = summaryText.trim().length;
    result.sourceTitle = SOURCE_TEXT.title;
    result.gradeDescriptions = GRADE_DESCRIPTIONS;

    res.json(result);
  } catch (err) {
    console.error(
      "Evaluation error:",
      err.status || err.code,
      err.error?.message || err.message
    );
    res.status(500).json({ error: toUserError(err) });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Sumarin app running on port ${PORT}`);
  console.log(`OpenAI model: ${OPENAI_MODEL}`);
  console.log(
    `OpenAI API key: ${OPENAI_API_KEY ? OPENAI_API_KEY.slice(0, 8) + "..." : "NOT SET"}`
  );
  validateApiKey();
});
