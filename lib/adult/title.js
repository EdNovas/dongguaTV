// [adult] 成人站片名身份识别:番号 / 归一化键 / 净标题 / 标题键 / 演员 / 版本标记,以及搜索词变体与作品键。
//
// 调研 analysis/out/title-parse.mjs 的 CommonJS 移植 + 加固(占位番号黑名单、可信番号判定、查询解析、繁简标题键)。
//
// 公共 API:
//   parseTitle(name, typeName?, opts?) → {      opts: { actor?: vod_actor 字符串/数组(资源站自己标的演员,用来证实名字) }
//       code:      展示番号 'SSIS-001' / '300MAAN-1007' / 'FC2-PPV-1234567' / 'CARIB-032826-001' / 'MD-0315' / null
//       key:       归一化键(跨站合并用):JAV = 厂牌(去掉数字前缀)+'-'+数字补到 ≥3 位('SSIS-001','MAAN-1007');
//                  国产厂牌 = 前缀+'-'+数字补到 ≥4 位('MD-0315','TMW-0038');FC2-<n>;HEYZO-<4位>;KBJ-<n>;
//                  日期式无码:知道片商 'CARIB-032826-001' / '1PON-092926-001',不知道 'UNC-032826-001'
//       kind:      'jav'|'jav-cid'|'cn'|'fc2'|'heyzo'|'uncen-date'|'tokyohot'|'h4610'|'kbj'|'west-date'|null
//       label:     厂牌前缀('SSIS','MD','FC2'…)| null
//       placeholder: 占位番号(2609 系 AI 改标题反复贴的 JUL-123 / SSNI-789 / FC2-PPV-123456 / CAMP-001 / YUA-001 / 3GU-105 …)
//       suspect:   番号可疑(占位;非日本分类里的日本番号;国产分类里的未知厂牌;低置信)
//       cleanTitle(p2:另去 上传者/平台/片商前缀 ED MOSAIC- / KU【】/ myfans… / Onlyfans / 香蕉视频. / 色控 . / [独家] / 【日本无码】 /
//                  02月24日售价…RMB,尾巴 ED MOASIC / (8V) / 未知演员 / -cd2 / -全大写缩写;去完剩不到 2 个字就不去),
//       titleKey(NFKC + 繁转简 + 小写 + 去标点/空白/版本噪声词;永不为空串,除非原名为空)
//       actress:   只给有把握的名字(结构化尾巴里的非纯汉字名 / 日文名形状"汉字姓+假名名" / opts.actor 证实的);
//                  #标签、【】括号词、拉丁 handle、纯汉字名只进 actressGuess(p6);吃瓜/探花/主播/自拍类一律 []
//       actressGuess: 猜测(纯汉字候选、"名字 -番号" 前缀里的纯汉字名…)—— 只给搜索/AVDB 对照用,前端绝不显示
//       actressConfident: actress.length > 0(有没有可以显示的名字)
//       flags: { uncensored, chineseSub, leak, clip, uhd }
//              leak = 日本有码片的"无码流出/破解/UNCENSORED-LEAK/-U"版本(作品键加 #U 用);
//                     私人视频泄露(网曝/黑料)不是这个标记,那归 policy.checkItem 硬过滤
//              clip = 解说/水果派/预告/片段(标题信号;按时长判 #clip 由调用方决定)
//       studio, alt[]  (附加:片商名 / 标题里其余候选番号)
//   }
//   codeOk(parsed, {siteTrust = true} = {}) → boolean
//       有番号 && 非占位 && 非可疑 && 厂牌在白名单(JAV 厂牌 + 国产厂牌;FC2/HEYZO/东京热/H4610/知道片商的日期式无码按结构认)
//       && siteTrust !== false(s36 极品这种整站随机编番号的站传 false)
//   searchVariants(query) → {kind:'code', key, variants:[带横杠, 不带横杠]} | {kind:'text', variants:[q, 简体(q)?]}
//       番号查询只发两种写法,绝不发光秃秃的厂牌前缀(旧 generateSearchKeywords('SSIS-001') 会拆出 'SSIS' 把整个厂牌拉回来)
//   workKey(parsed, {siteTrust?, codeOk?, dur?} = {}) → 'c:'+key(+'#U' 无码流出/破解版)| 't:'+titleKey
//       code 段:番号形状可信(非占位/非可疑/站点可信)才用;'#clip' 由调用方按时长追加;dur 目前不参与键
//       codeOk:true/false 可强制指定是否用番号
//   titleKey(text) / t2s(text) / isJavLabel(L) / isCnPrefix(P) / PLACEHOLDER_KEYS
'use strict';

const { t2s } = require('./t2s');

