// [adult] 内容硬过滤(不可配置、fail-closed)。入库 / 搜索 / 详情 / 历史 / 热门 / 收藏 每一层都对单个条目再查一遍。
//
// 硬拦(任何开关都关不掉):未成年 / 偷拍偷窥 / 迷奸下药 / 真人换脸 / 真人私密视频泄露(网曝·黑料·吃瓜·门事件)/ 人兽。
// 只按分类拦不够:允许的分类里抽样仍有 4.6% 条目命中(主播分类里的"学生妹"、AI短剧里的"高三"、"[换脸]"…),
// 所以 vod_name / vod_sub / vod_content / vod_blurb / type_name / vod_tag / vod_class / vod_remarks / vod_actor / vod_director / vod_area 全部要查。
//
// 公共 API:
//   RULES_VERSION                 规则指纹(POLICY_REV + taxonomy.json/policy.js/title.js 内容哈希):规则一改自动变,
//                                 进搜索/详情缓存键;变了要后台重扫 adult_items
//   checkQuery(q) → boolean       true = 拦截这个搜索词(未成年/偷拍/迷奸/换脸/泄露/人兽),在任何扇出之前调用,直接回空结果
//   checkItem(item, ctx?) → {ok, reason?, bucket, tags, review, code?, codeOk?}
//       item: maccms 原始字段(vod_name, vod_sub, vod_content, vod_blurb, type_name, vod_tag, vod_class, vod_remarks, vod_actor, vod_director, vod_area)
//       ctx:  { parentName?, siteKind?, cls?(buildClassMap 的一行,给了就不再按名字分类),
//               codeOk?: boolean(不给就用 title.codeOk(parseTitle(vod_name,type_name),{siteTrust}) 现算),
//               siteTrust?: boolean(s36 这种整站假番号的站传 false),
//               strict?: boolean(p5:db.json 里 strict:true 的站传 true,目前只有 爱播 s51;只认严格的 true) }
//       strict:每一条都按审查级 filter(FILTER_EXTRA 查全部字段,含简介);vod_class/vod_tag 逐 token 过分类体系(硬拦分类名 → 'category:…',
//              审查级并入);审查词查片名/副名/简介/备注,命中即 'review:hide';学生/学妹/少女/处女/初夜/18岁/cos… 一律 hide(有番号也藏);
//              占位番号(AI 改标题)/ 国产类简介是无关的生成叙述 → 'item:strict';
//              国产/主播 vod_class 里的日本番号不可信;Al某某/神似某某 → deepfake;私拍/原相机/投稿/良家/付费群… → leak;
//              大杂烩分类(mixed/uncat)按 vod_class 定大类、并上标签
//       codeOk:放行时给出政策实际采用的番号可信度(严格站可能比传进来的 ctx.codeOk 更严),作品键/日本行路由应该用它
//       ok=false 当:分类或任一祖先被硬过滤 → 'category:<原因>';条目文本命中硬拦词 → 'item:<minor|voyeur|drugging|deepfake|leak|bestiality>';
//                  审查级 hide → 'review:hide';审查级 code 且番号不可信 → 'review:code';
//                  审查级 filter(探花/反差/私房/海角…)额外命中"前女友/真名/偷偷录/不知情" → 'item:filter';
//                  其余分类片名等标签性字段命中同一组词、且没有可信番号、分区又不是商业剧本片 → 也是 'item:filter'
//       审查级 = 分类审查级 与 条目标签性文本(片名/副名/分类/标签/备注,不含简介)审查级 取更严;命中 学生/校园/少女(非"美少女")/父女/强奸/凌辱/催眠/时间停止/醉酒/童颜/teen…
//                  记为 code 级(有可信番号的日本商业片放行,其余藏);命中 父女/鬼父/女儿/実の娘 记为 hide 级(一律藏)
//       mainstream(x_mainstream / x_nonvideo)不在这里拦:那是入库第 3 步的事,这里只管内容政策
//   filterItems(items, ctxFn?) → 留下 ok 的条目(ctxFn(item) 返回该条的 ctx)
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const taxonomy = require('./taxonomy');
const title = require('./title');
const { t2s } = require('./t2s');

// 改下面任何规则请顺手 +1(RULES_VERSION 里也带内容哈希,忘了改也会变)
const POLICY_REV = 'p7';   // p2:补同义词/谐音/委婉说法(罗莉/洛丽塔/小女孩/女童/高校生/高考、迷晕/迷倒/迷J、隐藏摄像头/女厕、泄露/私密视频/不雅、AI明星/AI去衣、狗交/人与狗)
// p3(复核第二轮):异体字 偸/媮→偷;compact 去掉全部标点/符号(萝-莉、未.成.年、l.o.l.i、"lo li");台湾学制 国中/国小/国一~国三、
//     职高/中专/X年级/高1·初2·中2、15yo、08妹;粘连 SchoolGirls/highschool;ろり;窃拍/盗录/暗拍/更衣室…拍/隐蔽摄像头/发现摄像头;
//     视频流出/私拍流出 硬拦(后面跟 了/来 也拦);"XX事件"真人事件框架;审查级补 稚嫩/娃娃脸/技校/继女/侄女/小屁孩/强了
// p4(复核第三轮):打码写法把整个字盖掉(ロ● 盗● 隠し●り 薬を●ませ J● 女子〇生)→ 新增保留打码位的 masked 文本 + MASKED_BLOCK;
//     〇(U+3007 属于字母类,compact 压不掉)不挨着中文数字时折成 ●;hidden/spy camera 全词;児童/女児/ジュニアアイドル、little girl;
//     英文下药 roofies/sleeping pills/passed out/unconscious/date rape/chloroform;英文泄露 leaked nudes/celebrity sex tape;young girl 进审查级 code
// p5(接入 爱播 s51):ctx.strict 严格站语义(STRICT_*);全局补 発育途中(日文 发育中)、Al/A1 = AI 的形近写法(Al明星/Al换脸)、
//     演艺圈/娱乐圈/偶像…淫梦(明星淫梦 同类)、审查级 code 补 輪カン(轮奸 的打码写法)、hide 补 娘(18)/お父さんに教え…(父女框架)
// p6(phase 2 复核):查询里的 leet 写法(l0li / sh0ta / ch1ld / 10li)按 0→o 1→i|l 3→e 4→a 5→s 7→t @→a $→s 折一遍再查(只查询,条目不折)
// p7(phase 3 复核):下药 / 失去意识题材统一硬拦(和 AVDB 的 Aphrodisiac / Sleeping / Coma 同口径;原来中文 媚药/睡奸 只是审查级 code):
//     媚药/春药/催淫/催情/キメセク/aphrodisiac 查全部字段(含简介);睡奸/熟睡/昏睡/昏迷/夜袭/夜這い/趁…睡/睡梦中/秘药·密药/asleep…
//     只查标签性字段(ITEM_BLOCK_HEAD:片名/副名/分类/标签/备注 —— 简介里"趁丈夫熟睡""重伤昏迷"多是剧情叙述);查询词两组都查

