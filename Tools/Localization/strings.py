"""The one place the app's copy is translated.

Keys are the Chinese source sentences — see `LanguageManager.swift` for why.
`EN` maps a key to its English text; `generate.py` writes both `.lproj` files
from this table, and `check.py` proves the table is complete and that no
translation has a different number of `%@` than its source.

Placeholders are always `%@` and always take a `String`. Never add or drop one,
and never reorder them: Foundation reads the arguments positionally, and a
mismatch is a crash rather than a bad label.
"""

EN: dict[str, str] = {
    # MARK: Plurals and counts
    "%@ · 剩余 %@": "%@ · %@ left",    "%@ 个文件 · %@": "%@ files · %@",
    "%@ 包": "%@ bags",
    "%@ 天": "%@ days",
    "%@ 条": "%@ entries",
    "%@ 条待送达": "%@ scheduled",
    "%@ 次": "%@ brews",
    "%@ 分": "%@ points",
    "%@ 星": "%@ stars",
    "约 %@ 天": "About %@ days",
    "约 %@ 次": "About %@ brews",
    "只剩 %@ 次的量": "Only about %@ brews left",
    "查看全部 %@ 条": "Show all %@",
    "清理 %@ 个无用的图片": "Clean up %@ unused images",
    "已清理 %@ 个文件": "Removed %@ files",
    "已自定义 %@ 项": "%@ customised",
    "保存后剩余 %@": "%@ left after saving",
    "烘焙 %@": "Roasted %@",
    "平均 %@/次": "averaging %@ a brew",
    "按默认 %@/次 估算": "estimated at %@ a brew",

    # MARK: Phase and its five words
    "养豆": "Resting",
    "建议优先消耗": "Use first",
    "建议优先饮用": "Use this one first",
    "正在养豆": "Resting",
    "风味开始打开": "the flavour is opening up",
    "现在喝": "drink now",
    "可以等": "No rush",
    "照常喝": "As usual",
    "建议优先": "Use first",
    "尽快喝完": "Finish it soon",

    # MARK: Today's pick
    "今天": "Today",
    "今天建议": "Today's pick",
    "早上好": "Good morning",
    "中午好": "Good midday",
    "下午好": "Good afternoon",
    "晚上好": "Good evening",
    "风味正在打开": "The flavour is opening up",
    "还在养豆，风味还没打开": "Still resting — the flavour is not open yet",
    "已经喝完了": "This bag is finished",
    "还没有烘焙日期": "No roast date yet",
    "烘焙日期在未来": "The roast date is in the future",
    "上次这杯不太理想": "The last cup was not great",
    "还能冲": "brews left",
    "预计喝完": "Runs out",
    "不足一次": "Less than one brew",
    "已经见底": "almost gone",
    "预计还能喝 %@ 天": "about %@ days of coffee",
    "距离窗口结束约 %@ 天": "About %@ days left in the window",
    "窗口今天结束": "The window closes today",
    "已过窗口 %@ 天": "%@ days past the window",
    "已经进入窗口": "already in the window",
    "还有约 %@ 天进入窗口": "Opens in about %@ days",
    "填上烘焙日期就能看到阶段": "Add a roast date to see its phase",
    "填上烘焙日期，就能看到它现在处在哪个阶段": "Add the roast date and you will see which phase it is in",
    "烘焙日期在未来，请检查一下": "The roast date is in the future — worth a check",
    "排气期约 %@–%@ 天": "Rests for about %@–%@ days",
    "这包较晚才开封，封着的 %@ 天按半速计入，阶段相应顺延。": "Opened late — the %@ days it sat sealed count at half speed, so the phase is pushed back.",
    "这些是默认窗口，可以自己改": "These are the default windows — you can change them",
    "基于默认风味窗口估算": "estimated from the default window",

    # MARK: Reminders
    "提醒": "Reminders",
    "养豆完成": "Resting finished",
    "排气期结束，风味开始打开时提醒": "When degassing ends and the flavour starts to open",
    "%@ 养豆结束": "%@ has finished resting",
    "%@ 建议优先喝": "%@ — drink this one first",
    "%@ 的排气期基本结束，风味开始打开了。": "%@ has mostly finished degassing, and the flavour is starting to open up.",
    "这包豆子": "This bean",
    "系统通知权限已关闭，提醒不会送达。可以在「设置 › 通知 › BrewPhase」里重新打开。": "Notifications are switched off for BrewPhase, so reminders will not arrive. You can turn them back on in Settings › Notifications › BrewPhase.",
    "还没有请求通知权限，添加第一包豆子时会问一次": "Notification permission has not been asked for yet — it comes up once when you add your first bean",
    "提醒会根据每包豆子的烘焙日期自动排好": "Reminders line themselves up from each bag's roast date",
    "提醒会根据烘焙日期一次排好，不需要 App 在后台运行。": "Reminders are scheduled in one go from the roast date; the app never needs to run in the background.",

    # MARK: The bean
    "豆仓": "Cellar",
    "豆子": "Beans",
    "豆子清单": "Bean list",
    "添加豆子": "Add bean",
    "编辑豆子": "Edit bean",
    "豆仓还是空的": "Your coffee shelf is empty",
    "豆名": "Name",
    "未命名": "Untitled",
    "谁烘的": "Who roasted it",
    "烘焙商": "Roaster",
    "产区": "Origin",
    "处理法": "Process",
    "烘焙度": "Roast level",
    "浅烘": "Light",
    "中烘": "Medium",
    "中深烘": "Medium-dark",
    "深烘": "Dark",
    "意式拼配": "Espresso blend",
    "烘焙日期": "Roast date",
    "购买日期": "Bought",
    "开封日期": "Opened",
    "已经开袋": "Already opened",
    "记录开封日期和剩余量": "Track the open date and how much is left",
    "总克数": "Total",
    "剩余克数": "Remaining",
    "剩余": "Left",
    "未填写": "Not set",
    "价格": "Price",
    "元": "CNY",
    "渠道": "Channel",
    "在哪里买的": "Where you bought it",
    "线下门店": "In person",
    "网店": "Online",
    "备注": "Notes",
    "想记的事情，比如冲煮建议": "Anything worth noting, e.g. what to change next time",
    "烘焙与重量": "Roast and weight",
    "更多信息": "More details",
    "在喝": "Open",
    "已喝完": "Finished",
    "标记为已喝完": "Mark as finished",
    "恢复到在喝": "Mark as open again",
    "库存": "Stock",
    "调整": "Adjust",
    "调整剩余量": "Adjust stock",
    "剩余量按总克数算": "Remaining is counted against the bag's total",
    "剩余量 %@\\n当前总量 %@\\n\\n保存后总量会调整为 %@。":
        "Left %@\\nBag size %@\\n\\nSaving will set the bag size to %@.",
    "剩余量比总克数还多，已把总克数调到 %@": "There is more left than the bag holds, so the total was widened to %@",
    "剩余克数不能是负数": "The remaining amount cannot be negative",
    "总克数要大于 0": "The total weight has to be more than 0",
    "给它起个名字吧": "Give it a name",
    "烘焙日期还没选，风味阶段要靠它来算": "No roast date yet; the phase is worked out from it",
    "照片": "Photo",
    "加一张包装照片": "Add a photo of the bag",
    "拍照": "Camera",
    "相册": "Library",
    "换一张": "Replace",
    "移除": "Remove",
    "删除这包豆子": "Delete this bean",
    "删除": "Delete",
    "取消": "Cancel",
    "保存": "Save",
    "好": "OK",
    "没能保存": "Could not save",
    "没能保存下来，请再试一次": "Could not save. Please try again",
    "没能删除，请再试一次": "Could not delete. Please try again",
    "这张图片没能保存下来，可以换一张试试": "That image could not be saved. Try another one",
    "比如 Ethiopia Guji": "e.g. Ethiopia Guji",
    "比如 埃塞俄比亚 · Guji": "e.g. Ethiopia · Guji",
    "水洗": "Washed",
    "半日晒": "Semi-washed",
    "厌氧日晒": "Anaerobic natural",
    "拼配": "Blend",
    "水洗 / 日晒 / 厌氧": "Washed / Natural / Anaerobic",

    # MARK: Flavour timeline
    "风味变化": "Flavour over time",
    "风味标签": "Flavour tags",
    "还没有标签": "No tags yet",
    "可以以后再补": "You can add these later",
    "自定义": "Custom",
    "自己写一个": "Write your own",
    "花香": "Floral",
    "水果": "Fruit",
    "甜感": "Sweetness",
    "茉莉": "Jasmine",
    "玫瑰": "Rose",
    "橙花": "Orange Blossom",
    "柑橘": "Mandarin",
    "葡萄": "Grape",
    "蓝莓": "Blueberry",
    "草莓": "Strawberry",
    "桃": "Peach",
    "蜂蜜": "Honey",
    "焦糖": "Caramel",
    "红糖": "Brown Sugar",
    "巧克力": "Chocolate",
    "风味记录": "Tasting note",
    "记一笔风味": "Add a tasting note",
    "这杯怎么样": "How was it",

    # MARK: Brewing
    "冲煮": "Brews",
    "冲煮记录": "Brews",
    "记一次冲煮": "Record a brew",
    "编辑冲煮": "Edit brew",
    "开始冲煮": "Brew now",
    "复制上次冲煮": "Copy last brew",
    "已填入上次的参数": "Filled in from your last brew",
    "复制": "Copy",
    "参数": "Recipe",
    "器具": "Method",
    "粉量": "Dose",
    "水量": "Water",
    "粉水比": "Ratio",
    "水温": "Water temp",
    "时间": "Time",
    "研磨度": "Grind",
    "磨豆机": "Grinder",
    "日期": "Date",
    "味觉细项": "Taste detail",
    "可留空": "Optional",
    "酸": "Acidity",
    "甜": "Sweet",
    "苦": "Bitter",
    "醇厚": "Body",
    "余韵": "Aftertaste",
    "一句话总结": "One-line summary",
    "· 这次用掉的比剩下的还多": "· that is more than you have left",
    "先填粉量吧，这样才能从库存里扣掉": "Fill in the dose first — it is what gets deducted from your stock",
    "水量还没填，粉水比会留空": "No water yet, so the ratio stays blank",
    "水温还没填": "The water temperature is not filled in yet",
    "冲煮时间还没填": "The brew time is not filled in yet",
    "删除这条记录": "Delete this brew",
    "还没有冲煮记录": "No brews yet",
    "去豆仓挑一包，冲完记下参数和味道，这里就会长起来。": "Pick a bag from the cellar, brew it and note how it tasted — this is where it fills in.",
    "总次数": "Brews",
    "平均评分": "Average",
    "最常用": "Most used",
    "爱乐压": "AeroPress",
    "聪明杯": "Clever Dripper",
    "法压壶": "French press",
    "意式浓缩": "Espresso",
    "摩卡壶": "Moka pot",
    "冷萃": "Cold brew",
    "司令官 C40": "Comandante C40",
    "泰摩 栗子": "Timemore Chestnut",
    "22 格": "22 clicks",
    "比如 22 格": "e.g. 22 clicks",
    "比如 司令官 C40": "e.g. Comandante C40",
    "比如 甜感明显，下把可以再粗一点": "e.g. Sweet and clear; go a little coarser next time",
    "比如 甜感最明显，很干净": "e.g. Sweetest so far, very clean",

    # MARK: Settings
    "更多": "More",
    "默认冲煮参数": "Brew defaults",
    "新记录会从这里开始": "New brews start from these",
    "语言": "Language",
    "界面语言": "Language",
    "跟随系统": "Follow System",
    "立即生效": "Takes effect at once",
    "换语言不用重启，也不用改系统设置。选「跟随系统」就跟着手机走。": "No restart and no digging into system settings — pick “Follow System” and it tracks the phone.",
    "数据": "Data",
    "都在本机": "All local",
    "图片": "Photos",
    "导出": "Export",
    "导出 JSON": "Export JSON",
    "JSON 完整备份 · CSV 表格": "Full JSON backup · CSV tables",
    "完整备份": "Full backup",
    "表格": "Tables",
    "可以用 Excel 打开": "Opens in Excel",
    "包含豆子、冲煮、风味、提醒和窗口规则": "Beans, brews, tastings, reminders and window rules",
    "把记录带走": "Take your records with you",
    "导出的 JSON 可以完整还原你的记录。CSV 只包含豆子、冲煮和风味三张表，方便做统计。": "The JSON restores your records in full. The CSV holds three tables — beans, brews and tastings — for working with the numbers.",
    "导出的文件只保存在这台设备上，通过系统分享面板发给你自己。BrewPhase 不会上传任何东西。": "Exported files stay on this device and are handed to you through the system share sheet. BrewPhase uploads nothing.",
    "现在还没有记录。空数据也可以导出，出来的是一份结构完整、内容为空的文件。": "There are no records yet. An empty export is still fine — it comes out as a complete file with no records in it.",
    "正在准备文件…": "Preparing the files…",
    "导出时出了一点问题，请再试一次": "Something went wrong while exporting. Please try again",
    "没有需要清理的图片": "Nothing to clean up",
    "说明": "Notes",
    "风味": "Tastings",
    "规则": "Rules",
    "都是默认值": "All defaults",
    "排气开始": "Rest starts",
    "排气结束": "Rest ends",
    "窗口开始": "Window starts",
    "窗口结束": "Window ends",
    "衰退起点": "Decline starts",
    "已自定义": "Customised",
    "全部恢复默认": "Reset everything",
    "恢复默认": "Reset",
    "恢复默认窗口？": "Reset the windows?",
    "会把你改过的所有烘焙度都改回默认值。": "Every roast level you have edited goes back to its default.",
    "这些数字只是估算": "These numbers are estimates",
    "不同豆子、不同烘焙曲线都会不一样。下面是「%@」，改到符合你自己的经验就好。": "Every bean and every roast curve differs. The figures below are “%@”, so adjust them to match your own experience.",
    "这些数字只是「%@」，不是保质期，也不会说某包豆子过期了。": "These figures are only “%@”. They are not a use-by date, and the app will never call a bag expired.",
    "默认值：浅烘 7–28 天 · 中烘 5–21 天 · 中深烘 / 深烘 3–14 天 · 意式拼配 7–21 天。": "Defaults: Light 7–28 days · Medium 5–21 · Medium-dark / Dark 3–14 · Espresso blend 7–21.",
    "排气 %@–%@ · 窗口 %@–%@ · 衰退 %@": "Rest %@–%@ · Window %@–%@ · Decline %@",
    "排气 %@–%@ 天 · 窗口 %@–%@ 天 · %@": "Rest %@–%@ days · Window %@–%@ days · %@",
    "飞行模式下也能完整使用。": "Everything works in aeroplane mode.",
    "所有数据随时可以导出带走。": "All your data can be exported at any time.",

    # MARK: Demo fixture — sample coffee, translated so the interface is never
    # half one language and half the other.
    "启程咖啡": "Qicheng Coffee",
    "有容": "Yourong",
    "朋友送的": "A gift from a friend",
    "埃塞俄比亚 · Guji": "Ethiopia · Guji",
    "哥伦比亚 · 慧兰": "Colombia · Huila",
    "肯尼亚 · Nyeri": "Kenya · Nyeri",
    "巴西 · Cerrado": "Brazil · Cerrado",
    "巴拿马 · Boquete": "Panama · Boquete",
    "卢旺达 · Nyungwe": "Rwanda · Nyungwe",
    "手冲首选，V60 闷蒸 30 秒。": "First choice for pour-over; 30-second bloom on the V60.",
    "闻起来发酵感很足。": "Smells heavily fermented.",
    "先放着养一养。": "Leaving it to rest for now.",
    "深一点，做奶咖不错。": "A bit darker; good with milk.",
    "每天一杯奶咖的主力。": "The daily milk-drink workhorse.",
    "袋子上的烘焙日期磨掉了，等确认一下。": "The roast date on the bag has rubbed off — waiting to confirm it.",
    "味道淡了，收进柜子当纪念。": "The flavour has faded; retiring the bag to the shelf.",
    "刚开袋，酸质冲一点": "Just opened; the acidity is a bit sharp",
    "花香出来了，很干净": "The florals are showing, very clean",
    "目前最平衡的一杯": "The most balanced cup so far",
    "有点苦了": "A bit bitter",
    "入口有点闷": "A bit flat on entry",

    # MARK: Debug-only empty state, kept translated for screenshot parity
    "没有豆子可以展示": "Nothing to show yet",
    "简体中文": "简体中文",

    # MARK: Estimated flavour window (the experimental on-device model)
    #
    # Every one of these says "estimated". The model behind them is trained on
    # synthetic data, so none of this copy may read as a finding about the coffee
    # — which is also why the words "science", "guaranteed" and "accurate" do not
    # appear anywhere in this section.
    "预计风味窗口": "Estimated flavour window",
    "预计最佳": "estimated best",
    "预计还在养豆期": "estimated still resting",
    "预计已进入窗口": "estimated in its window",
    "预计已过峰值": "estimated past its peak",
    "这台设备上暂时算不出预计风味窗口": "This device cannot work out the estimated flavour window at the moment",
    "「%@」对应不到模型认识的类别，这次没有参与预测。": "“%@” does not match any category the model knows, so it took no part in this estimate.",
    "这些资料 App 还没有，已用模型训练时的典型值补上：%@": "BrewPhase has no field for these yet, so typical training values stood in: %@",
    "这些内容模型不认识，没有参与预测：%@": "The model did not recognise these, so they took no part in the estimate: %@",
    "模型用合成数据训练，结果只是估算，不能当成真实规律。": "The model was trained on synthetic data. This is only an estimate, not a real pattern.",
    "没有开封日期，开封时间按最早一次冲煮记录推算。": "There is no open date, so the bag is taken as opened at the first brew you recorded.",
    "实验性风味预测": "Experimental flavour prediction",
    "用合成数据训练的模型估算每包豆子的最佳风味窗口": "Estimate each bag's best flavour window with a model trained on synthetic data",
    "预计风味窗口已经关掉，详情页不会显示它。": "The estimated flavour window is switched off, so it will not appear on the bean page.",

    # The separator the missing-field list is joined with. A key of its own so
    # the English list reads "Variety, Altitude", not "Variety、Altitude".
    "、": ", ",

    # MARK: 标点本身也是文案
    #
    # 中文的句读在英文里不能照搬：列表分隔符是 ", "、句号是 ". "、括号前要留空格。
    # 这些键里没有汉字，所以 `keys.py` 是靠「出现在 L(...) 里」认出它们的——把标点
    # 直接写死在 Swift 里，英文界面上就会读到「Washed，Light。」
    "，": ", ",
    "。": ". ",
    "；": "; ",
    "（%@）": " (%@)",
    "%@（%@）": "%@ (%@)",
    "%@：%@": "%@: %@",
    "%@：%@（%@）": "%@: %@ (%@)",

    # MARK: Field names the model wants and the app does not have yet
    #
    # These double as the labels those fields should get when they are added to
    # the bean form, so they are written the way a form label wants to read.
    "产地": "Country",
    "品种": "Variety",
    "包装类型": "Packaging",
    "储存方式": "Storage",
    "储存温度": "Storage temp",
    "冲煮方式": "Brew method",
    "海拔": "Altitude",
    "发展时间": "Development time",
    "液重": "Yield",
    "冲煮时长": "Brew time",

    # MARK: Local RAG — the ask screen
    "问一问": "Ask",
    "正在问「%@」": "Asking about %@",
    "就这包豆子提问": "Ask about this bag",
    "从你自己的记录里找答案：什么时候开封的、哪次冲得最好":
        "Find the answer in your own records: when it was opened, which brew turned out best",
    "可以这样问": "Try asking",
    "想问我什么？比如「这包豆什么时候开封的」「我最近三次怎么冲的」「V60 一般用多少水温」。":
        "What would you like to ask? For instance: when was this bag opened, how did I brew the last three times, or what water temperature suits a V60.",
    "问点关于你的豆子的事…": "Ask something about your coffee…",
    "正在翻你的记录…": "Looking through your records…",
    "回答只用这台设备上的记录和 BrewPhase 自带的知识条目。不联网，不上传，也没有账号。":
        "Answers use only the records on this device and the knowledge notes that ship with BrewPhase. No network, no upload, no account.",
    "来自你的记录": "From your records",
    "来自 BrewPhase 知识库": "From the BrewPhase knowledge base",

    # Example questions

    # MARK: Local RAG — settings
    "开启本地智能": "Turn on local intelligence",
    "向量模型": "Embedding model",
    "每次取多少条资料": "Passages per question",
    "取太多会让相似记录挤在一起，太少又可能漏掉你真正想问的那条记录。":
        "Too many and the similar records crowd together; too few and the one you meant may never show up.",
    "换了向量模型或界面语言之后需要重建":
        "Needed after changing the embedding model or the interface language",
    "正在重建…": "Rebuilding…",
    "开始重建": "Start rebuild",
    "完成了：索引里现在有 %@ 条，这次重算了 %@ 条。":
        "Done: the index now holds %@ entries, and %@ were recomputed.",

    # MARK: Answer engines and embedding backends
    "本地摘要": "Local summary",
    "系统端侧模型": "On-device model",
    "端侧语义模型": "On-device semantic model",
    "本地词法匹配": "Local lexical matching",
    "Ollama 本地服务": "Ollama local service",
    "不用任何模型，直接把检索到的记录和知识整理成回答，永远可用":
        "Needs no model at all: the retrieved records and notes are organised into an answer, and it always works",
    "用 Apple 的端侧模型生成，需要支持的设备和已开启的 Apple 智能":
        "Generated by Apple's on-device model; needs supported hardware with Apple Intelligence switched on",
    "在本机运行模型生成，回答更自然，但需要你先把 Ollama 跑起来":
        "Generated by a model running on this machine: more natural, but you have to start Ollama first",
    "系统自带，离线可用，按界面语言选择模型":
        "Built into the system, works offline, picks a model for the interface language",
    "不依赖任何模型，中英混写也能匹配，但只认字面相近":
        "Depends on no model and copes with mixed Chinese and English, but only matches on literal wording",
    "需要本机运行 Ollama，换模型更灵活":
        "Requires Ollama running locally; makes swapping models easy",
    "可用": "Available",
    "这台设备不支持 Apple 智能": "This device does not support Apple Intelligence",
    "系统里还没有打开 Apple 智能": "Apple Intelligence is not switched on in the system",
    "系统模型还没有准备好，稍后再试": "The system model is not ready yet; try again later",
    "系统端侧模型暂时不可用": "The on-device model is unavailable for now",
    "需要 iOS 26 或更新的系统": "Needs iOS 26 or later",

    # MARK: Query intents
    "有哪些豆子": "Inventory",
    "冲煮参数": "Brew recipe",
    "时间与天数": "Timing",
    "评分": "Score",
    "当前状态": "Current state",
    "口味偏好": "Taste preference",
    "相似经历": "Similar experiences",
    "咖啡知识": "Coffee knowledge",
    "检索范围：%@": "Search scope: %@",
    "最近 %@ 条": "last %@",
    "最近 %@ 天": "last %@ days",

    # MARK: Knowledge base categories
    #
    # 水温 / 粉水比 / 处理法 already have entries further up as bean-form field
    # labels. The same word serves both roles, and one key cannot hold two
    # translations, so they are deliberately not repeated here.
    "研磨": "Grind",
    "萃取时间": "Extraction time",
    "烘焙": "Roast",
    "新鲜度": "Freshness",
    "品鉴": "Tasting",

    # MARK: Context and prompt
    "【用户自己的记录】": "[The user's own records]",
    "【BrewPhase 内置知识库】": "[The BrewPhase built-in knowledge base]",
    "（没有找到和这个问题相关的记录）": "(no records relevant to this question were found)",
    "（没有找到相关的知识条目）": "(no relevant knowledge entries were found)",
    "问题：%@": "Question: %@",
    "你是 BrewPhase 里的助手，帮用户看懂他自己的咖啡记录。用户是喝手冲的人，不是工程师。":
        "You are the assistant inside BrewPhase, helping the user make sense of their own coffee records. They brew pour-over; they are not an engineer.",
    "下面会给你两部分资料：一部分是用户自己的豆子、冲煮和风味记录，一部分是 BrewPhase 自带的咖啡常识。":
        "You will be given two sets of material: the user's own bags, brews and tasting notes, and the coffee background notes that ship with BrewPhase.",
    "只依据这些资料回答。资料里没有的数字、日期、克数、分数，一个都不要写。":
        "Answer only from that material. Do not write any number, date, weight or score that does not appear in it.",
    "每条资料前面有一个编号，例如 [1]。你的回答里用到哪一条，就在那句话末尾写上它的编号。":
        "Each item is preceded by a number, for example [1]. When your answer draws on one, put its number at the end of that sentence.",
    "要分清来源：说用户自己做过什么、喝到什么，只能引用「用户自己的记录」那部分；说通用的咖啡常识，才引用知识库那部分。":
        "Keep the sources apart: statements about what the user did or tasted may cite only the user-records set; general coffee background may cite the knowledge base.",
    "如果资料不足以回答，就直接说找不到，并说清缺什么。不要用常识补一个听起来合理的答案。":
        "If the material is not enough, say plainly that it cannot be found and what is missing. Do not fill the gap with general knowledge and make it sound plausible.",
    "回答直接给结论，三到五句话。不要复述资料原文，也不要解释你是怎样检索的。":
        "Lead with the conclusion, in three to five sentences. Do not restate the source text, and do not explain how you searched.",
    "回答的语言要和上面这些说明一致。": "Answer in the same language as these instructions.",

    # MARK: Extractive answers
    "相关的记录": "Related records",
    "看出来的问题": "What stands out",
    "你的记录里没有相关内容，上面只有知识库里的通用说法，不代表你的实际情况。":
        "Nothing in your records covers this, so the above is general background from the knowledge base rather than your own situation.",
    "我在你的记录和 BrewPhase 知识库里都没有找到和这个问题相关的内容。可以换个说法再问一次，或者先补上这包豆子的烘焙日期、开封日期这类信息。":
        "I could not find anything in your records or in the BrewPhase knowledge base that answers this. Try wording it differently, or fill in the bag's roast and opening dates first.",
    "抱歉，这次没能生成回答。": "Sorry, no answer could be generated this time.",

    # MARK: Structured facts
    "豆仓现状": "Your cellar right now",
    "用户现在有 %@ 包还没喝完的豆子。": "The user currently has %@ bags that are not finished.",
    "烘焙后第 %@ 天": "day %@ after roast",
    "没有烘焙日期": "no roast date",
    "「%@」：%@，%@，剩 %@。": "%@: %@, %@, %@ left.",
    "「%@」的评分": "Scores for %@",
    "这包豆冲过 %@ 次，但用户一次都没有打过分。":
        "The user has brewed this bag %@ times but never scored one.",
    "「%@」一共冲过 %@ 次，其中 %@ 次打过分，平均 %@ 分。":
        "The user brewed %@ %@ times, scored %@ of them, averaging %@.",
    "最高 %@ 分，出现在 %@。": "The best was %@, on %@.",
    "按时间从新到旧：%@。": "Newest first: %@.",
    "「%@」的时间线": "Timeline for %@",
    "烘焙日期是 %@，今天是烘焙后第 %@ 天。": "Roasted on %@; today is day %@ after roast.",
    "这包豆子没有记录烘焙日期。": "No roast date was recorded for this bag.",
    "购买日期是 %@。": "Bought on %@.",
    "开封日期是 %@，已经开封 %@ 天。": "Opened on %@; it has been open %@ days.",
    "没有记录开封日期。": "No opening date was recorded.",
    "窗口规则里的黄金期是第 %@–%@ 天，今天在第 %@ 天。":
        "The rule's peak window runs from day %@ to %@; today is day %@.",
    "「%@」的冲煮参数": "Brew recipe for %@",
    "这包豆还没有冲煮记录。": "There are no brews recorded for this bag yet.",
    "「%@」最近的 %@ 次冲煮参数（从新到旧）：":
        "The last %@ brews of %@ (newest first):",
    "「%@」现在的状态": "Where %@ stands now",
    "「%@」今天是烘焙后第 %@ 天，处于「%@」（%@）。":
        "%@ is on day %@ after roast, in %@ (%@).",
    "「%@」没有烘焙日期，无法判断处在哪个阶段。":
        "%@ has no roast date, so its phase cannot be worked out.",
    "按窗口规则现在适合喝。": "By the window rules it is ready to drink now.",
    "距离进入窗口还有约 %@ 天。": "About %@ days until it enters the window.",
    "已经过了窗口约 %@ 天。": "The window closed about %@ days ago.",
    "还剩 %@。": "%@ left.",

    # MARK: Document content
    "「%@」是 %@ 的一包咖啡豆。": "%@ is a bag of coffee from %@.",
    "没有记录烘焙商": "an unrecorded roaster",
    "处理法：%@": "Process: %@",
    "烘焙度：%@": "Roast: %@",
    "%@ 烘焙": "roasted %@",
    "%@ 购买": "bought %@",
    "%@ 开封": "opened %@",
    "规格 %@，目前剩 %@。": "%@ bag, %@ left.",
    "风味标签：%@。": "Flavour tags: %@.",
    "备注：%@": "Notes: %@",
    "今天是烘焙后第 %@ 天，处于「%@」。": "Today is day %@ after roast, in %@.",
    "这包豆子没有烘焙日期，所以无法判断它现在处于哪个阶段。":
        "This bag has no roast date, so there is no way to tell which phase it is in.",
    "这包豆一共冲过 %@ 次，最近一次评分 %@ 分（%@）。":
        "This bag has been brewed %@ times; the most recent score was %@ (%@).",
    "这包豆一共冲过 %@ 次，还没有打过分。": "This bag has been brewed %@ times and never scored.",
    "这包豆已经标记为喝完。": "This bag is marked as finished.",
    "一包没有记录的豆子": "an unrecorded bag",
    "没有名字的豆子": "Unnamed bag",
    "%@ 的 %@ 冲煮": "%@ %@ brew",
    "%@ 的风味记录": "Tasting on %@",
    "用户在 %@ 用「%@」做了一次 %@。": "On %@ the user brewed %@ with a %@.",
    "这次冲煮在烘焙后第 %@ 天。": "That brew was on day %@ after roast.",
    "这次评分 %@ 分": "Scored %@",
    "酸 %@": "acidity %@",
    "甜 %@": "sweetness %@",
    "苦 %@": "bitterness %@",
    "醇厚度 %@": "body %@",
    "余韵 %@": "aftertaste %@",
    "记录到的风味：%@。": "Flavours recorded: %@.",
    "用户在 %@ 给「%@」记了一次风味，那时是烘焙后第 %@ 天。":
        "On %@ the user logged a tasting for %@, at day %@ after roast.",
    "评分 %@ 分。": "Scored %@.",
    "风味：%@。": "Flavours: %@.",
    "用户写下的原话：%@": "The user's own words: %@",
    "这条是用户单独记的，不是某次冲煮的附笔。":
        "This note was written on its own, not as a by-product of a brew.",
    "用户给高分时最常记到的风味是：%@。":
        "The flavours the user logs most often on high-scoring brews: %@.",
    "用户最常用的冲煮方式是：%@。": "The brewing methods the user reaches for most: %@.",
    "用户常用的磨豆机是：%@。": "Grinders the user uses: %@.",
    "用户常用的参数是：%@。": "The settings the user tends to use: %@.",
    "用户评价最高的豆子是：%@。": "The user's highest-rated bags: %@.",
    "用户目前有 %@ 包豆子、%@ 次冲煮记录。":
        "The user currently has %@ bags and %@ brews on record.",

    # Recipe line fragments. Kept short because they are joined with the app's
    # middle dot into a single table-like row.
    "粉 %@": "%@ coffee",
    "水 %@": "%@ water",
    "粉量 %@": "%@ coffee",
    "水量 %@": "%@ water",
    "粉量约 %@": "about %@ coffee",
    "水量约 %@": "about %@ water",
    "粉水比 %@": "ratio %@",
    "水温 %@°C": "%@°C",
    "水温约 %@°C": "about %@°C",
    "研磨 %@": "grind %@",
    "研磨度 %@": "grind %@",
    "磨豆机 %@": "grinder %@",
    "总时间 %@": "total time %@",
    "%@（%@ 次）": "%@ (%@)",
    "%@（平均 %@ 分）": "%@ (avg %@)",

    # MARK: Local RAG — failures and index notices
    "连不上 Ollama：%@": "Could not reach Ollama: %@",
    "Ollama 返回了 %@：%@": "Ollama returned %@: %@",
    "Ollama 的回答看不懂：%@": "Ollama's response made no sense: %@",
    "这个回答引擎现在用不了：%@": "That answer engine is unavailable right now: %@",
    "引擎返回了空回答": "the engine returned an empty answer",
    "%@ 没能给出回答：%@": "%@ could not produce an answer: %@",
    "换了向量模型或界面语言，索引已重建。":
        "The embedding model or interface language changed, so the index was rebuilt.",
    "读取索引失败，这一轮没有可用的历史记录。":
        "Reading the index failed, so no past records were available this time.",
    "写入索引失败，这一轮的回答可能不完整。":
        "Writing the index failed, so this answer may be incomplete.",
    "有 %@ 条资料没能算出向量，这次检索里没有它们。":
        "%@ items could not be embedded and are missing from this search.",
    "选用的向量模型在这台设备上不可用，已退到%@。":
        "The chosen embedding model is not available on this device; fell back to %@.",
    "索引里还没有任何资料，这一轮只用了直接查询。":
        "The index is still empty, so this answer used direct lookups only.",
    "还有 %@ 条相关资料因为篇幅没有放进来。":
        "%@ more relevant items did not fit in the context.",

    # MARK: Local intelligence V1 — rules, recommendations, insights
    #
    # 这一层没有任何生成式模型：全部文案是模板，全部数字来自用户自己的记录。
    # 措辞的边界由此而来——偏离只说「和你常用的不一样」，相似只报告分布，
    # 证据不足时把真实阈值（IntelligenceConfig 里的那个数）原样说出来。

    # 洞察页与设置入口
    "洞察": "Insights",
    "相似冲煮": "Similar brews",
    "我的最佳参数": "My best parameters",
    "豆仓里还没有豆子。先加一包，喝过几次之后这里就会有话说了。":
        "No bags in the cellar yet. Add one and brew it a few times, and this page will have something to say.",
    "建议与分析只来自你记录里的数字和既定规则；没有历史的地方会直接说证据不足。":
        "Every suggestion comes from the numbers in your records and fixed rules; where there is no history it simply says the evidence is not enough.",

    # 今日建议（Rule 1，复用既有优先级引擎）
    "建议优先喝：%@": "Drink %@ first",
    "今天可以先喝这包：%@": "You could start with %@ today",
    "开封后第 %@ 天": "day %@ after opening",
    "剩余 %@": "%@ left",
    "过去平均 %@ 分": "averaged %@ before",
    "预计还能冲 %@ 次": "about %@ more brews",

    # 我的最佳参数（Rule 2）
    "「%@」你评分最高的一次": "Your highest-scoring brew of %@",
    "%@ 打了 %@ 分。": "%@ scored %@.",
    "那一天": "that day",
    "这包豆的历史还不够给出最佳参数": "Not enough history on this bag for best parameters",
    "至少需要 %@ 条带评分的冲煮记录后才能进行比较。":
        "At least %@ scored brews are needed before a comparison is possible.",
    "这包豆目前有 %@ 次带评分的记录。": "This bag currently has %@ scored brews.",
    "高评分记录的水温通常在 %@ 到 %@": "Your high-scoring brews usually ran %@–%@ water",
    "高评分记录的萃取时间通常在 %@ 到 %@": "Your high-scoring brews usually ran %@–%@ total",
    "高评分记录的粉水比通常在 1:%@ 到 1:%@": "Your high-scoring brews usually ran 1:%@–1:%@",
    "高评分记录的粉量通常在 %@ 到 %@": "Your high-scoring brews usually used %@–%@ of coffee",

    # MARK: 天气场景与做法建议
    "手冲还是意式": "Filter or espresso",
    "今天适合%@：%@": "Today suits %@: %@",
    "你用%@平均打了 %@ 分（%@ 次）。": "Your %@ averages %@ over %@ brews.",
    "%@：平均 %@ 分（%@ 次）": "%@: %@ on average over %@ brews",
    "同一个做法至少要冲过 %@ 次才能比较；现在有 %@ 次带评分的记录。":
        "A method needs at least %@ scored brews before they can be compared; there are %@ so far.",
    "这包豆的历史还不够给出做法建议": "Not enough history on this bag for a method suggestion",
    "这包豆自己还没有足够的记录，这次按你全部豆子的历史统计。":
        "This bag does not have enough records of its own yet, so the statistics cover every bag.",
    "浅烘的果酸和花香在手冲里最放得开。":
        "Light roasts open up best as filter: the fruit and florals get room.",
    "中烘两头都搭，手冲和加奶都稳。": "Medium roasts go either way: filter or milk, both hold up.",
    "偏深的烘焙压得住奶，做意式或加奶都不闷。":
        "Darker roasts stand up to milk; espresso or milk drinks stay clean.",
    "手冲/滤泡": "filter",
    "意式/奶咖": "espresso",
    "冷萃/冰饮": "cold brew",

    # 参数偏离（Rule 3）
    "还比较不了这次的参数": "This brew cannot be compared yet",
    "这次参数和你高评分记录的范围基本一致":
        "This brew sits within the range your high-scoring brews usually use",
    "每一项都在你自己的常用区间里，没有需要提醒的偏离。":
        "Every parameter sits inside your own usual range; nothing worth flagging.",
    "这次参数偏离了你高评分记录的常用范围":
        "This brew drifts from the range your high-scoring brews usually use",
    "%@ 比你常用值高了 %@": "%@ ran %@ above your usual",
    "%@ 比你常用值低了 %@": "%@ ran %@ below your usual",
    "%@：当前 %@（常用 %@）": "%@: now %@ (usual %@)",
    "%@ 秒": "%@ s",

    # 相似冲煮（Rule 4，唯一的语义检索入口）
    "找到 %@ 条相似记录": "Found %@ similar records",
    "没有找到相似的记录": "No similar records found",
    "换一个说法再试，比如直接写「尾段发干」。":
        "Try wording it differently, for example tail dries up.",
    "%@ 条里有 %@ 次都用的是 %@。": "%@ of the %@ records used %@.",
    "这些记录的平均评分是 %@ 分。": "These records average %@.",
    "「%@」": "\u201c%@\u201d",

    # MARK: Bean → Knowledge Linking（实体类型 / 范围 / 命中方式 / 关系）
    "主题": "Topic",
    "品种谱系": "Variety group",
    "冲煮家族": "Brew family",
    "感官": "Sensory",
    "水质": "Water",
    "故障": "Troubleshooting",
    "维护": "Maintenance",
    "设备": "Equipment",
    "通用": "Generic",
    "国家级": "Country level",
    "产区级": "Region level",
    "品种级": "Variety level",
    "处理法级": "Process level",
    "烘焙级": "Roast level",
    "冲煮方式级": "Brew-method level",
    "品牌级": "Brand level",
    "型号级": "Model level",
    "完全匹配": "Exact match",
    "规范匹配": "Canonical match",
    "别名匹配": "Alias match",
    "层级匹配": "Hierarchy match",
    "推断匹配": "Inferred match",
    "你指定的": "You chose this",
    "背景关联": "Background link",
    "推荐冲煮": "Suggested brewing",
    "背景知识": "Background",

    # MARK: Bean → Knowledge Linking（证据归属 / 结果类型）
    "你的记录": "Your records",
    "知识库": "Knowledge base",
    "分析": "Analysis",
    "这包豆的状态": "This bag's status",
    "你的最佳参数": "Your best parameters",
    "参数偏离": "Parameter drift",
    "相关知识": "Related knowledge",
    "故障排查": "Troubleshooting",
    "设备指引": "Equipment guidance",

    # MARK: Bean → Knowledge Linking（卡片文案）
    "关于这包豆": "About this bean",
    "与本杯相关": "Relevant to this brew",
    "正在关联知识…": "Linking knowledge…",
    "正在找相关知识与记录…": "Looking for related knowledge and records…",
    "这包豆子还没填产地、处理法或风味，暂时无法关联知识。":
        "This bag has no origin, process or flavour notes yet, so nothing can be linked.",
    "暂时没有这包豆子的专属资料，下面显示的是更上层的通用知识。":
        "Nothing specific to this bag yet; what follows is broader, generic knowledge.",
    "已关联 %@ 条与这包豆子直接相关的知识。":
        "Linked %@ entries of knowledge directly relevant to this bag.",
    "这次用的是 %@，暂时没有与之直接相关的知识。":
        "This brew used %@; nothing directly relevant found yet.",
    "这次用的是 %@，找到 %@ 条相关知识与记录。":
        "This brew used %@; found %@ entries of related knowledge and records.",
    "这次冲煮": "this brew",
    "还没有填：%@。填上之后关联会更准。":
        "Not filled in yet: %@. Filling these in makes the linking more accurate.",
    "知识是通用起点，不是这包豆子唯一正确的参数。":
        "This is a general starting point, not the one correct recipe for this bag.",
    "一次只改一个变量，否则事后不知道是哪一项起的作用。":
        "Change one variable at a time, or you will not know which one did the work.",
    "这包豆有 %@ 次带评分的冲煮记录。": "This bag has %@ scored brews.",
    "这包豆目前只有 %@ 次带评分的记录，还形不成区间。":
        "This bag has only %@ scored brews so far — not enough to form a range.",
    "个人最佳参数还不可用：至少需要 %@ 条带评分的记录。":
        "Personal best is not available yet: at least %@ scored brews are needed.",
    "带评分的记录还不够 %@ 条，所以这次不给个人化结论。":
        "Fewer than %@ scored brews so far, so no personalised conclusion this time.",
    "你的高评分记录集中在 %@ 到 %@°C。":
        "Your high-scoring brews cluster between %@ and %@°C.",
    "先从你自己的高评分区间试：%@。":
        "Start from your own high-scoring range: %@.",
    "这是从 %@ 次高评分记录里算出来的区间，不是通用建议。":
        "This range comes from your %@ high-scoring brews, not from general advice.",
    "水温 %@–%@°C": "Water %@–%@°C",
    "时间 %@–%@": "Time %@–%@",
    "内置知识库": "Built-in knowledge base",
    "咖啡基础": "Coffee basics",
    "咖啡与健康": "Coffee and health",
    "清洁维护": "Cleaning and care",
    "术语": "Terminology",

    # MARK: Multi-turn conversation
    "正在讨论：%@": "Discussing: %@",
    "沿用上一轮：%@": "Carried over from the previous turn: %@",
    "这一轮在问：%@": "This turn asks about: %@",
    "这一轮在问：%@（%@）": "This turn asks about: %@ (%@)",
    "推荐": "Recommendation",
    "压力": "Pressure",
    "高一点": "a bit higher",
    "低一点": "a bit lower",
    "细一点": "a bit finer",
    "粗一点": "a bit coarser",
    "快一点": "a bit faster",
    "慢一点": "a bit slower",
    "多一点": "a bit more",
    "少一点": "a bit less",
    "回答只用你的记录和 BrewPhase 知识库，所以我不猜。":
        "This answer only uses your own records and the built-in BrewPhase knowledge base, "
        "so I will not guess.",
    "「%@」我还不确定指哪包豆子。可以说一下豆名，或者从豆子的页面进来问我。":
        "\"%@\": I cannot tell which bag you mean. Name the coffee, or open its page and ask from there.",
    "「%@」我还不确定指哪种冲法。直接说器具名就行，比如 V60、爱乐压。":
        "\"%@\": I cannot tell which brew method you mean. Just name the brewer — V60, AeroPress, "
        "that sort of thing.",
    "「%@」我还不确定指哪台器具。说个型号我就知道了。":
        "\"%@\": I cannot tell which piece of gear you mean. Give me a model name and I will know.",
    "「%@」我这边还没有能对上的冲煮记录。先说一次具体的冲煮，或者打开那次记录再问我。":
        "\"%@\": I do not have a brew record that matches yet. Point me at a specific brew, or open "
        "that record and ask me from there.",
    "「%@」我还不确定指哪个参数。是想说水温、研磨、时间，还是粉水比？":
        "\"%@\": I cannot tell which parameter you mean. Water temperature, grind, time, or ratio?",
    "「%@」我还不确定指的是哪一个。先说说这包豆子的产区或处理法，我就能接上。":
        "\"%@\": I cannot tell which one you mean. Tell me the origin or the process of the bag and "
        "I will pick it up.",

    # MARK: Quick brew log and diagnosis
    "记一杯": "Log a cup",
    "记下了": "Logged",
    "记下这一杯": "Log this cup",
    "再记一杯": "Log another",
    "最近一杯": "Last cup",
    "完成": "Done",
    "完整表单": "Full form",
    "哪包豆": "Which bag",
    "选一包豆": "Pick a bag",
    "怎么冲的": "How you brewed",
    "可以不填": "optional",
    "更多参数": "More parameters",
    "添加风味": "Add flavours",
    "收起风味": "Hide flavours",
    "这次改了": "Changed this time",
    "沿用这包豆上一次的参数": "Reusing the last brew of this bag",
    "沿用你上一次冲的参数": "Reusing your last brew",
    "用你设的默认参数": "Using your default parameters",
    "先加一包豆，再记这一杯。": "Add a bag first, then log this cup.",
    "这次记录还差一点信息": "This record is missing something",
    "本次表现": "This cup",
    "下一杯建议": "Next cup",
    "下一杯：%@": "Next cup: %@",
    "只改一件事": "one change only",
    "优先调整": "Change first",
    "保持不变": "Keep unchanged",
    "下一杯留意": "Watch next time",
    "依据": "Evidence",
    "展开依据": "Show evidence",
    "收起依据": "Hide evidence",
    "另外还看到": "Also seen",
    "知识库怎么说": "What the knowledge base says",
    "冲煮诊断": "Brew diagnosis",
    "可能萃取不足": "Possibly under-extracted",
    "可能过萃": "Possibly over-extracted",
    "冲得偏快": "Running fast",
    "冲得偏慢": "Running slow",
    "甜感偏低": "Low sweetness",
    "苦味偏重": "High bitterness",
    "口感偏薄": "Thin body",
    "参数偏离你的较好记录": "Parameters away from your better brews",
    "证据较足": "Solid evidence",
    "可以参考": "worth trying",
    "只是方向": "directional",
    "证据不足": "Not enough evidence",
    "水量不变、多加一点粉，浓度和口感都会厚起来。":
        "Same water, a little more coffee: stronger and fuller.",
    "口感更饱满，风味更集中。": "Fuller body, more concentrated flavour.",
    "多加一点粉": "a little more coffee",
    "少一点粉": "a little less coffee",
    "细一档": "one step finer",
    "粗一档": "one step coarser",
    "稍微延长": "a little longer",
    "稍微缩短": "a little shorter",
    "调高一点": "a little warmer",
    "调低一点": "a little cooler",
    "回到你常用的粉量，浓度更接近你的记录。":
        "Back to your usual dose brings the strength closer to your own records.",
    "回到你自己表现更好的温度区间。":
        "Back into the temperature range that works better for you.",
    "甜感和香气更容易出来。": "Sweetness and aroma come out more easily.",
    "时间不短但甜感没上来时，升温通常比磨细更有效。":
        "When the time is fine but sweetness is missing, a warmer brew usually helps more than a "
        "finer grind.",
    "萃取更充分：甜感上来，酸质变柔和。":
        "More complete extraction: more sweetness, softer acidity.",
    "时间偏短是萃取不足最常见的信号，磨细是最直接的补救。":
        "A short brew is the most common under-extraction signal; going finer is the direct fix.",
    "先把流速拉回你自己的区间，再谈别的。":
        "Get the flow back into your own range first.",
    "水流慢一点，萃取更完整。": "Slower flow, more complete extraction.",
    "总时间缩短，风味更干净。": "Shorter total time, cleaner cup.",
    "时间偏长，又有苦或干涩，通常是磨得太细。":
        "A long brew plus bitterness or dryness usually means the grind is too fine.",
    "少萃一点：苦和干涩会退下去。":
        "Extract a little less: bitterness and dryness should recede.",
    "苦味明显高于你自己的记录，先往粗的方向试。":
        "Bitterness is clearly above your own records; try coarser first.",
    "苦味变轻，甜感更容易露出来。": "Less bitterness, sweetness shows through.",
    "让水流快一点，回到你自己的区间。":
        "Speed the flow back up into your own range.",
    "这一杯和你自己表现较好的记录差得比较远。":
        "This cup sits well away from your better brews.",
    "这一杯和你自己评价较高的那几次差得比较远。":
        "This cup sits well away from the brews you rated higher.",
    "水流过快、萃取不够，常见的表现是酸高、甜少、口感偏薄。":
        "Too fast a flow under-extracts: usually high acidity, little sweetness and a thin body.",
    "萃得太久或太细，常见的表现是苦、干、余韵拖得长。":
        "Too long or too fine over-extracts: usually bitter, drying and a long finish.",
    "这一杯比你自己的记录快，通常意味着通道或研磨偏粗。":
        "This cup ran faster than your own records — usually channelling or too coarse a grind.",
    "这一杯比你自己的记录慢，通常是研磨偏细或细粉堵住了。":
        "This cup ran slower than your own records — usually too fine a grind or fines clogging "
        "the filter.",
    "甜感低于你自己好喝的那几杯。": "Less sweet than your own better cups.",
    "苦味高于你自己好喝的那几杯。": "More bitter than your own better cups.",
    "口感比你自己好喝的那几杯更薄。": "Thinner than your own better cups.",
    "这一杯在你自己的记录里没有明显异常。":
        "This cup shows nothing unusual against your own records.",
    "最近这一杯在你自己的记录里没有明显异常。":
        "The latest cup shows nothing unusual against your own records.",
    "目前数据还不足以建立个人基线。":
        "There is not enough data yet to build a personal baseline.",
    "目前「%@」有 %@ 次带评分的记录，还差 %@ 次才能形成稳定的个人基线。":
        "\"%@\" has %@ scored brews so far; %@ more and a stable personal baseline forms.",
    "继续记几杯，BrewPhase 会用你自己的数据给出建议。":
        "Keep logging a few more cups; BrewPhase will advise from your own data.",
    "参考记录还只有 %@ 次，判定只是方向性的。":
        "Only %@ reference brews so far — this reading is directional.",
    "这杯没有填味觉细项，判断主要依据时间和参数。":
        "No taste detail was filled in for this cup; the reading leans on time and parameters.",
    "这杯没有填醇厚": "Body was left blank for this cup",
    "这杯的 %@ 是 %@/5": "%@ for this cup: %@/5",
    "这杯的 %@ 是 %@/5，你较好记录里最高 %@":
        "%@ for this cup: %@/5; highest among your better brews: %@",
    "这杯的 %@ 是 %@/5，你较好记录里最低 %@":
        "%@ for this cup: %@/5; lowest among your better brews: %@",
    "这杯的醇厚是 %@/5": "Body for this cup: %@/5",
    "备注里出现了干涩这类感觉：%@": "The note mentions dryness: %@",
    "备注里出现了水感/寡淡这类感觉：%@": "The note mentions wateriness or flatness: %@",
    "本次 %@，你的较好记录在 %@（快 %@）":
        "This cup %@; your better brews %@ — faster by %@",
    "本次 %@，你的较好记录在 %@（慢 %@）":
        "This cup %@; your better brews %@ — slower by %@",
    "%@ 本次 %@，你的较好记录在 %@–%@": "%@: this cup %@, your better brews %@–%@",
    "你的较好记录集中在 %@–%@": "Your better brews cluster around %@–%@",
    "你较好的记录在 %@–%@": "Your better brews sit at %@–%@",
    "依据：%@ 的 %@ 次高评分记录。": "Based on %@: %@ high-rated brews.",
    "这包豆": "this bag",
    "这包豆 + %@": "this bag + %@",
    "%@ 的做法": "your %@ brews",
    "另外还看到：%@。": "Also seen: %@.",
    # 「保持不变」那两条：标签与冒号写进键里，而不是在 Swift 里拼一个分隔符。
    # 理由见 `ExtractiveLLMProvider.bullet`——只由标点组成的键进不了这张表，
    # 英文界面下就会露出中文的全角冒号。星号是加粗标记，跟着整句一起走。
    "**保持不变**：%@": "**Keep unchanged**: %@",
    "**下一杯留意**：%@": "**Watch next time**: %@",
    "最近这一杯更接近「%@」（%@）。": "The latest cup is closer to \"%@\" (%@).",
    "「%@」最近这杯的分析": "Analysis of the latest cup of \"%@\"",
    "知识库说的是通常情况，你的记录说的是这包豆的实际情况；两者不一致时以你的记录为准。":
        "The knowledge base describes the general case; your records describe this bag. When they "
        "disagree, your records win.",
    "这一轮没有足够把握给出单向的调整建议。":
        "Not enough confidence this time to point at a single adjustment.",
    "上一轮的建议：%@": "Previous suggestion: %@",
    "总时间": "Total time",
    "酸质": "Acidity",
    "醇感": "Body",
    "苦味": "Bitterness",
    "香气": "Aroma",
    "干涩": "Dryness",
    "升温": "warmer",
    "降温": "cooler",
    "延长": "longer",
    "缩短": "shorter",
    "变淡": "weaker",
    "变浓": "stronger",
    "加粉": "more coffee",
    "减粉": "less coffee",
    "器具 %@": "Brewer %@",
    "水温 %@": "Water %@",
    # 演示数据里那杯「不太满意」的笔记。演示数据也是用户看得到的文字，
    # 英文界面下不该写着中文。
    "有点酸，尾段薄": "A little sour, thin finish",

    # MARK: 打不开本地数据时的恢复页
    # 这几句是用户在最糟的一天里看到的全部文字，所以只说三件事：发生了什么、
    # 为什么暂时不能用、下一步做什么。底层错误不在这张表里——它只进日志。
    "无法打开本地数据": "Cannot open your local data",
    "BrewPhase 暂时无法访问已有记录。\\n为了避免数据丢失，当前不会保存新的数据。":
        "BrewPhase cannot reach your records right now.\\nNothing new will be saved, so nothing gets lost.",
    "重新尝试": "Try again",
    "如果问题持续存在，请先确认设备存储空间正常。":
        "If this keeps happening, check that your device has enough free space.",

    # MARK: V2 第二批 —— 洞察四层 / 问一问入口 / 设置分组 / 上一杯对比
    "咖啡": "Coffee",
    "本地智能": "Local intelligence",
    "应用": "App",
    "高级设置": "Advanced settings",
    "检索": "Retrieval",
    "索引": "Index",
    "检索模型 · 取条数 · 重建索引": "Model · passage count · index rebuild",
    "这些选项影响问一问与洞察的检索方式；不改也完全能用。":
        "These affect how Ask and Insights search. The defaults work fine.",
    "BrewPhase 会结合你的咖啡记录和本地知识进行分析，数据不会上传到服务器。":
        "BrewPhase works from your coffee records and its built-in knowledge. Nothing is uploaded to a server.",
    "你有问题，直接问": "Ask whatever is on your mind",
    "它主动告诉你现在最值得关注什么": "It tells you what matters now, without being asked",
    "关掉之后不再维护索引，也不会做任何分析": "Off means no index upkeep and no analysis",
    "问问你的咖啡": "Ask about your coffee",
    "今天喝哪包": "Which bag today",
    "今天喝哪包？": "Which bag today?",
    "下一杯怎么调？": "How should the next cup change?",
    "最近哪杯最好？": "Which recent cup was the best?",
    "我最近的参数有什么变化？": "How have my parameters changed lately?",
    "上一杯为什么酸？": "Why was the last cup sour?",
    "「%@」现在是什么阶段？": "What stage is \"%@\" at now?",
    "下一步": "Next step",
    "与上一次相比": "vs. the last one",
    "这包豆还没有冲煮记录。记一杯之后，这里就是它的最新进展。":
        "No brews for this bag yet. Log one and this becomes its latest update.",
    "上一杯": "Last cup",
    "本次将沿用上次参数": "This brew starts from those parameters",
    "查看变化": "See changes",
    "收起对比": "Hide comparison",
    "上次建议": "Last suggestion",
    "这次：%@": "This time: %@",
    "调整方向与上次建议一致。": "The change went the way the last suggestion pointed.",
    "这次没有朝建议的方向调整。": "This cup did not move the way the suggestion pointed.",
    "这次评分比上一杯高。": "This cup scored higher than the last one.",
    "这次评分比上一杯低。": "This cup scored lower than the last one.",
    "酸度": "Acidity",
    "甜度": "Sweetness",
    "苦度": "Bitterness",
    "醇厚 %@": "Body %@",
    "阶段规则": "Stage rules",
    "手动记录": "Manual note",
    "养豆期": "Resting",
    "黄金风味期": "Peak window",
    "风味衰减": "Decline",
    "%@–%@ 天": "%@–%@ days",
    "%@ 天后": "After day %@",
    "高级阶段规则": "Advanced stage rules",
    "修改这些参数会影响 BrewPhase 对咖啡阶段的判断。":
        "Changing these numbers changes how BrewPhase reads every bag's stage.",
    "实验预测": "Experimental prediction",
    "预计风味窗口是实验功能，和阶段规则是两回事：一个是模型估计，一个是你自己定的规则。":
        "The flavour-window prediction is an experiment, and a different thing from the stage rules: "
        "one is a model's estimate, the other is yours.",
    "预计黄金风味期 %@ – %@": "Estimated peak window %@ – %@",
    "按上次的建议磨细了一档，酸降下来了": "Followed the last suggestion — ground a step finer, less sour",
    "闻着比喝着更香": "Smells even better than it tastes",

    # MARK: V2 第三批 —— onboarding / 空态 / 术语统一 / 删除确认 / 库存确认
    # 「养豆期」「黄金风味期」等键已在阶段规则一段里定义，这里不重复。
    "风味打开": "Flavour opening",
    "打开": "Opening",
    "黄金期": "Peak",
    "衰减": "Declining",
    "黄金风味期这两天就结束了": "The peak window closes in the next couple of days",
    "现在正处于黄金风味期": "Right in its peak window",
    "风味已经开始衰减": "The flavour has started to decline",
    "已过黄金风味期但还剩不少": "Past the peak window with plenty left",
    "黄金风味期比你的消耗速度更短": "A shorter peak window than your drinking pace",
    "进入黄金风味期": "Peak window opens",
    "黄金期过半": "Peak window halfway",
    "黄金期将尽": "Peak window closing",
    "进入黄金风味期时提醒": "When it enters its peak window",
    "黄金风味期走过一半时提醒": "Halfway through the peak window",
    "黄金风味期结束前两天提醒": "Two days before the peak window ends",
    "这包可能喝不完黄金风味期时提醒": "When the bag might not finish its peak window",
    "%@ 进入黄金风味期": "%@ has entered its peak window",
    "%@ 现在进入黄金风味期，可以开始喝了。":
        "%@ is now in its peak window — a good time to start drinking it.",
    "%@ 的黄金风味期过半了": "The peak window of %@ is half over",
    "%@ 的黄金风味期快结束了": "The peak window of %@ is closing soon",
    "%@ 的黄金风味期已经过半，接下来的风味会慢慢变平。":
        "The peak window of %@ is half over; the flavour will slowly flatten from here.",
    "%@ 的黄金风味期还剩两天，想喝到最好的状态就趁现在。":
        "Two days left in the peak window of %@ — drink it at its best while you can.",
    "%@ 的黄金风味期比你的消耗速度更短，建议优先喝完。":
        "%@ has a shorter peak window than your drinking pace — finish it first.",
    "必选": "Required",
    "选一个烘焙程度吧，阶段判断要靠它": "Pick a roast level — the stage depends on it",
    "补充烘焙商、产区与价格": "Add roaster, origin and price",
    "添加自定义风味": "Add a custom flavour",
    "还没有你的咖啡豆": "No coffee of yours yet",
    "添加第一包豆": "Add your first bag",
    "还没有冲煮记录\\n记下第一杯，之后才能看到你的参数变化和个人规律。":
        "No brews yet.\\nLog the first cup and your parameter patterns will start to show up here.",
    "这包豆还没有风味记录\\n记一杯或随手记一笔，它的变化就会出现在这里。":
        "No tasting notes for this bag yet.\\nLog a brew or jot a quick note and its changes will appear here.",
    "+%@ 天": "+%@ days",
    "删除这包咖啡豆？": "Delete this bag of coffee?",
    "删除后不可恢复。它关联的 %@ 条冲煮记录和 %@ 条风味记录也会一起被删除。":
        "This cannot be undone. Its %@ brews and %@ tasting notes will be deleted too.",
    "删除这条冲煮记录？": "Delete this brew?",
    "删除后不可恢复。这杯用掉的粉会回到原来那包豆的库存里。":
        "This cannot be undone. The coffee it used goes back to the bag's stock.",
    "删除这条风味记录？": "Delete this tasting note?",
    "删除后不可恢复。冲煮记录本身不受影响。": "This cannot be undone. The brew itself is not affected.",
    "剩余量高于总容量": "Remaining is more than the bag holds",
    "把总容量调整为 %@": "Set the bag size to %@",
    "保存后这包豆的总容量会从 %@ 变成 %@。历史记录不受影响。":
        "Saving will change the bag size from %@ to %@. History is not affected.",
    "发送": "Send",
    "收起完整分析": "Hide full analysis",
    "查看完整分析": "Show full analysis",
    "推荐提醒默认打开：进入黄金风味期、黄金期将尽、喝不完提示。养豆完成与黄金期过半默认关闭，按需开启。":
        "Recommended reminders are on by default: peak window opening, closing, and drink-up nudges. "
        "Rest-complete and halfway stay off until you turn them on.",
    "按现有的阶段规则，今天最该喝的是「%@」。": "By your stage rules, the bag to drink today is \"%@\".",
    "排气 %@–%@ 天 · 窗口第 %@–%@ 天 · 第 %@ 天开始衰减":
        "Rest %@–%@ days · window days %@–%@ · declining from day %@",

    # MARK: V2 第四批 —— 成品化：首页 / 引导 / 洞察措辞 / 关于页
    "我的咖啡豆": "My beans",
    "查看全部 %@ 包": "Show all %@ bags",
    "收起": "Show less",
    "先记下第一杯": "Log the first cup",
    "冲完随手记一笔，之后这里会自动带上一次的参数。":
        "Jot it down after brewing; the next log will pick up these parameters.",
    "豆仓暂时空了": "The cellar is empty",
    "添加下一包豆，继续记录你的风味轨迹。":
        "Add the next bag and keep tracing how your flavours move.",
    "记录每一包豆，看到风味怎么变化。先添加正在喝的这一包。":
        "Log every bag and watch its flavour move. Start with the one you're drinking.",
    "下次记这一杯，会自动带上这次的参数。":
        "Next time, this cup's parameters will be filled in for you.",
    "还在认识你的冲煮习惯": "Still learning how you brew",
    "再记录几杯，这里会开始出现你的个人规律。":
        "A few more cups and your own patterns will start to show up here.",
    "这是你自己的高分记录统计，不是专业标准。":
        "These ranges come from your own high-rated brews, not a professional standard.",
    "一本属于你的咖啡实验手册：记录每一包豆，看到风味怎么变化。":
        "A coffee notebook that's yours: log every bag and watch its flavour move.",
    "数据只存在这台设备上，没有账号，没有服务器。":
        "Your data stays on this device. No account, no server.",
    "隐私政策": "Privacy Policy",

    # MARK: 示例数据（审核与试用模式）
    "示例数据": "Sample data",
    "示例豆已在库中，关闭即整批移除": "Sample bags are installed — turning this off removes them all",
    "载入 7 包演示豆，体验完整功能": "Load 7 sample bags to explore every feature",
    "加入示例数据？": "Add sample data?",
    "载入示例数据": "Load sample data",
    "将加入 7 包演示豆（含冲煮与风味记录）。你自己的记录不受影响，之后关闭开关即可整批移除。":
        "Adds 7 sample bags with brews and tasting notes. Your own records are untouched; turn the switch off later to remove them all.",
    "删除示例数据？": "Remove sample data?",
    "删除示例数据": "Remove sample data",
    "将删除全部示例豆及其冲煮与风味记录。你自己的记录不受影响。":
        "Deletes every sample bag along with its brews and tasting notes. Your own records are untouched.",
    "示例数据已载入：7 包演示豆，覆盖养豆到喝完的完整生命周期。":
        "Sample data loaded: 7 bags covering the full lifecycle, from resting to finished.",
    "示例数据已移除，你的记录未受影响。":
        "Sample data removed. Your own records are untouched.",

    # MARK: 冲煮引导（饮品选择 → 配方 → 分步制作）
    "想做一杯什么": "What are you making?",
    "想喝什么": "What would you like?",
    "选一个开始": "pick one to start",
    "用哪包豆": "Which bag",
    "手冲咖啡": "Pour-over",
    "美式咖啡": "Americano",
    "拿铁": "Latte",
    "卡布奇诺": "Cappuccino",
    "冷萃咖啡": "Cold brew",
    "滤杯手冲，风味最清晰": "Pour-over clarity, brightest flavour",
    "浓缩咖啡液，奶咖的底": "The shot itself — milk drinks start here",
    "浓缩加热水，干净直接": "Espresso topped with hot water",
    "浓缩加牛奶，柔顺顺口": "Espresso and steamed milk, smooth",
    "奶泡更厚，咖啡感更强": "Thicker foam, more coffee forward",
    "冷水浸泡，圆润低酸": "Steeped cold — round and low-acid",
    "约 2 分钟": "about 2 min",
    "约 3 分钟": "about 3 min",
    "约 5 分钟": "about 5 min",
    "冷藏约 12 小时": "about 12 h chilled",
    "折纸": "Origami",
    "美式": "Americano",
    "做法": "Method",
    "咖啡粉": "Dose",
    "浓缩液": "Yield",
    "加水": "Added water",
    "牛奶": "Milk",
    "配方": "Recipe",
    "共 %@ 步 · %@": "%@ steps · %@",
    "咖啡粉 %@": "%@ of coffee",
    "浓缩液 %@": "%@ yield",
    "牛奶 %@": "%@ milk",
    "加水 %@": "%@ added water",
    "浓缩 %@": "%@ espresso",
    "默认建议": "Suggested default",
    "容易上手的参考起点，不是标准答案——按豆子和口味随意改。":
        "A friendly starting point, not a rule — adjust to your beans and taste.",
    "按这包豆子上次同款冲法预填": "Prefilled from this bag's last brew of the same kind",
    "恢复默认配方": "Reset to default recipe",
    "开始制作": "Start brewing",
    "跳过引导，直接记录": "Skip the guide, just log it",
    "先选一杯": "Pick a drink first",
    "先加一包豆，再开始做这一杯。": "Add a bag of beans before brewing this cup.",
    "退出": "Exit",
    "第 %@ 步，共 %@ 步": "Step %@ of %@",
    "制作完成": "Done brewing",
    "这一杯做完了": "This cup is ready",
    "去记录这杯的味道吧——参数已经按配方目标填好，改成本次的实际值就行。":
        "Now log how it tasted — the recipe targets are prefilled; set them to what you actually did.",
    "去记录这杯": "Log this cup",
    "上一步": "Back",
    "完成本步": "Done with step",
    "完成制作": "Finish brewing",
    "开始": "Start",
    "暂停": "Pause",
    "继续": "Resume",
    "重置": "Reset",
    "建议 %@": "target %@",
    "目标 %@": "Target %@",
    "约 %@": "~%@",
    "约 %@ 小时": "~%@ h",
    "%@ 小时": "%@ h",
    "全程用时 %@": "Total time %@",
    "到建议时长了，可以进入下一步。": "Target time reached — next step when you're ready.",
    "烧水备器": "Heat water, set up",
    "烧一壶水到 %@，备好滤杯、滤纸、电子秤和手冲壶。":
        "Heat water to %@. Set out the dripper, filter paper, scale and kettle.",
    "称取咖啡粉": "Weigh the coffee",
    "按配方称 %@ 咖啡粉，研磨度按你的器具调整。":
        "Weigh %@ of coffee. Grind to suit your gear.",
    "称 %@ 咖啡粉倒进粉碗。": "Weigh %@ of coffee into the basket.",
    "粗研磨，%@ 咖啡粉倒进容器。": "Coarse grind — %@ of coffee into the container.",
    "润湿滤纸，温杯": "Rinse the filter, warm the server",
    "滤纸放进滤杯，用热水冲湿，倒掉润洗水。":
        "Seat the paper in the dripper, rinse it with hot water, discard the rinse water.",
    "倒粉，轻晃铺平": "Add grounds, level the bed",
    "咖啡粉倒进滤杯，轻晃让粉面平整，放到秤上归零。":
        "Tip the grounds in, gently shake the bed flat, place it on the scale and tare.",
    "闷蒸": "Bloom",
    "从中心向外绕圈注水至 %@，等 %@ 让粉层排气。":
        "Pour in circles from the centre out to %@, then wait %@ for the bed to de-gas.",
    "第一段注水": "First pour",
    "缓慢绕圈注水至 %@，水流别冲到滤纸。":
        "Pour slowly in circles up to %@, keeping the stream off the paper.",
    "第二段注水": "Second pour",
    "继续注水至 %@，注完轻轻晃一下滤杯，让粉层落平。":
        "Pour on up to %@, then give the dripper a gentle swirl to settle the bed.",
    "等待滤干": "Let it draw down",
    "等液面降到粉层下方，全程大约 %@。":
        "Wait for the liquid to drop below the bed. The whole brew runs about %@.",
    "移开滤杯，摇匀分享壶": "Lift the dripper off, swirl the server",
    "布粉与压粉": "Distribute and tamp",
    "布粉器转两圈，压粉器水平压实，力道稳就够。":
        "Two turns of the distributor, then tamp level — steady beats heavy.",
    "上手柄，预热": "Lock in, preheat",
    "手柄扣上冲煮头，先放几秒水预热。":
        "Lock the portafilter into the group and run a few seconds of water to preheat.",
    "萃取浓缩": "Pull the shot",
    "接到电子秤上启动萃取，目标 %@ 浓缩液，用时约 25–35 秒。":
        "Start the shot on the scale — aim for %@ of espresso in about 25–35 s.",
    "到目标重量就停手，轻晃杯子让油脂均匀":
        "Stop at the target weight and give the cup a gentle swirl to even out the crema.",
    "量取水": "Measure the water",
    "量 %@ 热水倒进杯子；做冰美式就换冰水加冰块。":
        "Measure %@ of hot water into the cup — for iced, chilled water and ice instead.",
    "混合": "Combine",
    "把浓缩倒进水里，轻轻搅匀。": "Pour the espresso into the water and stir gently.",
    "尝一口，太浓就再补点水": "Taste it — a touch strong, add a little more water",
    "融合": "Blend",
    "撒点可可粉就是另一杯了——这杯先原味喝":
        "A dust of cocoa makes it a mocha — this one, drink it plain first",
    "称量牛奶": "Measure the milk",
    "冷藏牛奶 %@，倒进拉花缸。": "%@ of cold milk into the pitcher.",
    "牛奶 %@——比拿铁少，因为奶泡要占掉一层。":
        "%@ of milk — less than a latte, because the foam takes a layer of its own.",
    "打发牛奶": "Steam the milk",
    "蒸汽棒先补气再加热，打出细滑的奶泡，目标 %@。":
        "Aerate first, then heat — silky microfoam, target %@.",
    "浓缩倒进温好的杯子，牛奶从高处细流注入融合。":
        "Espresso into the warmed cup, then pour the milk from a height to blend.",
    "趁热喝，奶咖放久了奶泡会塌": "Drink it hot — milk foam waits for no one",
    "打发奶泡": "Build the foam",
    "多打进一些空气，做出更厚更结实的奶泡层，目标 %@。":
        "Work in extra air for a thicker, firmer foam layer, target %@.",
    "牛奶先倒进浓缩，最后用勺子把奶泡铺到表面。":
        "Milk into the espresso first, then spoon the foam over the top.",
    "融合与覆盖": "Blend and cap",
    "加入冷水": "Add cold water",
    "注水 %@，边倒边搅拌，让粉全部浸湿。":
        "Add %@ of water, stirring as you pour so every ground gets wet.",
    "盖好，放进冰箱": "Seal and refrigerate",
    "盖紧盖子冷藏，别放在门边——温度要稳。":
        "Lid on tight, into the fridge — away from the door, where the temperature holds.",
    "浸泡": "Steep",
    "冷藏浸泡 %@。这一步交给时间，不用计时器，到点再来。":
        "Steep %@ in the fridge. Time does the work — no stopwatch, come back when it's due.",
    "过滤装瓶": "Filter and bottle",
    "用滤纸或细筛滤掉残渣，装瓶冷藏，三天内喝完。":
        "Filter out the grounds, bottle and keep chilled — best within three days.",
    "浓缩液重量还没填": "Espresso yield not filled in",
    "浸泡时长还没填": "Steep duration not filled in",
    "实测时长 %@，参数按配方目标预填": "Measured %@; the rest is prefilled from the recipe targets",
    "参数按配方目标预填，请确认或改成实际值":
        "Prefilled with the recipe targets — confirm or set what you actually did",
    "和目标的差别": "Off target",
}
