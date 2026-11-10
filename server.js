require("dotenv").config();

const express = require("express");
const path = require("path");
const OpenAI = require("openai");
const {
  EVALUATION_AXES,
  GRADE_DESCRIPTIONS,
  buildSystemPrompt,
  judgeLength,
} = require("./evaluation-criteria");
const { SOURCE_TEXT } = require("./source-text");

const app = express();
const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT_MS = 120000;
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const MAX_ATTEMPTS = 4;

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
      maxRetries: 0,
    })
  : null;

let apiKeyStatus = {
  checked: false,
  valid: false,
  error: null,
  networkIssue: false,
};

function isNetworkError(err) {
  const message = err.error?.message || err.message || "";
  return (
    message.includes("Premature close") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    err.code === "ETIMEDOUT" ||
    err.code === "ECONNRESET"
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createCompletionWithRetry(params) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await openai.chat.completions.create(params);
    } catch (err) {
      lastError = err;
      const retryable = isNetworkError(err) || err.status === 429;
      console.error(
        `OpenAI attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
        err.status || err.code,
        err.error?.message || err.message
      );
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      await sleep(1000 * attempt);
    }
  }

  throw lastError;
}

async function validateApiKey() {
  if (!openai) {
    apiKeyStatus = {
      checked: true,
      valid: false,
      error: "OPENAI_API_KEY is not set",
      networkIssue: false,
    };
    return;
  }

  try {
    await openai.models.list();
    apiKeyStatus = {
      checked: true,
      valid: true,
      error: null,
      networkIssue: false,
    };
    console.log("OpenAI API key validation: OK");
  } catch (err) {
    const message = err.error?.message || err.message;
    const networkIssue = isNetworkError(err);
    apiKeyStatus = {
      checked: true,
      valid: !networkIssue && err.status !== 401 && err.status !== 403,
      error: message,
      networkIssue,
    };
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
    networkIssue: apiKeyStatus.networkIssue,
    model: OPENAI_MODEL,
    apiKeyPrefix: OPENAI_API_KEY ? OPENAI_API_KEY.slice(0, 8) + "..." : null,
  });
});

app.get("/api/info", (_req, res) => {
  res.json({
    title: SOURCE_TEXT.title,
    author: SOURCE_TEXT.author,
    targetLength: SOURCE_TEXT.targetLength,
    axes: EVALUATION_AXES,
    gradeDescriptions: GRADE_DESCRIPTIONS,
  });
});

// 評価はA/B/Cの3段階。万一Dなどが返ってきたらCに丸める
function normalizeGrade(grade) {
  const g = String(grade || "").trim().toUpperCase();
  if (g === "A" || g === "B") return g;
  return "C";
}

const ELEMENT_IDS = ["current_state", "generalization", "author_claim"];

/**
 * ルーブリックに沿って全体評価を決める（AIの軸ごとの評価＋字数判定から機械的に決定）
 *  - ①現状・危機 または ③筆者の主張 がC → C
 *  - 字数が大幅に過不足 → C
 *  - 字数が少し過不足 → B（上限）
 *  - ①②③すべてA かつ ④がC以外 → A、それ以外 → B
 */
function computeOverallGrade(axes, lengthStatus, fallback) {
  const byId = Object.fromEntries((axes || []).map((a) => [a.id, a.grade]));
  if (ELEMENT_IDS.some((id) => !byId[id])) return fallback;

  if (byId.current_state === "C" || byId.author_claim === "C") return "C";
  if (lengthStatus === "far") return "C";
  if (lengthStatus === "near") return "B";

  const allElementsA = ELEMENT_IDS.every((id) => byId[id] === "A");
  if (allElementsA && byId.structure_length !== "C") return "A";
  return "B";
}

/**
 * 修正例が目安の字数から外れていたら、1回だけ書き直しをたのむ
 */
async function fitImprovedSummary(summary, targetLength) {
  const { min, max } = targetLength;
  const len = (summary || "").length;
  if (!summary || (len >= min && len <= max)) return summary;

  try {
    const completion = await createCompletionWithRetry({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: `あなたは小学校4年生の国語の先生です。次の「${SOURCE_TEXT.title}」の要約文を、内容を保ったまま、必ず${min}字以上${max}字以下に書き直してください。${len < min ? "3つの必須要素（工芸品のよさと現状の危機、具体例からの一般化、筆者の主張）がそれぞれ1〜2文になるように、ていねいに言葉を足してください。" : "大事な内容を残して、言葉を削ってください。"}小4が書く自然な文章にし、感想は入れないでください。
必ず {"improvedSummary": "..."} のJSONのみで返答してください。`,
        },
        { role: "user", content: summary },
      ],
      temperature: 0.4,
      response_format: { type: "json_object" },
    });
    const fixed = parseAiJson(completion.choices[0]?.message?.content || "{}");
    if (fixed.improvedSummary && typeof fixed.improvedSummary === "string") {
      return fixed.improvedSummary;
    }
  } catch (err) {
    console.error("Improved summary rewrite failed:", err.message);
  }
  return summary;
}

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
  if (isNetworkError(err)) {
    return "OpenAIへの接続が途切れました。10秒ほど待ってからもう一度お試しください。";
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
  if (
    apiKeyStatus.checked &&
    !apiKeyStatus.valid &&
    !apiKeyStatus.networkIssue
  ) {
    return res.status(500).json({
      error: `OpenAI APIキーが無効です。Renderの OPENAI_API_KEY を確認してください。`,
    });
  }

  const submittedCount = summaryText.trim().length;
  const lengthJudgement = judgeLength(submittedCount, SOURCE_TEXT.targetLength);

  const userMessage = `【子どもが書いた要約】
${summaryText.trim()}

【要約の字数】${submittedCount}字
【字数判定】${lengthJudgement.label}`;

  try {
    const completion = await createCompletionWithRetry({
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
    result.overallGrade = normalizeGrade(result.overallGrade);
    const axisDefs = Object.fromEntries(EVALUATION_AXES.map((a) => [a.id, a]));
    result.axes = (result.axes || []).map((axis) => {
      const def = axisDefs[axis.id] || {};
      return {
        ...axis,
        name: def.name || axis.name,
        part: def.part || "",
        check: def.check || "",
        grade: normalizeGrade(axis.grade),
      };
    });
    result.aiOverallGrade = result.overallGrade;
    result.overallGrade = computeOverallGrade(
      result.axes,
      lengthJudgement.status,
      result.overallGrade
    );
    result.improvedSummary = await fitImprovedSummary(
      result.improvedSummary,
      SOURCE_TEXT.targetLength
    );
    result.characterCount = (result.improvedSummary || "").length;
    result.submittedCharacterCount = submittedCount;
    result.lengthStatus = lengthJudgement.status;
    result.lengthLabel = lengthJudgement.label;
    result.targetLength = SOURCE_TEXT.targetLength;
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