// ---------- 词典 ----------
// 国产厂牌番号前缀 → 厂牌(键为大写;91CM 之类带数字前缀的整体作键)
const CN_PREFIX = {
    MD: '麻豆传媒', MDX: '麻豆传媒', MDL: '麻豆传媒', MDSR: '麻豆传媒', MDSJ: '麻豆传媒', MDAG: '麻豆传媒', MDWP: '麻豆传媒', MDHT: '麻豆传媒', MDHS: '麻豆传媒',
    MDCM: '麻豆传媒', MDUS: '麻豆传媒', MDS: '麻豆传媒', MSD: '麻豆传媒', MAD: '麻豆传媒', MKY: '麻豆传媒', MKYNC: '麻豆传媒', MPG: '麻豆传媒', MDJ: '麻豆传媒', CUS: '麻豆传媒',
    TM: '天美传媒', TMW: '天美传媒', TMG: '天美传媒', TMP: '天美传媒', TMQ: '天美传媒', TMBC: '天美传媒', TMTC: '天美传媒', TML: '天美传媒', TMY: '天美传媒',
    PM: '蜜桃传媒', PMC: '蜜桃传媒', PME: '蜜桃传媒', PMX: '蜜桃传媒', PMS: '蜜桃传媒', PMTC: '蜜桃传媒', PMA: '蜜桃传媒', PMD: '蜜桃传媒',
    XK: '星空传媒', XKG: '星空传媒', XKQP: '星空传媒', XKVP: '星空传媒', XKTC: '星空传媒', XKXB: '星空传媒', XKTY: '星空传媒', XKYP: '星空传媒', XKTV: '星空传媒',
    JD: '精东影业', JDSY: '精东影业', JDMY: '精东影业', JDBC: '精东影业', JDXYX: '精东影业', JDAV: '精东影业', JDTY: '精东影业', JDKR: '精东影业', JDYL: '精东影业', JDYP: '精东影业',
    '91CM': '果冻传媒/91制片厂', '91KCM': '果冻传媒/91制片厂', '91MS': '91制片厂', GDCM: '果冻传媒', KCM: '果冻传媒', CM: '果冻传媒/91制片厂',
    RAS: '皇家华人', HJ: '皇家华人', DA: '大象传媒', ID: '爱豆传媒', IDG: '爱豆传媒', WY: '乌鸦传媒', TZ: '兔子先生', PH: '色控传媒', HUL: '葫芦影业',
    XSJ: '性视界', XSJKY: '性视界', XSJTC: '性视界', SAT: 'SA国际', SAQP: 'SA国际', QD: '起点传媒', QDOG: '起点传媒', FSOG: 'QQ传媒/扣扣传媒', QQOG: 'QQ传媒/扣扣传媒', QQCM: 'QQ传媒/扣扣传媒',
    LY: '绝对领域', MMZ: '猫爪影像', BA: 'mini传媒', MINI: 'mini传媒', ZMY: '周慕云', HSM: '杏吧/黄色仓库', MTVQ: '麻豆MTV', YCM: '原创', XB: '杏吧原创', VLOGTX: '糖心Vlog', TXVLOG: '糖心Vlog',
    XJX: '香蕉秀', LB: '乐播传媒', DAD: '大鸟十八', WMOG: '微密圈', EMX: '爱神传媒', EMKY: '爱神传媒', EMTC: '爱神传媒', TWAV: '台湾AV', MCY: '麻豆传媒', SWAG: 'SWAG',
};
// JAV 厂牌 → 片商(只用于展示;是否可信看 JAV_LABELS 白名单)
const JAV_PREFIX = {
    SSIS: 'S1', SSNI: 'S1', SONE: 'S1', OFJE: 'S1', SNIS: 'S1', SIVR: 'S1',
    MIDV: 'MOODYZ', MIDE: 'MOODYZ', MIAA: 'MOODYZ', MIDA: 'MOODYZ', MIFD: 'MOODYZ', MIMK: 'MOODYZ', MIRD: 'MOODYZ', MIAB: 'MOODYZ', MIZD: 'MOODYZ', MDVR: 'MOODYZ',
    IPX: 'IdeaPocket', IPZ: 'IdeaPocket', IPZZ: 'IdeaPocket', IPTD: 'IdeaPocket', IPVR: 'IdeaPocket',
    ABP: 'Prestige', ABW: 'Prestige', ABF: 'Prestige', CHN: 'Prestige', TEM: 'Prestige', PPT: 'Prestige', AOI: 'Prestige',
    STARS: 'SOD Create', START: 'SOD Create', STAR: 'SOD Create', SDDE: 'SOD Create', SDJS: 'SOD Create', SDMU: 'SOD Create', SDNM: 'SOD Create', SDAB: 'SOD Create', SDHS: 'SOD Create', SDMF: 'SOD Create', DSOD: 'SOD Create',
    JUL: 'Madonna', JUQ: 'Madonna', JUY: 'Madonna', JUX: 'Madonna', ROE: 'Madonna', OBA: 'Madonna', URE: 'Madonna', JUTA: 'Madonna',
    ATID: 'Attackers', RBD: 'Attackers', SHKD: 'Attackers', ADN: 'Attackers', SAME: 'Attackers', JBD: 'Attackers', RBK: 'Attackers',
    EBOD: 'E-BODY', EYAN: 'E-BODY', MKCK: 'E-BODY', JUFE: 'Fitch', JUFD: 'Fitch', CAWD: 'kawaii', KAWD: 'kawaii', KWBD: 'kawaii',
    PRED: 'PREMIUM', PGD: 'PREMIUM', PBD: 'PREMIUM', WANZ: 'WANZ', DASS: 'DAS', DASD: 'DAS', DAZD: 'DAS', HND: 'Honnaka', HNDS: 'Honnaka', HMN: 'Honnaka',
    MEYD: 'Tameike Goro', MKMP: 'K.M.Produce', MDON: 'K.M.Produce', XVSR: 'MAX-A', PPPE: 'OPPAI', PPPD: 'OPPAI', JUR: 'Madonna', NSFS: 'Nagae Style', MUDR: 'Muku', REAL: 'K.M.Produce',
    HUNTC: 'Hunter', HUNTB: 'Hunter', HUNTA: 'Hunter', DVAJ: 'Alice Japan', FSDSS: 'FALENO', FTHT: 'FALENO', DLDSS: 'DAHLIA', MVSD: 'M\'s video', MVG: 'M\'s video', JYMA: 'JYMA',
    KAGP: 'Kagekiha', ROYD: 'ROYAL', MIKR: 'MOODYZ', ENDX: 'Hamesasu', REBD: 'Rebecca', MRSS: 'MARRION', NACR: 'Planet Plus', SMBD: 'S Model (uncensored)', YMDS: 'Yamato',
    GVH: 'Glory Quest', GVG: 'Glory Quest', HONB: 'Honnaka', BONY: 'BONY', VEC: 'Venus', VENU: 'Venus', VENX: 'Venus', ALDN: 'Takara', KSBJ: 'K.M.Produce', SNOS: 'S1',
    MAAN: 'Prestige Premium', LUXU: 'LUXU TV', GANA: 'Nampa TV', SIRO: 'Shiroto TV', ARA: 'ARA', DCV: 'DCV', MIUM: 'Prestige Premium', NTK: 'Nanpa', SCUTE: 'S-Cute',
    DVEL: 'Alice Japan', DUIB: 'Takara', DVKA: 'Alice Japan', XJX: 'Korean?', ORECO: 'ORECO', NIMA: 'Tameike Goro', MILK: 'Milk', DNIN: 'Dandy', OFES: 'S1',
};
// 白名单补充:常见真实 JAV 厂牌(调研 JAV_PREFIX 只有 129 个,样本里 40% 的日本番号不在其中)。
// 来源 = 公知的大厂牌 + 样本 items.jsonl 里"带假名标题或日本分类、≥2 个后端/≥2 个不同编号、非可疑"的厂牌(人工过目去掉英文单词)。
// 漏收只会让该厂牌的片被当作"没有可信番号"(审查级 code 的分类藏起来、不进日本行),是 fail-closed 方向。
// 最后一行(NACT…MOOR)按同一标准从实际爬取的目录补:假名标题、≥2 个后端、≥2 个不同编号、不是英文单词(2026-11 复核)。
const JAV_LABELS_EXTRA = (
`SOE ONED MIGD MIAD MIDD MIBD MDYD MIQD IPSD IPIT IDBD SUPD
ABS BGN DOCP EDD ESK GETS JBS KBI MAS MBM MGT SGA TRD TUS YRH WPS FTN GZAP PRBY
JAC SIMM SUKE MFC KNB NMCH
SDMM SDTH SDNT SDEN SDSI KIRE KMHR KMHRS MOGI NYH FSET SVDVD SVS SVND HYPN IENF IENE IESP NHDTA NHDTB NHDTC HSODA SETM CLUB RCT RCTD DANDY DNJR HUNBL OKS OKB OKP OKAX
JUSD JUC JUFW MADM ATKD ADVO EBWH FPRE FSKT JUNY KWSD PRTD PJD PXD DASM
HNDB HNKY HODV HOMA HMPD BAZX XRW RKI MDTM SCOP PPSD PPBD NSPS
MUKD MUKC MUCD MUFR MUKA MUCH DVDES DVDMS DVMM FLNS FCDSS MVBD REBDB NACX NASH NASK
GVRD RVG GG VEMA VAGU VDD MBYD TKD DANUHD HZGD NKKD TPPN CJOD BBAN BBTU BLK KIBD KTRA KTKZ KTDS YMDD SKMJ DOKS CEMD DTT BF
JRZE JRZD NNPJ NPJS NEWM HAWA HBAD HTHD APAA APAK APNS APKH AP AVOP AVSA ARM ARMG AUKG BBI BIJN EKDV EMBM EMBZ GIGL GHKO GTJ HAVD HOKS
JKSR JUMP KMDS KRND LAFBD MCSR MDBK MSFH NATR NDRA NEO NFDM NGOD NTRD OYC PARATHD PKPD SQTE SW TYOD UMSO VOTAN VRTM WAAA MXGS MOND MKBD
MNGS MOON OFSD FOCS JURA MRFK FNS SPSF HEZ YSN MIST KAM AVS DXUA DZHM GOUL TOTTE HUBLK IKHR PAIS OPG MMMB MFYD MOPT OAE AGEMIX DUPT MCBD PFES MMB NXG
SPZ SSPD OKG MGOLD KATU FCDC PDVMM CHRV XMOM CHUC MSAJ UPSM TPIN USAG WAWA MKD OLM OKK ODVHJ HMP YAB SABA SBMO HJMO FJIN OIGS FCP HWD HVG NMSL DSJH
DUT DSS SGSR CVDX ACZD DVRT MRHP MIMA MIHA KAGN KAAD REXD MOPP MOOC MLP MLMM MIBB MGMQ ONEX OKC NVH ONSG EROFV DWPV CWPBD SCR UMD AQSH DUSA WNZ DRS
BND PARM CAWB VSPDS SQSG SOAN
NACT KNMB MKON MMPB NAAC MMRAA MYBA MMBF DOCD MMGH MOOR
`
).trim().split(/\s+/);
const JAV_LABELS = new Set(Object.keys(JAV_PREFIX).concat(JAV_LABELS_EXTRA));

const STOP = new Set(['MP', 'CD', 'VOL', 'NO', 'EP', 'PART', 'DAY', 'TOP', 'BBC', 'COS', 'ASMR', 'VR', 'HD', 'FHD', 'UHD', 'SD', 'AV', 'AI', 'GPT', 'IPHONE', 'VLOG', 'SP', 'PPV', 'FC', 'JK', 'OL',
    'SM', 'CB', 'OF', 'KTV', 'DJ', 'DVD', 'BD', 'SEX', 'HOT', 'THE', 'MOM', 'SCENE', 'SEASON', 'SE', 'FT', 'MV', 'PS', 'WEB', 'UP', 'BEST', 'EPISODE', 'BATCH', 'WORLD', 'IMG', 'MIX', 'PAGE', 'NEW',
    'COVID', 'MAX', 'TV', 'GB', 'MB', 'KB', 'FPS', 'P', 'K', 'H', 'X', 'Y', 'YEAR', 'NUMBER', 'TWITTER', 'ONLYFANS', 'TIKTOK', 'QQ', 'VX', 'WX', 'ID_', 'GIRL', 'BOY', 'MISS', 'PLAY', 'LOVE', 'ROOM',
    'AGE', 'BBW', 'MILF', 'POV', 'JOI', 'BJ', 'CEO', 'NTR', 'MAN', 'MEN', 'ETC', 'MM', 'KK', 'DD', 'SS', 'RR', 'WO', 'MY', 'NS', 'AK', 'BS', 'MS', 'GS', 'XXX', 'LINE', 'APP', 'NBA', 'CBA', 'UFC', 'PK',
    'MP4', 'MKV', 'AVI', 'H264', 'H265', 'HEVC', 'X264', 'X265', 'HDR', 'SDR', 'HOME', 'GONE', 'KOKO']);
