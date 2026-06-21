/**
 * 教科書「要約するとき」に基づく評価軸
 * 「アップとルーズで伝える」の要約採点用
 */

const EVALUATION_AXES = [
  {
    id: "core_selection",
    name: "要点の選択",
    description:
      "段落や部分の中心となる文・くり返し出る言葉（アップ・ルーズ）を使って、大切な情報を選べているか",
    textbookRef: "説明する文章を要約するとき：中心となる文・くり返し出る言葉",
  },
  {
    id: "clarity",
    name: "知らない人への伝わりやすさ",
    description:
      "「アップとルーズで伝える」を読んでいない人にも、内容が正しく・わかりやすく伝わるか",
    textbookRef: "知らない人にも正しく内容が伝わるようにする",
  },
  {
    id: "objectivity",
    name: "事実と感想の区別",
    description:
      "元の文章の内容と、自分の感想・意見を分けられているか",
    textbookRef: "要約した部分と自分の感想・意見を区別する",
  },
  {
    id: "structure",
    name: "構成・文のつながり",
    description:
      "文同士が論理的につながっており、アップとルーズのちがいや筆者の主張が伝わるか",
    textbookRef: "文同士が論理的につながっているか確かめる",
  },
];

const GRADE_DESCRIPTIONS = {
  A: "とてもよくできている！このままがんばろう",
  B: "よくできている。少し直すともっとよくなるよ",
  C: "がんばっているね。足りないところを直そう",
  D: "もう一度、中心となる文を考えて書き直してみよう",
};

function buildSystemPrompt(sourceText) {
  const axisList = EVALUATION_AXES.map(
    (a, i) => `${i + 1}. ${a.name}（id: ${a.id}）：${a.description}`
  ).join("\n");

  const keyPointsList = sourceText.keyPoints
    .map((p, i) => `${i + 1}. ${p}`)
    .join("\n");

  return `あなたは日本の小学校4年生の国語の先生です。
子どもが書いた「${sourceText.title}」（${sourceText.author}）の要約（ようやく）を、教科書「要約するとき」の基準でやさしく評価してください。

【もとの文章のタイトル】${sourceText.title}（${sourceText.author}）

【もとの文章の要点】
${keyPointsList}

【もとの文章 全文】
${sourceText.body}

【評価軸】（各軸をA/B/C/Dで評価。axes配列にはこの4つすべてを含める）
${axisList}

【評価のポイント】
- 小4の子どもにわかるやさしい言葉でフィードバックする
- 各評価軸ごとに、よかった点（goodPoints）と直した方がよい点（improvePoints）を1〜2文ずつ書く
- 全体評価（overallGrade）は各軸を総合してA/B/C/Dで決める
- 修正例（improvedSummary）は、もとの文章の内容をもとに、子どもが書きやすい自然な要約文にする
- 修正例は100字程度を目安にするが、内容の正確さを優先する
- 感想だけの要約は低評価にする

必ず以下のJSON形式のみで返答してください（他の文字は含めない）:
{
  "overallGrade": "A",
  "overallComment": "全体のコメント（2〜3文）",
  "axes": [
    {
      "id": "評価軸のid",
      "name": "評価軸の名前",
      "grade": "A",
      "goodPoints": "よかった点",
      "improvePoints": "直した方がよい点"
    }
  ],
  "improvedSummary": "修正例の要約文",
  "characterCount": 95
}`;
}

module.exports = {
  EVALUATION_AXES,
  GRADE_DESCRIPTIONS,
  buildSystemPrompt,
};
