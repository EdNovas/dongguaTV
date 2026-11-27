'use strict';
// 🧬 模型「系列」的总评(站长后台「AI 模型」页的推荐理由 + 新版本的估计评级)。
//   依据:2026-11-26 的 12 模型 × 25 场景实测 + 后续「记错细节」说法的补测(见 bench-seed.json)。
//   同一系列出了新版本,一般和老版本差别不大:没测过的新模型先按「同系列里实测最好的那个」估计评级(标「按同系列估计」),
//   站长点「快速测评」后就以实测为准。哪天某个系列的新版本差别很大,改这张表即可。
//
//   tier:1 = 首选,2 = 后备 / 备选,3 = 不推荐 / 不适合,4 = 认不出系列(排最后);est = 系列里一个都没测过时的估计分(文字 / 截图,0~100)
//   顺序有讲究:先匹配的先算(SEA-LION 是 Gemma 改的,要排在 Gemma 前面)
const FAMILIES = [
    // 写代码的专用版(qwen2.5-coder 之类):影视知识弱,别按同系列聊天模型估计
    { key: 'coder', re: /coder|codellama|deepseek-math|-math-/i, label: '代码 / 数学专用模型', tier: 3, verdict: '不适合找片',
        reason: '专门写代码 / 做题的版本,影视知识弱;别按同系列的聊天模型来估' },
    { key: 'glm', re: /^@cf\/zai-org\/glm-/i, label: '智谱 GLM', tier: 1, verdict: '文字找片首选',
        reason: '用户记错细节的描述也能认对(补测 8/8)、中位约 1 秒;不认截图;思考关不掉要多给 token;偶尔胡答,已自动换下一个模型重问', est: { text: 88 } },
    { key: 'deepseek-flash', re: /^@cf\/deepseek-ai\/deepseek-v[\d.]+-flash/i, label: 'DeepSeek Flash', tier: 1, verdict: '截图找片首选 · 文字备用',
        reason: '认截图最准(8/10)、约 1.4 秒、便宜;文字比 GLM 差一点(记错细节 6/8);开思考会慢到 6~25 秒,一定要关', est: { text: 80, image: 80 } },
    { key: 'deepseek', re: /^@cf\/deepseek-ai\//i, label: 'DeepSeek(其它)', tier: 2, verdict: '备选',
        reason: 'pro / R1 蒸馏这类是思考型,慢;找片用 Flash 版就够', est: { text: 70 } },
    { key: 'sea-lion', re: /sea-lion/i, label: 'SEA-LION(Gemma 改版)', tier: 2, verdict: '便宜后备',
        reason: '在 Gemma 上为东南亚语言调过,中文片名认得还行、便宜;不认截图', est: { text: 70 } },
    { key: 'gemma', re: /^@cf\/google\/gemma-/i, label: 'Google Gemma', tier: 2, verdict: '便宜后备 · 免费额度',
        reason: '最便宜、不用付费版,免费额度能跑最多次;准确度差一档(漏开端 / 狂飙 / 流浪地球2),截图常认错;适合当兜底', est: { text: 65, image: 45 } },
    { key: 'qwen', re: /^@cf\/qwen\//i, label: '通义千问 Qwen', tier: 2, verdict: '备选',
        reason: '中文好、能看图,但同档里偏贵、首次调用慢;旧版本下架快(qwen3-30b 2026-11-20 已下架)', est: { text: 75, image: 60 } },
    { key: 'inkling', re: /inkling/i, label: 'Thinking Machines Inkling', tier: 2, verdict: '备选',
        reason: '准,但慢(中位 3 秒以上)、思考关不掉,长回答会被截断', est: { text: 75, image: 65 } },
    { key: 'kimi', re: /moonshot|kimi/i, label: 'Kimi', tier: 2, verdict: '备选',
        reason: '中文好;目录里的版本多是思考型、偏慢、要付费版', est: { text: 70 } },
    { key: 'gpt-oss', re: /gpt-oss/i, label: 'OpenAI gpt-oss', tier: 3, verdict: '不推荐',
        reason: '慢(中位 6 秒、最慢 20 秒以上),中文片名会编(「重生之我在公交车上」)', est: { text: 55 } },
    { key: 'llama', re: /^@cf\/meta\/llama-/i, label: 'Meta Llama', tier: 3, verdict: '不推荐',
        reason: '中文片名常错(英文名对、中文名配错),JSON 不稳', est: { text: 45, image: 30 } },
    { key: 'mistral', re: /mistral/i, label: 'Mistral', tier: 3, verdict: '不推荐',
        reason: '中文片名错得多,输出格式不稳(三成不按要求)', est: { text: 40, image: 40 } },
    { key: 'clairic', re: /^@cf\/cloudflare\/(clairic|clef)/i, label: 'Cloudflare Clairic', tier: 3, verdict: '不适合找片',
        reason: '最快(约 0.4 秒),但不是聊天模型:只回一个片名,推荐只给一部,flash 版会编片名' },
    { key: 'whisper', re: /^@cf\/openai\/whisper/i, label: 'OpenAI Whisper', tier: 1, verdict: '语音识别首选',
        reason: 'large-v3-turbo 中文识别准、1~4 秒、每分钟约 $0.0005;老 whisper 慢、只收字节数组' },
    { key: 'deepgram', re: /deepgram/i, label: 'Deepgram', tier: 3, verdict: '暂不支持',
        reason: '请求格式不一样还没接;价格约是 Whisper 的 10 倍' },
    { key: 'vision-small', re: /llava|moondream|uform|resnet/i, label: '看图小模型', tier: 3, verdict: '不适合找片',
        reason: '只会描述图片内容,不认得是哪部片' },
];
const OTHER = { key: 'other', label: '其它(没测过的系列)', tier: 4, verdict: '没测过', reason: '这几个系列还没测过,想用的话先点「测评」看看' };

function familyOf(name) {
    const n = String(name || '');
    return FAMILIES.find((f) => f.re.test(n)) || OTHER;
}
const pub = (f) => ({ key: f.key, label: f.label, tier: f.tier, verdict: f.verdict, reason: f.reason });

module.exports = { FAMILIES, OTHER, familyOf, pub };