// 两个字母的前缀默认不认(Vol 2 / Top 10 之类),这些除外
const SHORT_OK = new Set(['MD', 'TM', 'PM', 'JD', 'PH', 'DA', 'LY', 'BA', 'RD', 'AP', 'XK', 'ID', 'TZ', 'HJ', 'QD', 'WY', 'LB', 'MN', 'GU', 'KD', 'DY', 'ZMY', 'CM', 'XB', 'GG', 'BF', 'SW']);
const PLACEHOLDER_ACTOR = /^(未知(演员|女优)?|内详|暂无|素人|自动采集|国产素人|欧美素人|佚名|不详|无|未知|unknown|n\/?a|其他|群星|网友|网红|主播|.*素人.*)$/i;

// 占位番号(键):2609 系(乐播/番号/辣椒/鲨鱼/大地)把它们贴在时长各异的无关视频上
const PLACEHOLDER_KEYS = new Set(['JUL-123', 'SSNI-123', 'SSNI-666', 'SSNI-888', 'SSNI-789', 'FC2-123456', 'CAMP-001', 'YUA-001', 'GU-105', 'ABC-123', 'ABP-123']);
// FC2 编号是"凑数"形状(123456 / 1234567 / 000000)也当占位。日本厂牌不套这条:样本里 FSDSS-888 / YSN-666 / DSOD-111 / HMN-888
// 都是多站时长一致的真片,真正被滥用的只有上面黑名单里那几个
const PLACEHOLDER_NUM = /^0*(?:123|1234|12345|123456|1234567|12345678)$|^(\d)\1{2,}$/;

const UNC_STUDIO = [
    { re: /carib(?:bean)?(?:com)?(?:pr)?|カリビアン|加勒比/i, id: 'CARIB', sep: '-' },
    { re: /1\s?pondo|一本道|\b1pon\b/i, id: '1PON', sep: '_' },
    { re: /paco(?:paco)?mama|パコパコママ|\bpaco\b/i, id: 'PACO', sep: '_' },
    { re: /10\s?musume|天然むすめ/i, id: '10MU', sep: '_' },
    { re: /muramura|ムラムラ/i, id: 'MURA', sep: '_' },
    { re: /\bH0930\b|エッチな0930/i, id: 'H0930', sep: '-' },
];
const UNC_NAME = { CARIB: 'Caribbeancom', '1PON': '1Pondo', PACO: 'Pacopacomama', '10MU': '10musume', MURA: 'Muramura', H0930: 'H0930' };

const MAX_LEN = 400;   // vod_name 超长(有站把简介塞进片名)时只看前 400 字,正则全是线性的,这里再保一道