// ---------- 条目级硬拦 ----------
// cjk:在"去空白"文本上测(防 "萝 莉" 之类拆字);ascii:在"空白折叠"文本上按词边界测(防 "solo lift" 粘成 "sololift" 误中 loli)
const ITEM_BLOCK = [
    {
        id: 'minor',
        // 幼师/幼教(幼儿园老师)、幼馴染(青梅竹马)不算;花季/豆蔻/刚发育 是未成年的委婉说法;J系/メスガキ 是日文 JK/萝莉 的黑话;
        // 女子○生(打码的女子校生,compact 里 ○ 被压掉成 女子生)、生徒(日文=中学/高中生)
        // p2:谐音/音译(罗莉/萝丽/洛丽塔;单独的 洛丽 不算:格洛丽亚/德洛丽丝)、小女孩/女童/童模/雏妓、高校生(日文=高中生;中文"高校生活"除外)、
        //     高考/中考(刚高考完 = 高中毕业生框架;"提高考试""最高考核""心中考虑"除外)
        // p3:台湾学制 国中/国小/国一~国三(國→国 之后会跟 中国中字/韩国小姐/天国中出/国中有菜(艺名) 撞:前面不能是国名用字、后面要跟学生语境);
        //     职高/中职/中专(中等职业学校,15~18 岁);X年级(大学X年级除外);阿拉伯数字年级 高1~3/初1~3/中1~3(身高1米、初3P、其中2位 除外);
        //     出生年份 08妹/2008年出生/10后;某一中/附中 女生;ろり(とろり/ころり 除外)。\x01 = itemText 的字段分隔符
        cjk: /萝莉|少萝|小萝(?!卜)|罗莉|萝丽|箩莉|洛丽塔|洛莉塔|罗丽塔|小女孩|小男孩|女童|男童|幼童|童模|雏妓|雏女|女娃|高校生(?!活|涯)|(?<![最提])高考(?!核|究|察|虑|验|证)|中考(?!虑|察|核|验|究)|幼女|幼齿|幼幼|幼(?!师|教|馴染|なじみ|儿园老师|稚园老师)|未成年|未满(?:18|十八)|(?:18|十八)岁以下|学生妹|中学生|小学|初中|高中|中小学|儿童|童交|恋童|正太|青少年|花季|豆蔻|刚发育|未发育|没发育|发育中|发育期|[発发]育(?:途中|中|期)|(?<![身最提增升拔调抬太过偏较比更很米极超颜值度点量价位攀拉逼爆奇贼巨特好挺老])高[一二三](?!米|倍|级|度|分|个|万|千|次|期|集|部|季|号|层|楼|岁|点|截|筹|等)|(?<!年)初[一二三](?!次)|女子校生|女子高生|女子生(?!活|涯|理|产|命|日)|生徒|j系|メスガキ|(?<![\d.])0[5-9]后|零[五六七八九]后|(?<![\d.])0[5-9]年(?!代)|(?<![\d.])1[0-7][岁歳才]|十[一二三四五六七]岁|(?<![\u30a0-\u30ff])ロリ|(?<![\u3040-\u309f])ろり(?![\u3040-\u309f])|ろりっ子|ろりこん|(?<![中韩美泰英法德日俄越缅柬菲印澳意西葡荷挪芬丹捷匈希土伊埃巴墨朝蒙瑞波加新马老古南北东全各外本两祖帝王异敌万邻诸天爱强大母宗属列岛战他回出入归卖治建开报举故邦盟该小])国(?:中(?=生|女(?!老师|教师|教官|班导|导师|班主任)|男(?!老师|教师|教官|班导|导师|班主任)|妹|小妹|少女|学生|时|的时候|毕业|制服|校服|[一二三]年|[一二三][上下]|那年|阶段|同学|校|班|版|$|[\x01\x02])|小(?=生|女生|女孩|妹|男生|学|时|的时候|毕业|[一二三四五六]年|那年|阶段|同学|校|班|老师|$|[\x01\x02])|[一二三](?=生|女|男|妹|学|时|的时候|那年|暑假|寒假|毕业|[上下]学期|[上下]$|$|[\x01\x02]))|(?<![兼在求任就供辞离入专全撤降调升本])职高(?!管|层|薪|端|级|效|颜|档|峰|速)|中职(?!业|位|务|称|场|员|责|能|工)|中专(?!业|注|机|心|门|题|属|用|线|项|栏|场|访|辑)|(?<!大学|大专|研究生|研|博士|硕士|大|专科)[七八九789]年级|(?<![身最提增升拔调抬太过偏较比更很米极超颜值度点量价位攀拉逼爆奇贼巨特好挺老])高[123](?![0-9米mkp倍级度分个万千次期集部季号层楼岁c])|(?<![0-9年最当首])初[123](?![0-9次夜回pk集期部季号日章话])|(?<![0-9其集途空当期第之年月日命射热])中[123](?=の|生|女子|女生|男子|男生|妹|学|から|まで|时|年生|$|[\x01\x02])|(?:[一二三四五六七八九十市县镇区附]|实验)中(?:女生|男生|校花|班花|学妹|妹子)|(?<![\d])0[5-9](?:妹|小妹|学妹|嫩妹|萝|女孩|女生|少女|小可爱|宝宝)|(?<![\d])20(?:0[5-9]|1\d)年?(?:出生|生的|生人|后(?!入))|(?<![\d])1[0-2]后(?!入|背|插|面|续|来|期)|児童|女児|ジュニアアイドル|こどもの[时時][间間]|ちびっ子|ちびっこ|チビっ子|ショタ|しょた|つるぺた|ツルペタ|おさな(?!なじみ|馴染)/u,
        // p3:school girl / high school / middle school 按子串测(TonetsSchoolGirls、highschoolDxd 粘连写法);数字年龄 15yo / 16 years old
        ascii: /(?:^|[^a-z0-9])(?:loli|lolita|lolicon|luoli|shota|shotacon|jailbait|under-?age|pre-?teens?|elementary|child|children|kids?|jk|jc|js|little ?(?:girls?|boys?))(?=$|[^a-z0-9])|school ?girls?|high ?school|middle ?school|junior ?high|(?:thir|four|fif|six|seven)teen|(?<![0-9])(?:1[0-7]|[1-9])[ -]?(?:yo|y\/o|y\.o|yrs?[ -]?old|years?[ -]?old)(?![a-z])/,
    },
    {
        id: 'voyeur',
        // p2:隐藏/偷装摄像头、破解家庭摄像头、女厕/男厕/蹲坑、盗拍/偷摄(单独的 摄像头/厕所/暗藏 太常见:主播对着摄像头、厕所play、"暗藏淫荡本性")
        // p3:窃拍/窃录/盗录/暗拍、偷看洗澡、隐藏镜头、隐蔽(居家)摄像头、民宅/出租屋/宿舍摄像头、"发现摄像头/镜头"(当事人不知情的铁证)、
        //     "摄像头被(店员)发现"(紧挨着 = 摄像头本身被发现)、"摄像头…被她发现"(隔开时要有她/他:"对着摄像头自慰差点被发现"是露出)、
        //     更衣室/换衣间/女宾/澡堂/洗浴中心…拍(自拍除外;偸拍 的 偸 在 normText 里折成 偷)
        cjk: /偷拍|偷窥|盗摄|针孔|监控|偷录|隐拍|厕拍|盗撮|隠し撮り|隠撮|盗拍|偷摄|窃拍|窃录|窃摄|盗录|暗拍|暗摄|偷看(?:洗澡|换衣|如厕|上厕所|尿尿|撒尿)|隐藏的?镜头|(?:隐藏|隐蔽|隐形|偷装|偷放|暗藏|藏起来|偷偷安装|偷偷装)的?(?:居家|家庭|家用)?(?:摄像|摄影机|监视)|(?:破解|入侵|黑进|黑客)了?(?:家庭|家用|酒店|宾馆|民宿)?的?(?:摄像|监视)|(?:家庭|家用|酒店|宾馆|旅馆|民宿|卧室|浴室|民宅|居家|出租屋|宿舍|更衣室|试衣间|澡堂)(?:摄像头|监视器)|摄像头(?:破解|被黑|偷)|发现了?(?:摄像|镜头|偷拍|被拍|在拍|在录|偷录|针孔)|摄像头(?:差点|差一点|险些)?被[^\x01\x02]{0,4}?发现|摄像头[^\x01]{0,15}?被(?:她|他|女方|对方|妹子|女的|小姐姐)发现|镜头[^\x01]{0,15}?被(?:她|女方|对方|妹子|女的|小姐姐)发现|(?:更衣室|更衣间|换衣室|换衣间|女宾|女浴室|女澡堂|澡堂|洗浴中心|浴场|女士公共|公共浴室|公共厕所|公厕)[^\x01]{0,12}?(?<!自)(?:拍|摄|录)|女厕|男厕|蹲坑|蹲厕/u,
        ascii: /(?:^|[^a-z0-9])(?:hidden ?cam(?:s|eras?)?|spy ?cam(?:s|eras?)?|voyeur|upskirts?|peeping(?: ?toms?)?|(?:toilet|shower|locker ?room|changing ?room|dressing ?room|bathroom|restroom) ?cam(?:s|eras?)?)(?=$|[^a-z0-9])/,
    },
    {
        id: 'drugging',
        // 昏迷 单独出现多是剧情简介(伦理片"重伤昏迷"),降为审查级 code;日文 眠らせ/薬を盛/催眠ガス(含 催●ガス)= 下药
        // p2:迷晕/迷昏/迷翻/迷J(打码的迷奸)/迷倒("迷倒众生/万千粉丝"这类夸人除外)/蒙汗药/听话水/失身水/药倒/灌药/下了药/GHB
        // p7:媚药/春药/催淫/催情(日文 媚薬;"服用催情后""催情油/剂/乳液")、キメセク/ガンギマリ(嗑药做爱)、aphrodisiac —— AVDB 的 Aphrodisiac / Drugs 是硬拦,这里同口径
        cjk: /迷奸|迷药|下药|药奸|捡尸|醉奸|睡眠薬|睡眠药|安眠药|安眠薬|眠剤|眠らせ|薬を盛|药を盛|催眠?ガス|迷晕|迷昏|迷翻|迷操|迷干|迷插|迷j|迷魂(?:药|香)|迷倒(?!众生|万千|无数|一片|全场|一众|所有|粉丝|观众|大片|全网|男人|男生|网友)|蒙汗药|听话水|失身水|药倒|药晕|药翻|灌药|下了药|薬を[飲饮]ませ|薬を[飲饮]まされ|薬で眠|睡眠剤|媚[药薬]|春[药薬]|催淫|催情|キメセク|ガンギマリ/u,
        ascii: /(?:^|[^a-z0-9])(?:drugg(?:ed|ing)|roofie[sd]?|roofied|ghb|date ?rape|sleeping ?pills?|(?:passed|knocked|blacked) ?out|unconscious|chloroform(?:ed)?|aphrodisiacs?)(?=$|[^a-z0-9])/,
    },
    {
        id: 'deepfake',
        // p2:AI明星/AI女星/AI名人(真人明星的 AI 合成)、AI去衣/AI脱衣/一键脱衣(对真人照片"去衣")
        // p5:AI 的形近写法 Al/A1(爱播 "Al某某…" 全是明星换脸)、"演艺圈/娱乐圈/女星…淫梦"(明星淫梦 的同类系列名)
        cjk: /换脸|换头|a[il1]魔改|明星合成|(?:明星|女星|男星|名人|演艺圈|娱乐圈|偶像|女团|艺人|网红)淫梦|(?<![a-z])a[il1](?:明星|女星|男星|名人|大明星|去衣|脱衣|扒衣|一键脱|透视|换脸)|(?:明星|女星|名人)a[il1](?![a-z])|一键(?:脱衣|去衣|扒衣)|(?:去衣|脱衣)a[il1](?![a-z])/u,
        ascii: /(?:^|[^a-z0-9])(?:deep ?fakes?|face ?swap|deep ?nudes?|nudify|undress ?ai|ai ?undress)(?=$|[^a-z0-9])/,
    },
    {
        id: 'leak',
        // "流出" 另有专门判定(见 leakOutflow):无码流出 / 液体流出 / 可信日本番号片的流出版 放行
        // p2:泄露/泄漏("精液泄漏""毒气泄漏"这类液体/气体除外)/外泄、私密视频/私密照/私密影像(单独的 私密 不算:私密保养/最私密的花园)、
        //     不雅(全部)、遭曝/被曝/曝出/疯传/网传/实锤/扒出/被挖出、手持身份证、艳照
        //     (泄露/外泄/私密影像 跟"流出"一样:可信日本番号片里是剧情/宣传词,见 LEAK_SOFT)
        // p3:调研规格 §1 的窄泄露词 私拍流出/视频流出 硬拦(后面跟 了/来/大量 也拦;有番号也拦),同类载体 自拍/录像/影片/照片/聊天记录…流出 一并;
        //     无码影片流出 这类"无码流出"仍放行
        cjk: /黑料|吃瓜|网曝|网爆|门事件|大瓜|猛料|曝光|泄密|外流|裸贷|裸条(?!纹)|(?:视频|裸照|照片|裸体)做?抵押|抵押(?:视频|裸照)|婚闹|不雅|遭曝|被曝|曝出|疯传|网传|实锤|热传|扒出|(?:被|遭)挖出|手持身份证|身份证(?:照|裸)|艳照|(?<!无码|无修正|无修)(?:私拍|视频|视屏|自拍|录像|影片|照片|录影|影像|床照|裸照|私照|聊天记录|原档)流出/u,
        ascii: /(?:^|[^a-z0-9])(?:(?:leaked|stolen) ?(?:sex ?tapes?|videos?|nudes?|pics|photos?)|celeb(?:rity)? ?sex ?tapes?|sex ?tapes? ?leak(?:ed|s)?|revenge ?porn)(?=$|[^a-z0-9])/,
    },
    {
        id: 'bestiality',
        // p2:狗交/犬交/马交、人狗交/人狗大战、人与狗/人与动物、和狗/跟狗/被狗 + 性动作("主人狗奴"这类人扮狗不算)
        cjk: /人兽|兽交|人畜|兽奸|暗网|狗交|犬交|马交|驴交|猪交|人狗(?:交|大战|配|恋|性)|人与(?:狗|犬|马|驴|猪|动物|畜|兽)|(?:与|和|跟|被|让)(?:公狗|狼狗|藏獒|大狗|狗狗|狗|犬|马|驴|猪)(?:交|干|操|肏|日|配|舔|插|舌吻|接吻|亲嘴|做爱|性交)|(?:与|和|跟)动物(?:交|做|性)|动物(?:性交|交配)/u,
        ascii: /(?:^|[^a-z0-9])(?:bestiality|zoophilia|zoo ?sex|(?:dog|animal|horse|k9) ?sex)(?=$|[^a-z0-9])/,
    },
];
// p7:只查标签性字段(片名/副名/分类/标签/备注)的硬拦 —— 睡眠 / 失去意识 / 秘药(简介里是剧情叙述,查全部字段会误拦整类叙事片)。
//   睡奸/睡眠姦/熟睡/昏睡/昏迷/趁(她…)睡/夜袭/夜這い/睡梦中/半睡半醒/睡着的…;日文 寝込み/寝ている間/眠っている間;秘药·密药(秘薬);
//   英文 asleep / sleep sex / sleeping <人>(sleeping bag / sleep over 这类不会命中:只认这几种搭配)
const ITEM_BLOCK_HEAD = {
    id: 'drugging',
    cjk: /睡奸|睡眠[奸姦]|熟睡|昏睡|昏迷|趁[^\x01\x02]{0,6}?睡(?!衣|裙)|夜[袭襲]|夜[這这]い|睡梦中|半睡半醒|睡着(?:的|时|中|后被|了被)|寝込み|寝て[いる]る?(?:間|间|隙|うち)|眠って[いる]る?(?:間|间|隙|うち)|[秘密][药薬](?!方|材|膳|酒|典)/u,
    ascii: /(?:^|[^a-z0-9])(?:asleep|sleep ?(?:sex|fuck(?:ing|ed)?|rape[ds]?|molest(?:ed|ing|ation)?)|sleeping (?:girls?|wife|wives|sis(?:ter)?|step ?sis(?:ter)?|step ?mom|mom|mother|teens?|roommate|friend|beauty|girlfriend|gf|babysitter|daughter|step ?daughter|milf|aunt))(?=$|[^a-z0-9])/,
};
function hitHead(t) {
    const r = ITEM_BLOCK_HEAD;
    return (r.cjk.test(t.compact) || r.ascii.test(t.spaced) || r.ascii.test(t.loose)) ? r.id : null;
}
// 真人身份 / 前任 / 不知情拍摄 —— 报复性传播与泄露的信号
//   审查级 filter 的分类(探花/反差/私房/情侣自拍/海角/AI短剧):全部字段(含简介)命中即拦,有番号也拦;
//   p2 起其余分类也查(片名/副名/分类/标签/备注):国产自拍/主播/网红这类真人拍摄最容易出报复性内容,
//   只放过 有可信番号 或 分区本身是商业剧本片(SCRIPTED_BUCKETS:日本 AV 的"前女友"、三级片简介的"前男友"是剧情)
// p3:(差点)被她/他发现(探花/海角里 = 偷拍的镜头差点被当事人发现;"差点被发现""差点被店员发现"这类露出/车震不算)
const FILTER_EXTRA = /前女友|前男友|前妻|前夫|真名|实名|偷偷录|偷偷拍|偷装|偷放|隐藏摄像|不知情|未经(?:她|他|本人|对方)?的?(?:同意|允许)|没经过?(?:她|他|本人)?的?同意|分手(?:后|报复)|报复(?:前|性)|丑闻|裸照|被(?:她|他)发现|发现(?:是|在|被)?直播|不知道(?:在|被)?(?:直播|拍|录)/u;
const SCRIPTED_BUCKETS = new Set(['cn_studio', 'jp_censored', 'jp_uncensored', 'jp_subbed', 'western', 'anime', 'softcore', 'commentary']);
// 条目文本审查级(code):分类审查词在标题/简介里出现时,只给有可信番号的商业片(调研 reviewPolicy 是分类级,这里推到条目级)
//   学生(大学生/留学生除外)/校园/少女(美少女除外)/学校场景/男孩少年/强奸(含 レ●プ 轮● 这类打码写法)/催眠/醉酒/童颜…
//   在 spaced 与 compact 两种文本上都测(打码的 ● 在 compact 里被压掉)
//   p3:童颜 的同义 稚嫩/娃娃脸;技校/艺校/卫校/护校/职校(片名开头也算,INSTITUTION 要求前面 2 个字);成长期/小屁孩;嫩小妹/嫩的妹(不连写的 嫩妹);
//       继女/侄女/外甥女/养女(同 女儿);强奸的口语 "强了"("性欲太强了""越来越强了"这类程度说法除外)
const ITEM_REVIEW_CODE = /(?<!大|留|研究|博士|医|女大)学生|校园|学妹|校服|校花|班花|学校|同学|同級生|同级生|学[园園]|放[课課]後|放课后|放学|上学|辍学|教室|校内|转校生|転校生|(?<!美)少女|嫩(?:的|滴|小)?小?妹|萌妹|少年|男孩|小鬼|ガキ|孩子|小孩|小屁孩|成长期|破处|教师学生|こども|子ども|子供|いもうと|夏休み|艺术生|美术生|体育生|艺考|特长生|儿子|夜[這这]い|夜[袭襲]|痴[汉漢]|覗き|覗く|のぞき|通学|登校|下校|学院派|迷迷糊糊|半睡半醒|睡梦中|强操|强干|强制(?!高潮|绝顶|射精|潮吹|イキ|榨精|连续|调教|捆绑|束缚)|洗[脑脳]|息子(?!の嫁|の妻|嫁)|学弟|下课|课后|课间|修学旅行|不登校|强奸|强暴|轮奸|凌辱|陵辱|欺辱|侵犯|レイプ|犯され|レ[●○]プ|[轮强][●○]|[轮輪]カン|强上|用强|强行|霸王硬上弓|(?<![太很真好更最越变增加坚逞勉超极特顽倔要争刚富自图力性欲能望够还])强了|催眠|时间停止|睡奸|昏睡|昏迷|熟睡|午睡|睡着|趁睡|醉酒|趁醉|喝醉|灌醉|醉倒|醉醺醺|喝多|喝高|喝晕|醉晕|烂醉|酒醉|醉态|喝断片|媚药|媚薬|春药|催淫|キメセク|ガンギマリ|泥酔|酩酊|酔い?[潰溃]|童颜|稚嫩|娃娃脸|技校|艺校|卫校|护校|职校|抓奸|捡死鱼|女儿|继女|侄女|外甥女|养女|女子校/u;
// 点名的学校(南京大学 / 某某职业技术学院 / 传媒学院 / 师大…):国产里几乎都是"某校女生被曝"的真人曝光框架,
//   名字不可能靠正则认全,所以只给有可信番号的商业片;"大学生/大学妹"、"在上大学"、"修理工" 之类不算
const ITEM_REVIEW_INSTITUTION = /[\u4e00-\u9fff]{2,8}(?<![的上在读是个名女男酒局到了考])(?:大学|学院|师大|师范|职院|技校|艺校|卫校|护校)(?!生|妹|派|风)/u;
// 条目文本审查级(hide):父女类 —— 调研判"未成年框架风险高",有番号也藏
// (单独的"女儿"只记 code 级:日本片常见"女儿的未婚夫/女儿的男友"是母亲线,不涉及女儿本人)
// p5:"お父さん/パパ/親父 に教えられた/仕込まれた"(父亲"教"女儿)也是父女框架
const ITEM_REVIEW_HIDE = /父女|鬼父|[実实]の娘|我が娘|[義义]理の娘|(?:お?父さん|パパ|父親|親父|实父|実父)(?:に|から)(?:教え|仕込|躾|開発|开发)|パパ(?!活)(?:と(?:娘|私|の|二人|ふたり)|大好き|に(?:犯|抱か|され))|ママには(?:言えない|内緒|ナイショ|秘密)/u;
// p5:"娘(18)" 这种给女儿标年龄的写法(…娘(18)に○年間…)= 父女 + 年龄框架;在 spaced 上测(compact 把括号换成了边界符)
const ITEM_REVIEW_HIDE_SP = /娘 ?\( ?\d{1,2} ?(?:歳|岁|才)? ?\)/u;
// teen 按子串测:欧美片名常是 TinyTeen / 18Teens / TeenFidelity 这种粘连写法;eighteen/nineteen(18/19 岁)与 canteen 除外
const ITEM_REVIEW_CODE_ASCII = /(?<!eigh|nine|can)teens?|(?:^|[^a-z0-9])(?:barely ?legal|18 ?yo|young ?girls?)(?=$|[^a-z0-9])|(?<![0-9])1[89][ -]?(?:yo|y\/o|years?[ -]?old)(?![a-z])/;
// p4:打码写法(masked 文本里每个打码位 = \x03)。整个字被盖掉时 compact 里只剩半个词,上面的正则认不出来;
//   这里只收"盖掉一个字后基本只可能是那个词"的形态,宁可误拦(fail-closed)
const MASKED_BLOCK = [
    { id: 'minor', re: /ロ\x03|[萝罗]\x03|\x03莉|(?<![a-z0-9])j\x03(?![a-z0-9])|女子\x03{1,2}生|(?<![a-z0-9])[中小高初国]\x03{1,2}生|\x03{1,2}校生|\x03学生|シ\x03タ|ショ\x03(?![a-z])|\x03ョタ|学\x03{1,2}妹|未\x03{1,2}年|幼\x03{1,2}[女齿]|児\x03|\x03童/u },
    { id: 'voyeur', re: /盗\x03|偷\x03(?!情|吃)|窃\x03|隠し?\x03{1,2}り|盗\x03{1,2}り|覗\x03|のぞ\x03|针\x03|\x03孔/u },
    { id: 'drugging', re: /薬を?\x03{1,2}(?:[飲饮]|盛|ませ|入れ|で)|薬\x03{1,2}ませ|迷\x03(?!人|恋|惑|你)|睡眠\x03|眠\x03せ|\x03らせて|媚\x03[药薬]|春\x03[药薬]|睡\x03[奸姦]|夜\x03い/u },   // p7:媚●药 / 睡●奸 / 夜●い
    { id: 'deepfake', re: /换\x03|\x03脸/u },
];
const MASKED_REVIEW_CODE = /レ\x03{1,2}プ|犯\x03れ|夜\x03い|痴\x03|\x03ども|子\x03も|[轮强輪強]\x03|昏\x03|催\x03|凌\x03|陵\x03|\x03奸/u;

