const summaryText = document.getElementById("summaryText");
const evaluateBtn = document.getElementById("evaluateBtn");
const charCount = document.getElementById("charCount");
const loading = document.getElementById("loading");
const results = document.getElementById("results");
const errorBox = document.getElementById("error");
const gradeBadge = document.getElementById("gradeBadge");
const overallComment = document.getElementById("overallComment");
const axesResults = document.getElementById("axesResults");
const improvedSummary = document.getElementById("improvedSummary");
const improvedMeta = document.getElementById("improvedMeta");

const REQUEST_TIMEOUT_MS = 90000;

function updateCharCount() {
  charCount.textContent = `${summaryText.value.length}字`;
}

summaryText.addEventListener("input", updateCharCount);

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
  results.classList.add("hidden");
}

function hideError() {
  errorBox.classList.add("hidden");
}

function renderAxisCard(axis) {
  const card = document.createElement("div");
  card.className = "axis-card";
  card.innerHTML = `
    <div class="axis-header">
      <span class="axis-name">${escapeHtml(axis.name)}</span>
      <span class="axis-grade grade-${axis.grade}">${axis.grade}</span>
    </div>
    <p class="axis-good">${escapeHtml(axis.goodPoints)}</p>
    <p class="axis-improve">${escapeHtml(axis.improvePoints)}</p>
  `;
  return card;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function renderResults(data) {
  gradeBadge.textContent = data.overallGrade;
  gradeBadge.className = `grade-badge grade-${data.overallGrade}`;
  overallComment.textContent = data.overallComment;

  axesResults.innerHTML = "";
  (data.axes || []).forEach((axis) => {
    axesResults.appendChild(renderAxisCard(axis));
  });

  improvedSummary.textContent = data.improvedSummary || "";
  improvedMeta.textContent = `修正例：${data.characterCount || data.improvedSummary?.length || 0}字　／　あなたの要約：${data.submittedCharacterCount}字`;

  results.classList.remove("hidden");
  results.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

evaluateBtn.addEventListener("click", async () => {
  hideError();

  if (!summaryText.value.trim()) {
    showError("要約を入力してください");
    return;
  }

  evaluateBtn.disabled = true;
  loading.classList.remove("hidden");
  results.classList.add("hidden");

  try {
    const res = await fetchWithTimeout("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summaryText: summaryText.value }),
    });

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error("サーバーからの応答を読み取れませんでした");
    }

    if (!res.ok) {
      throw new Error(data.error || "評価に失敗しました");
    }

    renderResults(data);
  } catch (err) {
    if (err.name === "AbortError") {
      showError("評価に時間がかかりすぎました。もう一度お試しください。");
    } else {
      showError(err.message);
    }
  } finally {
    evaluateBtn.disabled = false;
    loading.classList.add("hidden");
  }
});

updateCharCount();