function decodeEntities(s) {
    let prev;
    let n = 0;
    do { prev = s; s = s.replace(/&amp;/gi, '&'); } while (s !== prev && ++n < 10);
    return s.replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
        .replace(/&#(\d{1,7});/g, (_, d) => { const c = +d; return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; });
}

function normalizeRaw(name) {
    let s = decodeEntities(String(name == null ? '' : name).slice(0, MAX_LEN)).normalize('NFKC');
    s = s.replace(/[\u200b-\u200f\ufeff\u2800]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/\s+new$/i, '');                                  // xrbsp/kxgav/msnii… 族的后缀
    s = s.replace(/^KU(?=[\u3400-\u9fff【[])/, '');                   // 同族上传者前缀
    s = s.replace(/^[a-z]{2,6}[1-9]\d{2,5}\s+(?=\S)/, '');           // "lyl98021 无码高清 ABP-601"
    return s.trim();
}

const padNum = (n, w) => { const v = String(parseInt(n, 10)); return v.length >= w ? v : v.padStart(w, '0'); };

// ---------- 番号候选 ----------
function findCodes(s, T) {
    const out = [];
    let m;
    const push = (o) => out.push(o);
    // FC2
    for (const r = /FC2[\s\-_]*(?:PPV)?[\s\-_]*(\d{5,8})(?!\d)/gi; (m = r.exec(s));) push({ kind: 'fc2', code: `FC2-PPV-${m[1]}`, key: `FC2-${m[1]}`, label: 'FC2', num: m[1], studio: 'FC2', i: m.index, len: m[0].length, pri: 10 });
    // HEYZO
    for (const r = /HEYZO[\s\-_]*(\d{3,4})(?!\d)/gi; (m = r.exec(s));) push({ kind: 'heyzo', code: `HEYZO-${padNum(m[1], 4)}`, key: `HEYZO-${padNum(m[1], 4)}`, label: 'HEYZO', num: padNum(m[1], 4), studio: 'HEYZO', i: m.index, len: m[0].length, pri: 10 });
    // Tokyo-Hot
    for (const r = /tokyo[\s\-_]*hot[\s\-_]*([a-z]{1,6}\d{3,5})/gi; (m = r.exec(s));) push({ kind: 'tokyohot', code: `TOKYOHOT-${m[1].toLowerCase()}`, key: `TH-${m[1].toLowerCase()}`, label: 'TOKYOHOT', studio: 'Tokyo-Hot', i: m.index, len: m[0].length, pri: 10 });
    // H4610 / C0930 / H0930 "H4610-ki230211"
    for (const r = /(?<![A-Za-z0-9])([HC]\d{4})[\s\-_~]*([a-z]{2,8}\d{3,7})(?![0-9])/gi; (m = r.exec(s));) push({ kind: 'h4610', code: `${m[1].toUpperCase()}-${m[2].toLowerCase()}`, key: `${m[1].toUpperCase()}-${m[2].toLowerCase()}`, label: m[1].toUpperCase(), studio: m[1].toUpperCase(), i: m.index, len: m[0].length, pri: 10 });
    // heydouga
    for (const r = /heydouga[\s\-_]*(\d{4})[\s\-_]*(?:PPV)?[\s\-_]*(\d{3,6})/gi; (m = r.exec(s));) push({ kind: 'uncen-date', code: `HEYDOUGA-${m[1]}-${m[2]}`, key: `HEYDOUGA-${m[1]}-${m[2]}`, label: 'HEYDOUGA', studio: 'Heydouga', i: m.index, len: m[0].length, pri: 10 });
    // KBJ(韩国 BJ 直播录屏)
    for (const r = /(?<![A-Za-z])kbj[\s\-_]*(\d{6,8})(?!\d)/gi; (m = r.exec(s));) push({ kind: 'kbj', code: `KBJ-${m[1]}`, key: `KBJ-${m[1]}`, label: 'KBJ', studio: 'KBJ', i: m.index, len: m[0].length, pri: 9 });
    // 日期式无码(Caribbeancom / 1pondo / pacopacomama / 10musume / muramura)
    let st = null;
    for (const u of UNC_STUDIO) if (u.re.test(s)) { st = u; break; }
    for (const r = /(?<!\d)(\d{6})(?:([\-_])(\d{2,3}))?(?!\d)/g; (m = r.exec(s));) {
        const [all, d6, sep, n] = m;
        const mm = +d6.slice(0, 2), dd = +d6.slice(2, 4);
        if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) continue;
        if (!st && (!n || n.length !== 3)) continue;                     // 没有片商词时必须是 MMDDYY-NNN
        const id = st ? st.id : (sep === '_' ? '1PON' : 'CARIB');        // 展示用猜测;键里不猜
        const s2 = st ? st.sep : sep;
        const nn = n ? (st && st.id === '10MU' ? n.slice(-2).padStart(2, '0') : n) : '';
        push({ kind: 'uncen-date', code: `${id}-${d6}${nn ? s2 + nn : ''}`, key: `${st ? st.id : 'UNC'}-${d6}${nn ? '-' + nn : ''}`, label: st ? st.id : 'UNC', studio: st ? UNC_NAME[st.id] : null, partial: !nn, i: m.index, len: all.length, pri: st ? 9 : 6 });
    }
    // 打包式 MMDDYYNNN "032826001 … 一本道"(只在有片商词或无码分类时认)
    if (st || /无码|無碼|無修正|无修正/.test(T)) {
        for (const r = /(?<!\d)(\d{6})(\d{3})(?!\d)/g; (m = r.exec(s));) {
            const mm = +m[1].slice(0, 2), dd = +m[1].slice(2, 4);
            if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) continue;
            const id = st ? st.id : 'UNC';
            const sp = st ? st.sep : '_';
            push({ kind: 'uncen-date', code: `${id}-${m[1]}${sp}${m[2]}`, key: `${id}-${m[1]}-${m[2]}`, label: id, studio: st ? UNC_NAME[st.id] : null, i: m.index, len: m[0].length, pri: st ? 9 : 7 });
        }
    }
    // 10musume 打包 "10musume04082501"
    for (const r = /10musume[\s\-_]*(\d{6})[\s\-_]?(\d{2})(?!\d)/gi; (m = r.exec(s));) push({ kind: 'uncen-date', code: `10MU-${m[1]}_${m[2]}`, key: `10MU-${m[1]}-${m[2]}`, label: '10MU', studio: '10musume', i: m.index, len: m[0].length, pri: 11 });
    // 欧美日期场景 "WIFEY2026-11-15" / "Brazzers.24.05.12"
    for (const r = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{2,30}?)[\s.\-_]*((?:19|20)\d\d)[\-._](\d\d)[\-._](\d\d)(?!\d)/g; (m = r.exec(s));) push({ kind: 'west-date', code: `${m[1].toUpperCase()}-${m[2]}-${m[3]}-${m[4]}`, key: `W-${m[1].toLowerCase()}-${m[2]}${m[3]}${m[4]}`, label: m[1].toUpperCase(), studio: m[1], i: m.index, len: m[0].length, pri: 4 });
    // DMM 内容 id:1iene00394, h_158tos00116, 436yab00101, aqsh00032
    for (const r = /(?<![A-Za-z0-9])(?:h_\d{2,4}|\d{1,3})?([a-z]{2,6})(0\d{4})(?![0-9a-z])/g; (m = r.exec(s));) {
        const L = m[1].toUpperCase();
        if (STOP.has(L) || /^(MP|CD|VOL|NO|EP|HD|FHD|SD|AV|TOP|PART|DAY|IPHONE)$/.test(L)) continue;
        const num = padNum(m[2], 3);
        push({ kind: 'jav-cid', code: `${L}-${num}`, key: `${L}-${num}`, label: L, num, studio: JAV_PREFIX[L] || null, i: m.index, len: m[0].length, pri: 7, conf: JAV_LABELS.has(L) ? 'high' : 'mid' });
    }
    // S-Model "MKBD-S102"
    for (const r = /(?<![A-Za-z0-9])([A-Z]{3,5})-S(\d{2,3})(?!\d)/g; (m = r.exec(s));) push({ kind: 'jav', code: `${m[1]}-S${m[2]}`, key: `${m[1]}-S${m[2]}`, label: m[1], studio: 'S Model', i: m.index, len: m[0].length, pri: 9, conf: 'high' });
    // 标准 字母-数字(JAV + 国产传媒)
    for (const r = /(\d{1,3})?([A-Za-z]{2,7})(\s?[\-_]\s?|\s)?(\d{2,5})(?![0-9])/g; (m = r.exec(s));) {
        r.lastIndex = m.index + 1;                                       // 允许重叠重试("Uncensored-858DOJN-021")
        let [all, pre, let_, sep, num] = m;
        let idx = m.index;
        let before = s[idx - 1] || '';
        if (pre && (/\d/.test(before) || /\d{4}-\d{2}-$/.test(s.slice(Math.max(0, idx - 8), idx)))) { idx += pre.length; all = all.slice(pre.length); before = pre.slice(-1); pre = undefined; } // "2024-09-28JKSR-656"
        if (/[0-9]/.test(before) && !pre && /\d{4}-\d{2}-\d{0,2}$/.test(s.slice(Math.max(0, idx - 10), idx))) before = '-';
        if (/[0-9]/.test(before) && !pre) continue;
        if (/[A-Za-z]/.test(before) || /[a-z][A-Z]/.test(let_)) {
            // 驼峰尾巴 "WildOneAIKAWO-011" → AIKAWO;否则是长单词的一部分
            const tm = /[A-Z]{2,7}$/.exec(let_);
            const prevCh = tm ? (tm.index > 0 ? let_[tm.index - 1] : before) : '';
            if (!(sep && /[\-_]/.test(sep) && tm && /[a-z]/.test(prevCh)) || pre) continue;
            idx += tm.index; all = all.slice(tm.index); let_ = tm[0];
        }
        const L = let_.toUpperCase();
        if (STOP.has(L)) continue;
        const hasSep = !!(sep && /[\-_]/.test(sep));
        const spaceSep = !!(sep && !hasSep);
        const upper = /^[A-Z]+$/.test(let_);
        const pfx = (pre || '') + L;
        const cnKnown = !!(CN_PREFIX[pfx] || CN_PREFIX[L]);
        const javKnown = JAV_LABELS.has(L);
        if (spaceSep && !(cnKnown || javKnown)) continue;              // "Vol 2" / "Top 10"
        if (!hasSep && !upper) continue;                                // 小写 handle:lucy2027 / lyl98021
        if (num.length === 2 && !(hasSep && (cnKnown || javKnown || (upper && L.length >= 3)))) continue;
        if (!hasSep && num.length < 3) continue;
        if (L.length === 2 && !hasSep && !cnKnown && !javKnown && !SHORT_OK.has(L)) continue;
        if (L.length === 2 && !cnKnown && !javKnown && !SHORT_OK.has(L) && num.length < 3) continue;
        if (/^(19|20)\d\d$/.test(num) && /^[\-._]\d\d[\-._]\d\d/.test(s.slice(idx + all.length))) continue;   // 日期
        if (/^[pPkK]/.test(s.slice(idx + all.length)) && /^(1080|720|480|2160|4|8)$/.test(num)) continue;     // 分辨率
        const after = s.slice(idx + all.length);
        // 后缀:-C / C / -UC / -U / A,B 分段 / -1 分段
        const sm = /^(?:[\-_]?(UC|U|CH|C)(?![A-Za-z0-9]))?(?:[\-_]?([AB])(?![A-Za-z0-9]))?(?:[\-_](\d)(?!\d))?/i.exec(after);
        const suf = sm ? sm[0] : '';
        const sub = sm && sm[1] ? sm[1].toUpperCase() : '';
        const isCn = cnKnown && !javKnown;
        const kind = isCn ? 'cn' : 'jav';
        let code, key, label;
        if (isCn) {
            label = CN_PREFIX[pfx] ? pfx : L;
            code = `${label}-${num.length >= 3 ? num : padNum(num, 3)}`;       // 国产展示保留原位数(MD-0315 / TMW-038)
            key = `${label}-${padNum(num, 4)}`;                                // 键统一补到 4 位:MD0315 / MD-315 / MD-0315 同键
        } else {
            label = L;
            const dispPre = pre && !/^0/.test(pre) ? pre : '';
            code = `${dispPre}${L}-${padNum(num, 3)}`;
            key = `${L}-${padNum(num, 3)}`;
        }
        const studio = CN_PREFIX[pfx] || CN_PREFIX[L] || JAV_PREFIX[L] || null;
        const conf = (cnKnown || javKnown) ? 'high' : (upper && L.length >= 3 && (hasSep || num.length >= 3) ? 'mid' : 'low');
        push({ kind, code, key, label, num, studio, i: idx, len: all.length + suf.length, pri: (cnKnown || javKnown) ? 8 : (hasSep ? 6 : 5), conf, sub, part: sm && (sm[2] || sm[3]) || '' });
    }
    return out;
}

function rankCodes(cands, cnType) {
    if (!cands.length) return [];
    // 被更高优先级候选完全覆盖的丢掉
    const keep = cands.filter((c) => !cands.some((o) => o !== c && o.pri > c.pri && o.i <= c.i && o.i + o.len >= c.i + c.len));
    keep.sort((a, b) => {
        const ka = (cnType && a.kind === 'cn' ? 2 : 0) + a.pri, kb = (cnType && b.kind === 'cn' ? 2 : 0) + b.pri;
        return kb - ka || a.i - b.i;
    });
    return keep;
}