// ---------- 严格站(ctx.strict === true,db.json 的 strict:true;目前只有 爱播 s51) ----------
// 爱播:29 万条全在 爱播资源/视频二区 两个大杂烩分类里,上游真实分类只在 vod_class/vod_tag(偷拍偷窥/网曝吃瓜/换脸明星/少女萝莉/學生…);
// 混着 2609 系 AI 改标题(占位番号 + AI 写的简介,片名和视频对不上)、"Al某某"明星换脸、模特私拍/投稿/良家泄露。
// 严格站的每一条都按审查级 filter 处理(FILTER_EXTRA 查全部字段),另外:
//   S1 vod_class/vod_tag 逐个 token 过 taxonomy.classify:任一 token 被硬拦 → 'category:<原因>';token 的审查级并进条目审查级
//   S2 审查词(ITEM_REVIEW_*)查 片名/副名/简介/简述/备注(vod_class/vod_tag 里的上游分类名走 S1,不按文本再判);
//      条目自己的文本命中 code 级审查词 → 直接 hide(有可信番号也藏);code 级放行只留给"上游分类是 强奸乱伦/教师学生、片名干净"的可信番号片
//   S3 STRICT_HIDE(全部字段):学生/学妹/校园/少女/小女生/处女/初夜/18岁/爸爸/cos/媚薬… 一律 'review:hide';动漫·里番 也 hide
//   S4 番号:占位番号 = AI 改标题,片名不描述视频 → 'item:strict';日本番号挂在 vod_class 是国产/主播… 的条目上 → 不可信
//   S5 STRICT_BLOCK:片名开头 "AI/Al+人名"、"神似/撞脸 某人"→ deepfake;私拍/原相机/投稿/良家/泡良/付费群… → leak;刚满18… → minor
//   S6 分类是大杂烩(mixed/uncat)时按 vod_class 第一个能导航的 token 定大类、并上它们的标签
//   S7 国产类(STRICT_PROSE_BUCKETS)的简介是一大段跟片名无关的叙述(2609 系 AI 改标题:片名和简介都是生成的,跟视频对不上,
//      而且专门仿写 某地某校某某 的泄露/曝光)→ 'item:strict';日本片/三级片的真剧情简介不在此列
const STRICT_TOKEN_SPLIT = /[,，、|/;；\s]+/u;
// (ITEM_REVIEW_CODE 里学校/未成年相关的那一半在这里升成 hide,再加 处女/初夜/家教/18岁/保育园 之类)
const STRICT_HIDE = /(?<!大|留|研究|博士|医|女大|大专|成人|夜|老|中专毕业)学生|学妹|校服|校园|校花|班花|学校|学[园園]|同学|同級生|同级生|教室|校内|课堂|课桌|放学|上学|辍学|放[课課]後|放课后|学[级級]|クラスメイト|クラス人数|同じクラス|委[员員]长|部活|担任|班主任|[职職][业業]体[验験]|毕业典礼|毕业洗礼|穴生|思春期|青春期|小恶魔|小悪魔|学弟|学长|学姐|学姊|新生(?!代|活|命|事)|青春|天真|无邪|無邪|[义義]父|教え子|塾|社团|我的(?:老师|班主任|家教)|体育老师|班长|パパ(?!活)|世[间間]知らず|何も知らない|无知少女|性的虐|性虐待|(?:监禁|監禁|绑架|拉致)事件|昏强|转校生|転校生|教育[実实]习|高校|女子校|女子高|技校|艺校|卫校|护校|职校|水手服|(?<!美)少女|少年|男孩|男の子|小鬼|ガキ|孩子|小孩|小屁孩|成长期|小女生|小妹妹|嫩妹|萌妹|幼(?!师|教)|保育[园園所]|童颜|稚嫩|娃娃脸|青涩|处女|処女|初夜|破处|开苞|未经人事|女儿|继女|侄女|外甥女|养女|爸爸|老爸|爹地|父亲|继父|継父|(?:母|母親|妈妈|母亲)が?再婚|刚满(?:18|十八)|才(?:18|十八)|刚成年|才成年|(?:^|[\x01\x02])[岁歳]|(?:叔母|伯母|おば|母|姉)(?:さん)?に[連连]れられ|[双両两]亲?[^\x01\x02]{0,6}不在|爸妈[^\x01\x02]{0,6}不在|父母[^\x01\x02]{0,6}不在|等妈妈|妈妈回来|妈妈不在|ジャージ|百褶|格子裙|交换生|初恋|返済|借金|抵抗できない|抵抗出来ない|无法反抗|反抗不了|抗拒|[(]1[89][)]|(?<![a-z])cos(?:play|er)?(?![a-z])|制服(?:美少女|少女|女子)|美少女战士|水兵月|媚[药薬]|春药|催淫|キメセク|廻され|回され|まわされ|(?<![\d])1[89][岁歳]|十[八九][岁歳]|成年礼|家教|补习/u;
const STRICT_PROSE_BUCKETS = new Set(['cn_amateur', 'cn_hookup', 'cn_studio', 'live', 'creators', 'short']);
const STRICT_HIDE_ASCII =/(?:^|[^a-z0-9])(?:students?|school\w*|classmates?|teens?|teenagers?|virgins?|young|tiny|petite|step ?daughters?|daughters?)(?=$|[^a-z0-9])/;
const STRICT_BLOCK = [
    { id: 'minor', re: /萝(?!卜)|雏(?!菊)|童(?!贞|貞|话|話)|蜡笔小新|樱桃小丸子|小丸子|名侦探柯南|哆啦a梦/u },
    { id: 'voyeur', re: /发现(?:是|在|被)?直播|偷偷直播|直播(?:偷拍|她不知道)/u },
    { id: 'deepfake', re: /神似|酷似|撞脸|长得像|像极了|翻版|高仿|淫梦再现|明星脸/u },
    { id: 'leak', re: /私拍|原相机|手机相册|相册里|云盘|网盘|聊天记录|前任|投稿|泡良|良家|私密|私下(?:曝光|流出|拍|录|视频|照)|付费群|内部群|会员群|电报群|tg群|群里流|朋友圈|约炮记录|还贷|网贷|借贷|欠款|还债|欠债|抵债|肉偿|粉丝自拍|粉丝自制/u },
];
// 片名开头的 "AI某某 / Al某某 / [AI]某某"(后面直接跟汉字人名;AI短剧/动漫/绘画 这类 AI 生成内容除外)
const STRICT_AI_NAME = /^\x02*a[il1|]\x02*(?=[\u4e00-\u9fff])(?!短剧|动漫|动画|漫画|绘|生成|作画)/u;
const STRICT_AI_TAG = /^[\s[【(（]*a[il1|]\d{0,2}\s*[#\]】)）:：_\-|]/u;   // "AI2#歌手某某"、"[AI]某某"、"Al-某某"

const REVIEW_RANK = { hide: 3, code: 2, filter: 1 };
const stricter = (a, b) => ((REVIEW_RANK[b] || 0) > (REVIEW_RANK[a] || 0) ? b : a) || null;

// ---------- 文本归一化 ----------
// 全部字段拼起来的上限:正则都是线性的,200k 字也只是几毫秒;截得太短会被"简介前面塞一堆填充字"绕过
const TEXT_CAP = 200000;
function decode(s) {
    let prev, n = 0;
    do { prev = s; s = s.replace(/&amp;/gi, '&'); } while (s !== prev && ++n < 10);
    return s.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
        .replace(/&#(\d{1,7});/g, (_, d) => { const c = +d; return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
        .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; });
}
// p3:t2s/NFKC 都不折的异体字 / 形近字(偸拍 曾整片漏过偷拍拦截),以及混进拉丁词里的西里尔/希腊形近字母(lоli 里的 о 是西里尔)
const VARIANTS = new Map(Object.entries({
    '\u5078': '\u5077', '\u5aae': '\u5077', '\u95da': '\u7aa5', '\u59e7': '\u5978',   // 偸 媮 → 偷,闚 → 窥,姧 → 奸
    '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0458': 'j', '\u0455': 's', '\u043a': 'k',
    '\u03bf': 'o', '\u03b9': 'i', '\u03b1': 'a', '\u03ba': 'k',
}));
const VARIANT_RE = new RegExp('[' + [...VARIANTS.keys()].join('') + ']', 'gu');
const FIELD_SEP = '\x01';   // itemText 拼字段用:compact 去标点后仍压不掉(防 名尾"最高" + 分类"三级" 拼出 "高三")
function normText(raw) {
    let s = String(raw == null ? '' : raw);
    if (s.length > TEXT_CAP) s = s.slice(0, TEXT_CAP);
    s = decode(s.replace(/<[^>]*>/g, ' '));
    s = t2s(s.normalize('NFKC')).toLowerCase().replace(VARIANT_RE, (c) => VARIANTS.get(c));
    // p4:〇(U+3007)是字母类,compact 压不掉;不挨着中文数字时它就是打码符(女子〇生 中〇生 ロ〇リ),折成 ●
    s = s.replace(/(?<![〇零一二三四五六七八九十百千万两])〇(?![〇零一二三四五六七八九十百千万两])/g, '●');
    const spaced = s.replace(/[\s\p{Cc}\u200b-\u200f\ufeff\u2800]+/gu, ' ').trim();
    // p3:compact 去掉全部空白/标点/符号/格式符/组合符(原来只去空白和 ·・•*●○◆★☆_:萝-莉、萝~莉、萝|莉、未.成.年、l.o.l.i 都漏过)
    //     但自然断句标点(逗号/句号/顿号/叹号问号/冒号分号/括号引号/省略号)换成边界符 \x02,不能去掉:"推高,一对""爆发之初,三条""兼职,高颜值" 否则拼出 高一/初三/职高
    const compact = spaced.replace(/\.{2,}|[,.。、!?;:()\[\]{}<>"'“”‘’「」『』【】《》〈〉〔〕]/g, (m) => (m === '.' ? '' : '\x02')).replace(/[\s\p{P}\p{S}\p{Z}\p{Cf}\p{M}]+/gu, '');
    // loose:去标点符号、保留空白 —— 只给英文词用("l.o.l.i collection" → "loli collection",compact 会粘成 lolicollection 失去词边界)
    const loose = spaced.replace(/[\p{P}\p{S}\p{Cf}\p{M}]+/gu, '').replace(/ {2,}/g, ' ');
    // p4:masked:打码符统一成 \x03 留住位置,其余空白/标点去掉(给 MASKED_BLOCK / MASKED_REVIEW_CODE 用)
    const masked = spaced.replace(MASK_RE, '\x03').replace(/[\s\p{P}\p{Z}\p{Cf}\p{M}]+/gu, '');
    return { spaced, compact, loose, masked };
}
const MASK_RE = /[●○◯◎◉⚫⚪⭕■□◆◇▲△▼▽★☆※×✕✖☓＊*♡♥❤〇]/gu;
// p2:演员/导演/地区也查硬拦词(搜索相关性闸门按 vod_actor 匹配;"洛丽塔"之类的账号名常只在演员栏)
const TEXT_FIELDS = ['vod_name', 'vod_sub', 'vod_content', 'vod_blurb', 'type_name', 'vod_tag', 'vod_class', 'vod_remarks'];
const NAME_FIELDS = ['vod_actor', 'vod_director', 'vod_area'];
// 条目级审查词只看"标签性"字段:伦理/三级片的剧情简介里 女儿/孩子/学校 是正常叙述,算进去会把整类叙事片藏掉
// (硬拦词仍然看全部字段,含简介)
const HEAD_FIELDS = ['vod_name', 'vod_sub', 'type_name', 'vod_tag', 'vod_class', 'vod_remarks'];
const STRICT_REVIEW_FIELDS = ['vod_name', 'vod_sub', 'vod_content', 'vod_blurb', 'vod_remarks'];
function itemText(item, fields) {
    const sp = [], cp = [], lp = [], mp = [];
    for (const f of fields || TEXT_FIELDS) {
        const v = item[f];
        if (v == null || v === '') continue;
        const t = normText(typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : (Array.isArray(v) ? v.join(' ') : '')));
        if (!t.spaced && !t.compact) continue;
        sp.push(t.spaced); cp.push(t.compact); lp.push(t.loose); mp.push(t.masked);
    }
    // 字段间放一个压不掉的分隔符:防止 名尾"最高" + 分类"三级" 拼出 "高三"(compact 会去掉标点,所以用控制字符 FIELD_SEP)
    return { spaced: sp.join(' | '), compact: cp.join(FIELD_SEP), loose: lp.join(' ' + FIELD_SEP + ' '), masked: mp.join(FIELD_SEP) };
}

// "流出":默认算泄露;放行 无码/无修正流出、液体流出(精液流出 / 流出来)、以及可信日本有码番号片的流出版
const OUTFLOW_PRE_OK = /(?:无码|无修正|精液|液体|淫水|白浆|爱液|蜜汁|精子|浓精|尿液|奶水|乳汁|[液浆精汁尿穴逼满道水])$/;
// "骚穴不断流出爱液" / "穴里流出的蜜液" / "流出大量白浆":液体词在后面
const OUTFLOW_POST_FLUID = /^(?:好多|大量|不止|不断|很多|许多|一股|一滩|一些|一点|了好多|了大量|了很多|了一股|了一些)?的?[^\x01\x02]{0,4}?(?:爱液|蜜液|淫液|淫水|精液|白浆|浓精|精子|液体|蜜汁|汁液|[液浆汁尿奶血水精])/;
// p3:"流出了/好多/大量/不止/不断" 原来一律放行 → "私拍流出了""不小心流出了" 全漏。现在只在前面 12 个字里有液体词时放行("淫水加上精液一下就流出了")
const OUTFLOW_FLUID_NEAR = /[液浆精汁尿奶血水潮喷射穴逼屄]/;
function leakOutflow(compact) {
    const re = /流出/g;
    let m;
    while ((m = re.exec(compact))) {
        const pre = compact.slice(Math.max(0, m.index - 4), m.index);
        const post = compact.slice(m.index + 2, m.index + 12);
        if (OUTFLOW_PRE_OK.test(pre) || OUTFLOW_POST_FLUID.test(post)) continue;
        if (/^来/.test(post)) continue;   // 流出来 = 身体上的流(视频/私拍/自拍…流出来 已被 leak 组的硬拦词拦掉)
        if (/^(?:了|好多|大量|不止|不断)/.test(post) && OUTFLOW_FLUID_NEAR.test(compact.slice(Math.max(0, m.index - 12), m.index))) continue;
        return true;
    }
    return false;
}

// 泄露类的"软"词:默认算泄露;可信日本番号片放行("以不泄露秘密为条件"是剧情,"完全私密影片"是宣传词)。液体/气体的 泄漏 一律不算
// p3:真人事件框架 "<某地>叔侄乱伦事件""某中性奴契约事件""滥交事件""热点事件""事件女主角"(日本番号片的 "熟女事件" 是片名系列,照样放行)
const LEAK_SOFT = /(?<!精液|液体|尿液|喷射|乳汁|奶水|淫水|毒气|煤气|燃气|天然气|核|辐射|气体)泄[露漏]|外泄|私密(?:视频|视屏|影片|影像|录像|照|自拍|流出|泄|曝)|(?:乱伦|性侵|滥交|偷情|出轨|通奸|性奴|开房|淫乱|群交|群p|轮奸|强奸|丑闻|艳照|校园|真实|热点|震惊|轰动|社会|聚众|约炮|偷拍|视频|契约|大)事件|事件(?:女主|男主|主角|当事|视频|全过程|原版|完整版|始末|真相|曝光)/u;
// 演员/导演/地区栏是人名:单字 幼、高一/初三(高一X)、生徒、jk/js 这类在人名里会误中,只认明确的未成年词;其余硬拦组照常
const MINOR_NAMESAFE = {
    cjk: /萝莉|少萝|罗莉|萝丽|箩莉|洛丽塔|洛莉塔|罗丽塔|幼女|幼齿|幼幼|未成年|未满(?:18|十八)|学生妹|中学生|小学生|初中生|高中生|女子校生|女子高生|高校生(?!活|涯)|恋童|正太|小女孩|女童|童模|雏妓|メスガキ|(?<![゠-ヿ])ロリ/u,
    ascii: /(?:^|[^a-z0-9])(?:loli|lolita|lolicon|luoli|shota|shotacon|jailbait|under-?age|pre-?teens?)(?=$|[^a-z0-9])/,
};
function hitBlock(t, javCodeOk, nameField) {
    for (const g of ITEM_BLOCK) {
        const r = nameField && g.id === 'minor' ? MINOR_NAMESAFE : g;
        // p3:ascii 也在 compact 上测("l.o.l.i"、"lo li" 去标点去空白后才是 loli;compact 里英文词只在挨着汉字/开头结尾时才有词边界)
        if (r.cjk.test(t.compact) || r.ascii.test(t.spaced) || r.ascii.test(t.compact) || r.ascii.test(t.loose)) return g.id;
    }
    // p4:打码写法;人名栏不测(艺名里的符号不是打码)
    if (!nameField && t.masked && t.masked.indexOf('\x03') >= 0) for (const g of MASKED_BLOCK) if (g.re.test(t.masked)) return g.id;
    if (!javCodeOk && (LEAK_SOFT.test(t.compact) || leakOutflow(t.compact))) return 'leak';
    return null;
}

// ---------- 公共函数 ----------
function checkQuery(q) {
    if (q == null) return false;
    const s = String(q).slice(0, 200);
    if (!s.trim()) return false;
    const t = normText(s);
    let javOk = false;
    if (/流出/.test(t.compact) || LEAK_SOFT.test(t.compact)) {   // "SSIS-001 流出" 这种查可信番号的流出版不拦(泄露/私密影像 同理)
        const p = title.parseTitle(s, '');
        javOk = /^(jav|jav-cid)$/.test(p.kind || '') && title.codeOk(p);
    }
    if (hitBlock(t, javOk) || hitHead(t)) return true;   // p7:查询词也查标签性字段那一组(睡奸/熟睡/夜袭…)
    // p6:leet 写法(l0li / sh0ta / ch1ld / 10li):只折"字母和 0 1 3 4 5 7 @ $ 混在同一个词里"的词(纯数字的番号段、
    //     SSIS-001 / 300MIUM 这类不受影响),1 按 i、l 各折一遍。只用于查询(条目不折:片名里的番号/分辨率混写太多)
    if (/[a-z]/.test(t.spaced) && /[0-9@$]/.test(t.spaced)) {
        for (const one of ['i', 'l']) {
            const dl = deLeet(t.spaced, one);
            if (dl !== t.spaced) { const nt = normText(dl); if (hitBlock(nt, javOk) || hitHead(nt)) return true; }
        }
    }
    return false;
}
const LEET = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
function deLeet(s, one) {
    return s.replace(/[a-z0-9@$]+/g, (w) => (/[a-z]/.test(w) && /[0-9@$]/.test(w)
        ? w.replace(/[013457@$]/g, (c) => (c === '1' ? one : (LEET[c] || c))) : w));
}

function checkItem(item, ctx) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, reason: 'invalid', bucket: 'uncat', tags: [], review: null };
    const it = item;
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    // 1) 分类
    const cls = c.cls && typeof c.cls === 'object' && typeof c.cls.bucket === 'string'
        ? c.cls
        : taxonomy.classify(it.type_name == null ? '' : it.type_name, c.parentName || '', { siteKind: c.siteKind });
    const base = { bucket: cls.bucket, tags: Array.isArray(cls.tags) ? cls.tags.slice() : [], review: cls.review || null };
    if (cls.block) return Object.assign({ ok: false, reason: 'category:' + String(cls.blockReason || 'blocked').split(' (')[0] }, base);
    // p5:严格站(见上面 STRICT_* 的说明)
    const strict = c.strict === true;
    let sc = null;
    if (strict) {
        sc = strictClass(it);
        if ((base.bucket === 'mixed' || base.bucket === 'uncat') && sc.bucket) base.bucket = sc.bucket;   // S6
        for (const tg of sc.tags) if (base.tags.indexOf(tg) < 0) base.tags.push(tg);
        if (sc.block) return Object.assign({ ok: false, reason: 'category:' + sc.block }, base);         // S1
    }
    // 2) 番号(审查级 code 与"流出"放行都要用)
    const parsed = title.parseTitle(it.vod_name == null ? '' : it.vod_name, it.type_name == null ? '' : it.type_name);
    let codeOk = typeof c.codeOk === 'boolean' ? c.codeOk : title.codeOk(parsed, { siteTrust: c.siteTrust !== false });
    if (strict) {
        if (parsed.placeholder) return Object.assign({ ok: false, reason: 'item:strict' }, base);           // S4:AI 改标题
        if (STRICT_PROSE_BUCKETS.has(base.bucket) && strictProse(it)) return Object.assign({ ok: false, reason: 'item:strict' }, base);   // S7
        if (codeOk) codeOk = strictCodeOk(it, parsed, c.siteTrust !== false);
    }
    const javCodeOk = codeOk && /^(jav|jav-cid)$/.test(parsed.kind || '');
    // 3) 条目文本硬拦
    const t = itemText(it);
    let hit = hitBlock(t, javCodeOk) || hitBlock(itemText(it, NAME_FIELDS), javCodeOk, true);
    const hd = itemText(it, HEAD_FIELDS);
    if (!hit) hit = hitHead(hd);                                                                             // p7:睡眠 / 失去意识 / 秘药(标签性字段)
    if (!hit && strict) hit = strictBlock(it, t);                                                            // S5
    if (hit) return Object.assign({ ok: false, reason: 'item:' + hit }, base);
    // 4) 审查级 = 分类 ∪ 条目标签性文本(片名/副名/分类/标签/备注);严格站查全部字段(S2)并且至少是 filter
    let review = base.review;
    // 严格站:审查词查片名/副名/简介/备注(vod_class/vod_tag/type_name 里的上游分类名已经在 strictClass 按分类体系判过,不按文本再判)
    const h = strict ? itemText(it, STRICT_REVIEW_FIELDS) : hd;
    if (ITEM_REVIEW_CODE.test(h.compact) || ITEM_REVIEW_CODE.test(h.spaced) || ITEM_REVIEW_CODE_ASCII.test(h.spaced) || ITEM_REVIEW_INSTITUTION.test(h.compact) || MASKED_REVIEW_CODE.test(h.masked || '')) review = stricter(review, 'code');
    if (ITEM_REVIEW_HIDE.test(h.compact) || ITEM_REVIEW_HIDE_SP.test(h.spaced)) review = 'hide';
    if (strict) {
        // S3:条目自己的文本(含简介)命中审查词 = hide(code 级的放行只留给"上游分类是 强奸乱伦/教师学生、但片名干净"的有番号片);
        //     动漫·里番 只有片名可看,里番大量是未成年设定 → hide
        if (review === 'code' || STRICT_HIDE.test(t.compact) || STRICT_HIDE_ASCII.test(t.spaced) || STRICT_HIDE_ASCII.test(t.loose) || base.bucket === 'anime') review = 'hide';
        else review = stricter(stricter(review, sc.review), 'filter');
    }
    base.review = review;
    if (review === 'hide') return Object.assign({ ok: false, reason: 'review:hide' }, base);
    if (review === 'code' && !codeOk) return Object.assign({ ok: false, reason: 'review:code' }, base);
    if (review === 'filter' && FILTER_EXTRA.test(t.compact)) return Object.assign({ ok: false, reason: 'item:filter' }, base);
    if (!codeOk && !SCRIPTED_BUCKETS.has(base.bucket) && FILTER_EXTRA.test(h.compact)) return Object.assign({ ok: false, reason: 'item:filter' }, base);
    const out = Object.assign({ ok: true }, base);
    out.codeOk = codeOk;   // p5:政策实际采用的番号可信度(严格站会比调用方传进来的更严;作品键/路由请用它)
    if (parsed.code) out.code = { code: parsed.code, key: parsed.key, ok: codeOk };
    return out;
}

// ---------- 严格站辅助 ----------
// S1/S6:vod_class/vod_tag 里的上游分类名逐个过分类体系
function strictClass(it) {
    const r = { block: null, review: null, bucket: null, tags: [] };
    const seen = new Set();
    for (const f of ['vod_class', 'vod_tag']) {
        const v = it[f];
        const s = typeof v === 'string' ? v : (Array.isArray(v) ? v.join(',') : (typeof v === 'number' ? String(v) : ''));
        if (!s) continue;
        for (const raw of s.slice(0, 4000).split(STRICT_TOKEN_SPLIT)) {
            const tok = raw.trim().slice(0, 40);
            if (!tok || seen.has(tok)) continue;
            seen.add(tok);
            if (seen.size > 80) { r.review = 'hide'; return r; }   // 正常的 vod_class 不会有这么多 token:不认识 = 不放行
            const k = taxonomy.classify(tok, '');
            if (k.block) { r.block = String(k.blockReason || 'blocked').split(' (')[0]; return r; }
            r.review = stricter(r.review, k.review || null);
            if (!r.bucket && taxonomy.isNavBucket(k.bucket)) r.bucket = k.bucket;
            for (const tg of Array.isArray(k.tags) ? k.tags : []) if (r.tags.indexOf(tg) < 0) r.tags.push(tg);
        }
    }
    return r;
}
// S4:番号放回上游真实分类(vod_class/vod_tag)里重新判可疑;国产/主播分类里的日本番号 = 不可信
function strictCodeOk(it, parsed, siteTrust) {
    const ctxType = ['type_name', 'vod_class', 'vod_tag'].map((f) => (typeof it[f] === 'string' ? it[f] : '')).filter(Boolean).join(' ').slice(0, 400);
    const p2 = title.parseTitle(it.vod_name == null ? '' : it.vod_name, ctxType);
    return !!(p2.key && p2.key === parsed.key && title.codeOk(p2, { siteTrust }));
}
// S7:简介 ≥40 字、且片名开头(去掉 [无码] 这类前缀后的 6 个字)不在简介里 = 生成的叙述,不是这条视频的描述
function strictProse(it) {
    const v = it.vod_content;
    if (typeof v !== 'string' || v.length < 40) return false;
    const cc = normText(v).compact.replace(/[]/g, '');
    if (cc.length < 40) return false;
    const head = normText(it.vod_name == null ? '' : String(it.vod_name)).compact.replace(/^(?:[^]{0,24})+/, '').replace(/[]/g, '').slice(0, 6);
    return head.length >= 4 && cc.indexOf(head) < 0;
}
// S5:严格站额外的硬拦信号
function strictBlock(it, t) {
    for (const g of STRICT_BLOCK) if (g.re.test(t.compact)) return g.id;
    const n = normText(it.vod_name == null ? '' : (typeof it.vod_name === 'string' ? it.vod_name : String(it.vod_name)));
    if (STRICT_AI_NAME.test(n.compact) || STRICT_AI_TAG.test(n.spaced)) return 'deepfake';
    return null;
}

function filterItems(items, ctxFn) {
    if (!Array.isArray(items)) return [];
    const fn = typeof ctxFn === 'function' ? ctxFn : null;
    const out = [];
    for (const it of items) {
        let ctx = {};
        if (fn) { try { ctx = fn(it) || {}; } catch (_) { continue; } }   // ctx 算不出来 = 不放行
        if (checkItem(it, ctx).ok) out.push(it);
    }
    return out;
}

// ---------- 规则指纹 ----------
function fingerprint() {
    const h = crypto.createHash('sha1');
    h.update(POLICY_REV);
    // [adult] phase 3:标签词表(含 AVDB 标签映射)与打标签逻辑也进指纹 —— 词表一改,目录重扫重新打标签
    for (const f of ['taxonomy.json', 'policy.js', 'title.js', 'taxonomy.js', 't2s.js', 'tag-vocab.json', 'tags.js']) {
        // 统一换行,Windows CRLF 检出与 Linux 算出来一样
        h.update(fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n'));
    }
    //   (AVDB 英文标签 → 词表 id 的映射就是 tag-vocab.json 里的 en,已在上面;AVDB 政策表归 lib/adult-avdb 自己版本化,不在这里读兄弟目录)
    return h.digest('hex').slice(0, 10);
}
const RULES_VERSION = POLICY_REV + '-' + taxonomy.VERSION + '-' + fingerprint();

// ---------- 加载自检:金丝雀没拦住就拒绝启动 ----------
(function selfTest() {
    const must = [
        [{ vod_name: '准高一少女初恋', type_name: '精品网红' }, 'item:minor'],
        [{ vod_name: '醉奸高中学霸', type_name: '网红主播' }, 'item'],
        [{ vod_name: '[换脸]某女星', type_name: '' }, 'item:deepfake'],
        [{ vod_name: '私下曝光-某大学生校花', type_name: '爱播资源' }, 'item:leak'],
        [{ vod_name: '06年复读生', type_name: '私房俱乐部' }, 'item:minor'],
        [{ vod_name: '情侣自拍流出', type_name: '国产自拍' }, 'item:leak'],
        [{ vod_name: '正常标题', type_name: '自拍偷拍' }, 'category'],
        [{ vod_name: '小女孩合集', type_name: '国产自拍' }, 'item:minor'],
        [{ vod_name: '酒店隐藏摄像头', type_name: '国产自拍' }, 'item:voyeur'],
        [{ vod_name: '某路人被迷晕', type_name: '国产自拍' }, 'item:drugging'],
        [{ vod_name: '【AI明星短剧】某某', type_name: 'AI短剧' }, 'item:deepfake'],
        [{ vod_name: '某网红私密视频泄露', type_name: '国产自拍' }, 'item:leak'],
        [{ vod_name: '人与狗合集', type_name: '国产自拍' }, 'item:bestiality'],
        [{ vod_name: '前女友分手后', type_name: '国产自拍' }, 'item:filter'],
        // p3:异体字 / 拆字 / 台湾学制 / 流出了 / 发现摄像头 / 审查级同义词
        [{ vod_name: '澡堂换衣室偸拍', type_name: '国产自拍' }, 'item:voyeur'],
        [{ vod_name: '萝-莉合集', type_name: '国产自拍' }, 'item:minor'],
        [{ vod_name: '好可爱的國中生', type_name: '国产自拍' }, 'item:minor'],
        [{ vod_name: '私拍视频流出了', type_name: '国产自拍' }, 'item:leak'],
        [{ vod_name: '约炮差点发现摄像头', type_name: '国产自拍' }, 'item:voyeur'],
        [{ vod_name: '稚嫩小妹妹', type_name: '国产自拍' }, 'review:code'],
        // p4:打码 / 〇 / 英文全词
        [{ vod_name: '某ロ〇リ合集', type_name: '国产自拍' }, 'item:minor'],
        [{ vod_name: '女子〇生 放課後', type_name: '日本有码' }, 'item:minor'],
        [{ vod_name: 'J●とデート', type_name: '国产自拍' }, 'item:minor'],
        [{ vod_name: '温泉盗●シリーズ', type_name: '国产自拍' }, 'item:voyeur'],
        [{ vod_name: '薬を●ませて', type_name: '国产自拍' }, 'item:drugging'],
        [{ vod_name: 'Hidden Camera In Hotel', type_name: '欧美' }, 'item:voyeur'],
        [{ vod_name: 'Celebrity Sex Tape', type_name: '欧美' }, 'item:leak'],
        [{ vod_name: 'Little Girl Next Door', type_name: '欧美' }, 'item:minor'],
        [{ vod_name: 'She Passed Out', type_name: '欧美' }, 'item:drugging'],
        [{ vod_name: '児童ポルノ', type_name: '国产自拍' }, 'item:minor'],
    ];
    for (const [it, want] of must) {
        const r = checkItem(it, {});
        if (r.ok || String(r.reason).indexOf(want) !== 0) throw new Error('[adult/policy] 自检失败:' + JSON.stringify(it) + ' → ' + JSON.stringify(r));
    }
    // p5:全局新词(飲 在 t2s 里变 饮 曾让 薬を飲まされ 整条规则失效)
    const must5 = [
        [{ vod_name: 'ABCD-101 まだ発育途中の彼女', type_name: '日本有码' }, 'item:minor'],
        [{ vod_name: 'ABCD-102 媚薬を飲まされ堕ちた', type_name: '日本有码' }, 'item:drugging'],
        [{ vod_name: 'ABCD-103 ママシ●タ実話', type_name: '日本有码' }, 'item:minor'],
        [{ vod_name: '[H無碼]こどもの時間', type_name: '成人动漫' }, 'item:minor'],
        [{ vod_name: '某某-迷操亲姐姐', type_name: '国产传媒' }, 'item:drugging'],
        [{ vod_name: 'SSIS-301 娘（18）に○年間', type_name: '日本有码' }, 'review:hide'],
        [{ vod_name: '某某柔荑轻戏', type_name: '海外明星' }, 'category'],
        // p7:下药 / 失去意识题材与 AVDB 同口径硬拦
        [{ vod_name: '某某媚药调教', type_name: '国产传媒' }, 'item:drugging'],
        [{ vod_name: '睡奸熟睡的继母', type_name: '日本有码' }, 'item:drugging'],
        [{ vod_name: 'ABCD-104 变身密药', type_name: '国产传媒' }, 'item:drugging'],
        [{ vod_name: 'Sleeping Stepsister Surprise', type_name: '欧美' }, 'item:drugging'],
    ];
    for (const [it, want] of must5) {
        const r = checkItem(it, {});
        if (r.ok || String(r.reason).indexOf(want) !== 0) throw new Error('[adult/policy] 自检失败:' + JSON.stringify(it) + ' → ' + JSON.stringify(r));
    }
    // p5:严格站(ctx.strict)
    const S = { strict: true };
    const mustStrict = [
        [{ vod_name: '某某合集', type_name: '爱播资源', vod_class: '偷拍偷窥' }, 'category'],
        [{ vod_name: '[SSNI-888] 某某', type_name: '爱播资源', vod_class: '国产主播' }, 'item:strict'],
        [{ vod_name: 'Al某某享受过程', type_name: '爱播资源' }, 'item:deepfake'],
        [{ vod_name: 'AI2#歌手某某 Part.2', type_name: '爱播资源' }, 'item:deepfake'],
        [{ vod_name: '小嫩模私拍狂欢夜', type_name: '爱播资源' }, 'item:leak'],
        [{ vod_name: 'SSIS-302 転校生の某某', type_name: '爱播资源', vod_class: '中文字幕' }, 'review:hide'],
        [{ vod_name: 'SSIS-303 普通の人妻', type_name: '爱播资源', vod_class: '强奸乱伦,国产主播' }, 'review:code'],
        [{ vod_name: '普通标题', type_name: '爱播资源', vod_content: '分手后她的视频' }, 'item:filter'],
    ];
    for (const [it, want] of mustStrict) {
        const r = checkItem(it, S);
        if (r.ok || String(r.reason).indexOf(want) !== 0) throw new Error('[adult/policy] 自检失败(strict):' + JSON.stringify(it) + ' → ' + JSON.stringify(r));
    }
    if (!checkItem({ vod_name: 'SSIS-304 普通の人妻', type_name: '爱播资源', vod_class: '强奸乱伦' }, S).ok) throw new Error('[adult/policy] 自检失败(strict):可信番号的 强奸乱伦 分类片被误拦');
    if (!checkItem({ vod_name: '[无码流出] 某作品', type_name: '日本无码' }, {}).ok) throw new Error('[adult/policy] 自检失败:无码流出 被误拦');
    if (!checkItem({ vod_name: '二〇二四年 精选合集', type_name: '国产自拍' }, {}).ok) throw new Error('[adult/policy] 自检失败:数字里的 〇 被当打码符');
    if (!checkQuery('迷奸') || checkQuery('人妻 温泉')) throw new Error('[adult/policy] 自检失败:checkQuery');
})();

module.exports = { RULES_VERSION, POLICY_REV, checkQuery, checkItem, filterItems };