// ---------- 演员 ----------
const KANA = /[\u3040-\u30ff]/;
const TAGWORD = /(主观|妹妹|事件|新人|推荐|首发|热瓜|极品|系列|合集|完整|无码|有码|中文|字幕|乱伦|高清|原版|流出|泄密|独家|最新|精选|国产|网红|主播|探花|吃瓜|黑料|反差|母狗|人妻|熟女|巨乳|美乳|御姐|少妇|嫩妹|学妹|校花|女神|白虎|萝莉|自拍|露脸|偷|约炮|口交|内射|中出|潮吹|颜射|调教|SM|性爱|做爱|啪啪|大秀|直播|裸聊|自慰|剧情|传媒|影业|出品|VR|4K|上集|下集|中集|第.|完结|番外|解说|新作|作品|福利|视频|私拍|全集|特辑|沦陷|淪陷|肉便器|淫水|狂喷|受罚|力荐|动漫|動漫|动画|ソープ|快感|内射|爆操|高潮|ベスト|BEST|時間|时间|分钟|小时|歳|岁|人|編|篇|集|話|话|版)/i;
function looksLikeName(t) {
    if (!t || t.length < 2 || t.length > 14) return false;
    if (/[0-9!！?？。，,：:（）()[\]【】「」『』《》~～…#@&+*=]/.test(t)) return false;
    if (TAGWORD.test(t)) return false;
    return /^[\u3400-\u9fff\u3040-\u30ffー・々A-Za-z .]+$/.test(t);
}
function extractActressRaw(s, codeEnd, codeSpan) {
    const out = [];
    // (a) 155/老色逼 结构化尾巴:"…有码2024-09-28JKSR-656春陽モカ" / "…未知演员"
    let m = /(?:有码|无码|無碼|有碼)?\d{4}-\d{2}-\d{2}[A-Z0-9]+-\d+(?:-C)?([^\d].*)$/.exec(s);
    if (m) {
        const tail = m[1].trim();
        if (!/未知演员/.test(tail)) for (const p of tail.split(/[,，、]/)) { const t = p.trim(); if (t && t.length <= 14) out.push([t, 'structured-tail']); }
        return out;
    }
    if (/未知演员/.test(s)) return out;
    // (b) "##仙儿媛#伊靖瑶" 话题标签
    for (const h of s.match(/#([^\s#]{2,10})/g) || []) { const t = h.slice(1); if (looksLikeName(t)) out.push([t, 'hashtag']); }
    // (c) "片名-名字" 后缀(横杠前必须有真标题文字,不能只是番号)
    m = /^(.*)[\-—－]\s?([^\-—－]{2,16})$/.exec(s);
    if (m) {
        let before = m[1];
        if (codeSpan) before = (s.slice(0, codeSpan[0]) + s.slice(codeSpan[1], m[1].length));
        before = stripPrefixes(before).replace(/[\s\p{P}\d]/gu, '');   // p2:横杠前只有上传者/片商前缀 = 后缀是片名,不是人名
        const t = m[2].trim();
        if (before.length >= 4 && (looksLikeName(t) || /^[A-Za-z][A-Za-z0-9_. ]{2,20}$/.test(t))) out.push([t, 'dash-suffix']);
    }
    // (d) "【handle】"(只认拉丁 handle;中文括号里多半是标签)
    for (const mm of s.matchAll(/【([A-Za-z][A-Za-z0-9_.-]{2,24})】/g)) if (!/^[A-Za-z]{2,7}-?\d{2,5}$/.test(mm[1]) && !/^(VR|HD|4K|FHD)$/i.test(mm[1])) out.push([mm[1], 'bracket-handle']);
    // (d2) 91md/hsck "厂牌.番号.演员.片名" 点分字段
    if (codeEnd != null) { const dm = /^\.([^.\s\d]{2,6})\./.exec(s.slice(codeEnd)); if (dm && looksLikeName(dm[1])) out.push([dm[1], 'structured-tail']); }
    // (e) 番号片名后面空格分隔的最后几个词:"… 千咲ちな"
    if (codeEnd != null && !out.some((x) => x[1] === 'dash-suffix')) {
        const toks = s.slice(codeEnd).trim().split(/\s+/);
        if (toks.length >= 2) {
            const names = [];
            for (let k = toks.length - 1; k >= 1 && names.length < 4; k--) {
                const t = toks[k];
                if (looksLikeName(t) && (KANA.test(t) || t.length <= 5)) names.unshift(t); else break;
            }
            for (const n of names) out.push([n, 'space-tail']);
        }
    }
    return out;
}
// 纯汉字(含 々)的名字:可能是标签、素人网名、或中文译名 —— 只当"猜测",要 vod_actor / 词典 / AVDB 确认才算(调研 verdict §6)
const KANJI_ONLY = /^[\u3400-\u9fff々\s·・.]+$/;
// 名字位置上的非人名:上传者/格式/分集/平台/片商词(目录里 "ED MOASIC""cd2""HMV""妄想族" 曾被当成演员)
const ACTOR_STOP = /^(?:ed ?mo(?:sa|as)ic|hmv|mmd|fantasy|vr|3d|ai|cos(?:play)?|asmr|pov|jav|av|hd|fhd|uhd|4k|uncensored|leak(?:ed)?|onlyfans|fansly|fansone|pornhub|twitter|tiktok|jvid|soop|afreeca(?:tv)?|chaturbate|stripchat|bongacams|milk|cd\s?\d*|part\s?\d*|ep\s?\d+|vol\.?\s?\d*|sp\d*|new|best)$/i;
const NOT_PERSON = /妄想族|工作室|传媒|傳媒|影业|影業|出品|字幕组|字幕組/;
function nameUsable(n) {
    const t = String(n || '').trim();
    if (!t || ACTOR_STOP.test(t) || NOT_PERSON.test(t) || /^[A-Z]{2,5}$/.test(t)) return false;
    if (KANJI_ONLY.test(t) && t.replace(/[\s·・.]/g, '').length > 6) return false;   // 7 个字以上的纯汉字串是片名碎片,不是名字
    if (/[\u3400-\u9fff\u3040-\u30ff]/.test(t) && t.replace(/[\s·・.]/g, '').length > 8) return false;
    return true;
}
// p6:长得像"汉字姓 + 假名名"、其实是题材/系列词或称呼的(覗き / 女のごほうび / 痴女ギャル / 玲衣さん)
const JP_NOT_NAME = /痴女|痴漢|覗|盗撮|爆乳|美脚|美尻|寝取|催眠|中出|素人|熟女|人妻|ギャル|ナース|メイド|ナンパ|マッサージ|エステ|コスプレ|オナニー|フェラ|パイズリ|レズ|ニューハーフ|ドキュメント|シリーズ|ベスト|天誅|お仕置|ごほうび|ご褒美/;
const HONORIFIC = /(?:さん|ちゃん|くん|さま|様|ママ|パパ)$/;
// 日文名形状:1-3 个汉字姓 + 1-5 个假名名(春陽モカ、天馬ゆい),至少 3 个字;"X の…"(女のごほうび)是短语不是名字
function jpNameShape(name) {
    return /^[\u4e00-\u9fff々]{1,3}[\u3040-\u30ffー]{1,5}$/.test(name) && [...name].length >= 3 && !/[なのをがはにでと]$/.test(name)
        && !/^[一-鿿]の/.test(name) && !HONORIFIC.test(name) && !JP_NOT_NAME.test(name);
}
function extractActress(s, codeEnd, codeSpan) {
    const hi = [], cand = [], how = [];
    for (const [name, h] of extractActressRaw(s, codeEnd, codeSpan)) {
        if (PLACEHOLDER_ACTOR.test(name) || !nameUsable(name)) continue;
        // 有把握(前端可显示)只有两种:站点结构化尾巴里的非纯汉字名(155 "…JKSR-656春陽モカ"),和番号片名后面 / 横杠后缀 / 名字-番号前缀里
        //   日文名形状的名字。其余一律只当猜测(vod_actor 证实了才升成有把握):
        //   p2:纯汉字名(155 尾巴的中文译名、#标签 里的素人网名);
        //   p6:#话题标签 和【】括号里的词(#覗き #ロー活女子 【Hololive】【某某Channel】多半是标签/上传者/频道/片商/作品系列),
        //       拉丁 handle(分不清是演员、上传者还是频道:FullPornNetwork / Anime / miuzxc)
        const tagLike = h === 'hashtag' || h === 'bracket-handle';
        const strong = !KANJI_ONLY.test(name) && !tagLike && !HONORIFIC.test(name) && !JP_NOT_NAME.test(name)
            && (h === 'structured-tail' || jpNameShape(name));
        if (strong) { hi.push(name.trim()); how.push(h); } else { cand.push(name.trim()); how.push(h + '?'); }
    }
    return { actress: [...new Set(hi)], cand: [...new Set(cand)], how };
}
// vod_actor(资源站自己标的演员)拆成名字;占位词("未知演员""素人"…)不要
function actorList(actor) {
    if (actor == null || actor === '') return [];
    const raw = Array.isArray(actor) ? actor.join(',') : String(actor);
    const out = [];
    for (const p of decodeEntities(raw.slice(0, 400)).normalize('NFKC').split(/[,，、/|;；]+/)) {
        const t = p.replace(/\s+/g, ' ').trim();
        if (t && t.length >= 2 && t.length <= 24 && !PLACEHOLDER_ACTOR.test(t) && nameUsable(t) && !/[0-9#@!?【】()<>《》:|]/.test(t) && !/[[\]\\]/.test(t)) out.push(t);
    }
    return out;
}

// ---------- 标记 ----------
// 流出 = 液体流出(精液流出/淫水流出来)时不算泄露
const FLUID_OUT = /(?:精液|液体|液體|淫水|白浆|白漿|爱液|愛液|蜜汁|精子|浓精|濃精|尿液|奶水|乳汁|[液浆漿精汁尿穴逼满滿道水])流出|流出(?:来|來|了|好多|大量|不止|不断)|流出的?(?:爱液|愛液|蜜液|淫液|淫水|精液|白浆|白漿|浓精|精子|液体|液體|蜜汁|汁液|[液浆漿汁尿奶血])/;
function flagsOf(s, T, best) {
    const f = { uncensored: false, chineseSub: false, leak: false, clip: false, uhd: false };
    const censoredKind = !!(best && /^(jav|jav-cid)$/.test(best.kind));
    if (/无码|無碼|無修正|无修正|uncensored|\buncen\b|【無】|\[无\]/i.test(s) || /无码|無碼/.test(T) || (best && /^(fc2|heyzo|uncen-date|tokyohot|h4610)$/.test(best.kind)) || (best && /^U/.test(best.sub || ''))) f.uncensored = true;
    if (/中文字幕|中字|【中文】|\[中文\]|字幕版|中文版|-中文/.test(s) || /中文|中字|字幕/.test(T) || (best && /^(C|CH|UC)$/.test(best.sub || ''))) f.chineseSub = true;
    // 日本有码片的无码化版本(厂商母带流出 / 破解 / AI 去码 / -U 后缀)
    if (/无码流出|無碼流出|无修正流出|無修正流出|uncensored[\s\-_]*leak|破解|去码|去碼|去马赛克|去馬賽克|马赛克破坏|reducing[\s\-_]*mosaic|AI修复|AI修復/i.test(s) || /破解|无码流出/.test(T)
        || (censoredKind && /^U/.test(best.sub || ''))
        || (censoredKind && /流出/.test(s) && !FLUID_OUT.test(s.replace(/无码流出|無碼流出/g, '')))) f.leak = true;
    if (f.leak) f.uncensored = true;
    if (/解说|解說|水果派|π\d{3}|预告|預告|片段|花絮|剪辑|剪輯|\btrailer\b|\bpreview\b/i.test(s) || /解说|解說/.test(T)) f.clip = true;
    if (/4K|2160[pP]/.test(s)) f.uhd = true;
    return f;
}

// ---------- 净标题 / 标题键 ----------
const JUNK = [/^\s*(新版破解|骑兵破解|破解版|无码高清|高清中文字幕|中文字幕|无码流出|無碼流出)\s*/g, /\s*(高清中文字幕|中文字幕|无码流出|無碼流出|母带字幕版|高清原版首发|高清原版|原版首发|首发|1080P原版|1080P|720P|4K预告片|完整版|高清|原版|全集)\s*/gi,
    /[（(]\s*\d+元\s*[)）]/g, /-?(中文字幕|无码|有码|流出)$/g, /\[(无码|有码|中文|無碼|无码流出)\]/g, /【(无码|有码|中文|無碼|中文字幕)】/g, /^[[【](?:无码|有码|中文)[\]】]\s*/g];
// p2:上传者/转载者/平台前缀与杂项 —— 从 items.jsonl + 目录 adult_items.name 的前后缀频率里挑出来的,只收"肯定不是片名"的部分
//   (ED MOSAIC- 上传者前缀 61+ 条、myfans 频道名、Onlyfans 平台词、[独家]/【日本无码】 这类推广/分类标签、"02月24日售价126RMB" 上传日期价签;
//    尾巴 ED MOASIC / (8V) 分集数 / 妄想族未知演员 / -封面 / x264)。去掉后剩不到 2 个字就不去(永不吃掉真片名)
const UPLOADER_PREFIX = [
    /^[[【]?ED\s?MO(?:SA|AS)IC\d{0,2}(?:-\d{1,2})?(?![A-Za-z])[\]】]?[\s\-—－–_.·:：]*/i,
    /^myfans[^\-—－–\s]{0,16}[\-—－–](?:[A-Za-z0-9_.]{2,24}[\-—－–])?/i,
    /^(?:onlyfans|fansone|fantia)(?![A-Za-z])[\s\-—－–_.·:：]*/i,
    /^[[【](?:独家|獨家|今日推荐|推荐|精品推荐|精选|首发|全网首发|热门|最新|新片|重磅|限免|免费)[\]】]\s*/,
    /^[[【](?:日本|國產|国产|欧美|歐美|韩国|韓國)?(?:无码|無碼|有码|有碼|无码破解|無碼破解|无码流出|無碼流出|中文字幕)[\]】]\s*/,
    /^\d{1,2}月\d{1,2}日售价\d+(?:RMB|元)?\s*/i,
];
//   "-cd2" 分碟、"-HZRK/-BDYJY" 这类全大写上传者缩写、"-妄想族/-某某工作室/-精品力荐/-动漫" 也是尾巴(原来被当成"演员名"切掉,现在演员名更严,单独切)
const UPLOADER_SUFFIX = [/\s*(?:ED\s?)?MO(?:SA|AS)IC$/i, /\s*\(\d+V\)$/i, /[-—\s]*(?:妄想族)?未知演员$/, /[-_\s](?:封面|x26[45]|h26[45])$/i,
    /\s*[-—－]\s*(?:cd\s?\d{1,2}|[A-Z]{2,5}|妄想族|[\u4e00-\u9fff]{1,6}工作室|精品力荐|动漫|動漫|fantasy)$/i];
// 片头的片商名(繁简都认;t2s 是逐字映射、长度不变,所以在简体上匹配、按长度切原文)
const STUDIO_PREFIX = /^(?:国产av\s*)?[[【]?(?:麻豆(?:映画)?传媒|蜜桃(?:影像)?传媒|皇家华人|天美传媒|星空(?:无限)?传媒|精东影业|果冻传媒|乌鸦传媒|大象传媒|爱豆传媒|qq传媒|凹凸传媒|兔子先生|性视界|香蕉视频|色控|sa国际|起点传媒|葫芦影业|海角社区|糖心vlog|杏吧|91制片厂|mini传媒|渡边传媒|涩会传媒)[\]】]?(?=[\s.·|:：\-—]|$)[\s.·|:：\-—]*|^(?:国产av\s*)?[[【](?:麻豆(?:映画)?传媒|蜜桃(?:影像)?传媒|皇家华人|天美传媒|星空(?:无限)?传媒|精东影业|果冻传媒|乌鸦传媒|大象传媒|爱豆传媒|qq传媒|凹凸传媒|兔子先生|性视界|香蕉视频|色控|糖心vlog|杏吧|91制片厂)[\]】]\s*/;
// 只去前缀(给演员抽取判断"横杠前面还有没有真片名"用;不管剩多少)
function stripPrefixes(x) {
    let out = String(x || '');
    for (const r of UPLOADER_PREFIX) out = out.replace(r, '');
    const m = STUDIO_PREFIX.exec(t2s(out).toLowerCase());
    if (m && m[0]) out = out.slice(m[0].length);
    return out;
}
// p12:片名最前面的一个【…】/ […] 标签(【捆绑调教】、[セブンエイト] 这类分类 / 上传者 / 厂牌标签)—— 同一部片别的站不带它,
//   不去掉两边片名键对不上、并不成一部(用户 2026-11-23 报:杏吧资源站「【捆绑调教】丝袜制服…」和极品资源「丝袜制服…」是两张卡)。
//   只去「像标签」的:2~10 个字、没有数字、不是集数 / 上下篇 / 预告花絮(那些是不同的片);去掉后至少还剩 6 个字
const TAG_PREFIX = /^[[【〖]\s*([^[\]【】〖〗\d０-９\n]{2,10}?)\s*[\]】〗]\s*/;
const EPISODE_TAG = /^(?:上|中|下|前篇|后篇|後篇|上集|中集|下集|上部|下部|上篇|下篇|完结|完結|终章|終章|续|續|续集|續集|番外|预告|預告|预告片|預告片|花絮|特辑|特輯|幕后|幕後|精华|精華|剪辑|剪輯)$|第.{1,4}[集部话話期季章篇卷回]|[集话話期季章卷回]$|part|ep\b|vol|解说|解說|合集|合輯|集锦|集錦|片段/i;   // 解说 / 合集 / 片段 是另一种片,和正片不是同一部
function stripTagPrefix(x) {
    const m = TAG_PREFIX.exec(x);
    if (!m || EPISODE_TAG.test(m[1].trim()) || visibleLen(m[1]) < 2) return x;
    const rest = x.slice(m[0].length);
    return visibleLen(rest) >= 6 ? rest : x;
}
function stripJunk(ct) {
    let out = ct;
    for (let k = 0; k < 3; k++) {
        const before = out;
        for (const r of UPLOADER_PREFIX) { const n = out.replace(r, ''); if (visibleLen(n) >= 2) out = n; }
        out = stripTagPrefix(out);
        const m = STUDIO_PREFIX.exec(t2s(out).toLowerCase());
        if (m && m[0] && visibleLen(out.slice(m[0].length)) >= 2) out = out.slice(m[0].length);
        for (const r of UPLOADER_SUFFIX) { const n = out.replace(r, ''); if (visibleLen(n) >= 2) out = n; }
        out = out.replace(/^[\s.\-_~·|:：]+/, '');
        if (out === before) break;
    }
    return out;
}
// 名字位置上常见的片商/分类词(t2s 后比较)
const NOT_NAME = /麻豆|天美|蜜桃|星空|精东|果冻|乌鸦|大象|爱豆|皇家|杏吧|糖心|香蕉|色控|视界|兔子|凹凸|葫芦|起点|渡边|涩会|国产|日本|欧美|韩国|无码|有码|中文|字幕|高清|最新|独家|精选|推荐|合集|系列|番号/;
const visibleLen = (x) => String(x).replace(/[\s\p{P}\p{S}]+/gu, '').length;
function titleKey(t) {
    let s = t2s(String(t == null ? '' : t).slice(0, MAX_LEN).normalize('NFKC')).toLowerCase();
    s = s.replace(/[\s\p{P}\p{S}]+/gu, '');
    s = s.replace(/(完整版|高清|原版|首发|无码|有码|中文字幕|中字|流出|全集|new|hd|1080p|720p|4k)/g, '');
    return s;
}
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CN_TYPE = /国产|传媒|麻豆|天美|蜜桃|星空|精东|大象|乌鸦|果冻|皇家|原创|华语|主播|探花|网红|自拍|吃瓜|黑料|网曝|反差|大秀|抖阴|海角|91视频|糖心/;
const NON_JAV_CTX = /欧美|西方|动漫|动画|漫|二次元|3d|同人|国产|主播|网红|自拍|探花|吃瓜|黑料|网曝|反差|大秀|裸聊|抖阴|直播|伦理|三级/;
const JAV_CTX = /日本|日韩|中文|有码|无码|av明星|女优|解说/;
// 这些分类 / 标题里的人名多半是素人或私人:不抽演员(调研 verdict §6)
const NO_ACTRESS_CTX = /吃瓜|黑料|网曝|网爆|门事件|曝光|泄密|探花|主播|直播|大秀|裸聊|自拍|偷拍|约炮|反差|海角|私房|私拍/;

function parseTitle(name, typeName, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const s = normalizeRaw(name);
    const T = t2s(String(typeName == null ? '' : typeName).normalize('NFKC')).toLowerCase();
    const cnType = CN_TYPE.test(T);
    const ranked = rankCodes(findCodes(s, T), cnType);
    const best = ranked[0] || null;
    let placeholder = false, suspect = false;
    if (best) {
        const numPart = best.num != null ? String(best.num) : '';
        if (PLACEHOLDER_KEYS.has(best.key) || PLACEHOLDER_KEYS.has(best.code) || (numPart && best.kind === 'fc2' && PLACEHOLDER_NUM.test(numPart))) placeholder = true;
        if (placeholder) suspect = true;
        if (best.kind === 'jav' && cnType && best.conf !== 'high') suspect = true;
        // 非日本分类(欧美/动漫/国产…)里的日本番号:2609 系 AI 改标题贴上去的
        if (/^(jav|jav-cid|fc2)$/.test(best.kind) && NON_JAV_CTX.test(T) && !JAV_CTX.test(T)) suspect = true;
        if (best.kind === 'jav' && best.conf === 'low') suspect = true;
    }
    const flags = flagsOf(s, T, best);
    // 片商
    let studio = best ? best.studio : null;
    if (!studio) {
        const sm = /(麻豆传媒|麻豆傳媒|麻豆映画|天美传媒|天美傳媒|蜜桃(?:影像)?传媒|星空(?:无限)?传媒|精东影业|大象传媒|乌鸦传媒|果冻传媒|91制片厂|皇家华人|糖心Vlog|糖心传媒|海角社区|杏吧|91视频|mini传媒|兔子先生|性视界|爱豆传媒|SA国际|色控|葫芦影业|ED ?MO(?:SA|AS)IC|JVID|凹凸传媒|QQ传媒|渡边传媒|起点传媒|涩会传媒|PsychoPorn|Pacopacomama|1Pondo|Caribbeancom|10musume|HEYZO|Tokyo-?Hot|Brazzers|BLACKED|VIXEN|TUSHY|ULTRAFILMS|RawCouples|FamilyStrokes|Onlyfans|OnlyFans|Stripchat|Chaturbate)/i.exec(s);
        if (sm) studio = t2s(sm[1]).replace(/映画|影像/, '').replace(/^ED ?MO.*$/i, 'ED Mosaic');
    }
    // 演员
    const codeEnd = best ? best.i + best.len : null;
    const s4a = s.replace(/[-—](无码|中文字幕|有码|流出)$/, '').replace(/\s*\(\d+\)$/, '').replace(/\s*\(\d+V\)$/, '');
    const ac = extractActress(s4a, codeEnd, best ? [best.i, best.i + best.len] : null);
    const noActress = NO_ACTRESS_CTX.test(T) || NO_ACTRESS_CTX.test(t2s(s));
    // 净标题
    let ct = s;
    // p2:"<片名><番号><片商名>未知演员"(155/老色逼 的另一种尾巴)—— 番号后面全是片商 + 占位演员,片名只到番号为止
    const tail155 = !!(best && /未知演员\s*$/.test(s) && !/(有码|无码|無碼|有碼)\d{4}-\d{2}-\d{2}/.test(s) && visibleLen(s.slice(0, best.i)) >= 4);
    // p2:"中山文香 -MIDV-968 片名" / "三枝れい-MILK-149 片名":番号前面只有一个名字 + 横杠 = 站点把演员名放在最前面
    let namePrefix = null;
    if (best && best.i > 0) {
        const pm = /^([^\s\-—－]{2,10})\s*[-—－]\s*$/.exec(s.slice(0, best.i));
        // 只认汉字/假名名(PACO-113024、X視界-XSJ134 这类是片商前缀,不是人名)
        if (pm && /^[\u3400-\u9fff\u3040-\u30ffー々・]{2,8}$/.test(pm[1]) && looksLikeName(pm[1]) && !PLACEHOLDER_ACTOR.test(pm[1]) && !NOT_NAME.test(t2s(pm[1]))) namePrefix = pm[1];
    }
    const cut = [];
    if (best) cut.push([best.i, best.i + best.len]);
    for (const c of ranked.slice(1)) if (c.key === (best && best.key) || c.i === 0 || c.conf === 'low') cut.push([c.i, c.i + c.len]);
    cut.sort((a, b) => b[0] - a[0]);
    let lastStart = Infinity;
    for (const [a, b] of cut) { if (b > lastStart) continue; ct = ct.slice(0, a) + ' ' + ct.slice(b); lastStart = a; }
    if (tail155) ct = s.slice(0, best.i);
    if (namePrefix) ct = ct.replace(new RegExp('^\\s*' + escRe(namePrefix) + '\\s*[-—－]\\s*'), '');
    if (/(有码|无码|無碼|有碼)\d{4}-\d{2}-\d{2}/.test(s)) ct = ct.replace(/(?:有码|无码|無碼|有碼)?\d{4}-\d{2}-\d{2}.*$/, '');
    ct = ct.replace(/~\s*[A-Z]?(-C)?\s*$/g, ' ').replace(/~\s*[A-Z]{2,6}-\d{2,5}[A-Z]?(-C)?/g, ' ');
    ct = ct.replace(/\b(Caribbeancom|Caribbean|1Pondo|Pacopacomama|10musume|Tokyo-?Hot|HEYZO)\b/gi, ' ').replace(/^\s*(?:PACO|CARIB|1PON|10MU|MURA)[\s\-_]+(?=\S)/i, '').replace(/[(（]\s*20\d{6}\s*[)）]/g, ' ');
    ct = ct.replace(/【\s*】|\[\s*\]|\(\s*\)|（\s*）/g, ' ');
    for (const r of JUNK) ct = ct.replace(r, ' ');
    ct = ct.replace(/【\s*】|\[\s*\]|\(\s*\)|（\s*）/g, ' ');   // 噪声词去掉后留下的空括号("【中文字幕】" → "【 】")
    const allNames = ac.actress.concat(ac.cand);
    if (ac.how.some((h) => h.startsWith('dash-suffix')) && allNames.length) {
        const dm = /[-—－]\s?([^-—－]{2,16})$/.exec(ct);
        if (dm && allNames.some((a) => a === dm[1].trim())) ct = ct.slice(0, dm.index);
    }
    for (let k = 0; k < 4; k++) for (const a of allNames) ct = ct.replace(new RegExp('\\s' + escRe(a) + '\\s*$'), '');
    ct = ct.replace(/^(?:麻豆(?:映画)?传媒|蜜桃影像传媒|皇家华人|國產AV 天美傳媒|国产AV 天美传媒|海角社区|糖心Vlog|杏吧)[.\s·]*/i, '');
    ct = stripJunk(ct.replace(/\s{2,}/g, ' ').trim());
    ct = ct.replace(/^[\s.\-_~·|:：]+|[\s.\-_~·|:：]+$/g, '').replace(/\s{2,}/g, ' ').trim();
    // 演员:有把握的(假名名 / 拉丁 handle / 结构化尾巴里的非纯汉字名)+ vod_actor 标的;纯汉字候选只当猜测,
    //   vod_actor 里也有同名的才升成有把握。吃瓜/探花/主播/自拍类一律不给
    const act = { sure: [], guess: [] };
    if (!noActress) {
        const actors = actorList(o.actor);
        const norm = (x) => t2s(String(x).normalize('NFKC')).toLowerCase().replace(/\s+/g, '');
        const credited = new Set(actors.map(norm));
        const addTo = (arr, n) => { if (n && !act.sure.concat(act.guess).some((x) => norm(x) === norm(n))) arr.push(n); };
        for (const n of ac.actress) addTo(act.sure, n);
        for (const n of actors) addTo(act.sure, n);
        const guesses = ac.cand.concat(namePrefix ? [namePrefix] : []);
        for (const n of guesses) {
            if (credited.has(norm(n)) || (namePrefix === n && !KANJI_ONLY.test(n) && [...n].length >= 3 && !HONORIFIC.test(n) && !JP_NOT_NAME.test(n))) addTo(act.sure, n);
        }
        for (const n of guesses) addTo(act.guess, n);
    }
    // 标题键永不为空(片名只有番号 / 全是噪声词时退回原名)
    let tk = titleKey(ct) || titleKey(s);
    if (!tk && s) tk = t2s(s).toLowerCase().replace(/\s+/g, '');
    return {
        code: best ? best.code : null,
        key: best ? best.key : null,
        kind: best ? best.kind : null,
        label: best ? (best.label || null) : null,
        placeholder,
        suspect,
        cleanTitle: ct,
        titleKey: tk,
        actress: act.sure,
        actressGuess: act.guess,
        actressConfident: act.sure.length > 0,
        flags,
        studio: studio || null,
        alt: ranked.slice(1).filter((c) => c.key !== (best && best.key)).map((c) => c.code),
    };
}

function isJavLabel(L) { return JAV_LABELS.has(String(L || '').toUpperCase()); }
function isCnPrefix(P) { return Object.prototype.hasOwnProperty.call(CN_PREFIX, String(P || '').toUpperCase()); }

// 番号可信:审查级 code 的分类放行、mixed/uncat 路由进日本行、番号作品合并,都看它
function codeOk(parsed, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (o.siteTrust === false) return false;
    if (!parsed || !parsed.code || !parsed.key) return false;
    if (parsed.placeholder || parsed.suspect) return false;
    const L = parsed.label || String(parsed.key).split('-')[0];
    switch (parsed.kind) {
        case 'jav': case 'jav-cid': return JAV_LABELS.has(L) || isCnPrefix(L);
        case 'cn': return isCnPrefix(L);
        case 'fc2': case 'heyzo': case 'tokyohot': case 'h4610': return true;
        case 'uncen-date': return !!UNC_NAME[L] && !/-\d{6}$/.test(parsed.key);   // 知道片商且不是半截日期
        default: return false;                                                     // kbj(直播录屏)/ west-date / 其他
    }
}

// ---------- 搜索词 ----------
function parseQueryCode(q) {
    const s = q.replace(/^[\s[【(（]+|[\s\]】)）]+$/g, '');
    let m;
    if ((m = /^fc2[\s\-_]*(?:ppv)?[\s\-_]*(\d{5,8})$/i.exec(s))) return { key: `FC2-${m[1]}`, variants: [`FC2-PPV-${m[1]}`, `FC2PPV${m[1]}`] };
    if ((m = /^heyzo[\s\-_]*(\d{3,4})$/i.exec(s))) { const n = padNum(m[1], 4); return { key: `HEYZO-${n}`, variants: [`HEYZO-${n}`, `HEYZO${n}`] }; }
    if ((m = /^kbj[\s\-_]*(\d{6,8})$/i.exec(s))) return { key: `KBJ-${m[1]}`, variants: [`KBJ-${m[1]}`, `KBJ${m[1]}`] };
    if ((m = /^(?:([a-z0-9]+?)[\s\-_]*)?(\d{6})[\-_](\d{2,3})$/i.exec(s))) {
        const p = parseTitle(s, '无码');
        if (p.kind === 'uncen-date') return { key: p.key, variants: [`${m[2]}-${m[3]}`, `${m[2]}_${m[3]}`] };
    }
    // 厂牌 + 编号(可带数字前缀与 -C/-UC/-U 后缀):整串必须就是番号
    if ((m = /^(\d{1,3})?([a-z]{2,8})[\s\-_]*(\d{2,6})(?:[\-_]?(?:uc|u|ch|c))?$/i.exec(s))) {
        const pre = m[1] || '', L = m[2].toUpperCase(), num = m[3];
        if (STOP.has(L)) return null;
        const cn = isCnPrefix(pre + L) || (isCnPrefix(L) && !JAV_LABELS.has(L));
        if (L.length === 2 && !cn && !JAV_LABELS.has(L) && !SHORT_OK.has(L)) return null;
        const digits = cn ? num : (num.length >= 3 ? num : padNum(num, 3));
        const dashed = `${pre}${L}-${digits}`;
        const p = parseTitle(dashed, cn ? '国产传媒' : '');
        const key = p.key || (cn ? `${isCnPrefix(pre + L) ? pre + L : L}-${padNum(num, 4)}` : `${L}-${padNum(num, 3)}`);
        return { key, variants: [dashed, `${pre}${L}${digits}`] };
    }
    return null;
}

function searchVariants(query) {
    const q = String(query == null ? '' : query).slice(0, 200).normalize('NFKC').replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    if (!q) return { kind: 'text', variants: [] };
    const c = parseQueryCode(q);
    if (c) return { kind: 'code', key: c.key, variants: c.variants };
    const v = [q];
    const s = t2s(q);
    if (s !== q) v.push(s);
    return { kind: 'text', variants: v };
}

// ---------- 作品键 ----------
function workKey(parsed, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!parsed) return 't:';
    const shapeOk = !!(parsed.code && parsed.key && !parsed.placeholder && !parsed.suspect && o.siteTrust !== false && parsed.kind !== 'west-date');
    const useCode = typeof o.codeOk === 'boolean' ? (o.codeOk && !!parsed.key) : shapeOk;
    if (useCode) {
        const u = parsed.flags && parsed.flags.leak && /^(jav|jav-cid)$/.test(parsed.kind) ? '#U' : '';
        return 'c:' + parsed.key + u;
    }
    return 't:' + (parsed.titleKey || '');
}

module.exports = {
    parseTitle,
    codeOk,
    searchVariants,
    workKey,
    titleKey,
    t2s,
    isJavLabel,
    isCnPrefix,
    PLACEHOLDER_KEYS,
    FLUID_OUT,
};
