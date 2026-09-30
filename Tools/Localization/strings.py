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
    "太新": "Too fresh",
    "养豆": "Resting",
    "开始进入窗口": "Opening",
    "进入窗口": "Opening",
    "黄金风味窗口": "Peak window",
    "黄金窗口": "Peak",
    "风味衰退": "Declining",
    "衰退": "Declining",
    "开始衰退": "Declining",
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
    "现在正处于风味窗口": "This one is in its window now",
    "风味正在打开": "The flavour is opening up",
    "风味已经开始衰退": "The flavour has started to decline",
    "还在养豆，风味还没打开": "Still resting — the flavour is not open yet",
    "已经喝完了": "This bag is finished",
    "还没有烘焙日期": "No roast date yet",
    "烘焙日期在未来": "The roast date is in the future",
    "窗口这两天就结束了": "The window closes in the next couple of days",
    "已过窗口但还剩不少": "Past its window with plenty left",
    "窗口比你的消耗速度更短": "The window is shorter than your pace",
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
    "进入风味窗口": "Entered its window",
    "窗口过半": "Window halfway",
    "窗口即将结束": "Window closing",
    "排气期结束，风味开始打开时提醒": "When degassing ends and the flavour starts to open",
    "进入最佳风味窗口时提醒": "When it enters its peak window",
    "窗口走过一半时提醒": "When the window is half gone",
    "窗口结束前两天提醒": "Two days before the window closes",
    "这包可能喝不完它的窗口时提醒": "When a bag may not be finished inside its window",
    "%@ 养豆结束": "%@ has finished resting",
    "%@ 进入风味窗口": "%@ has entered its window",
    "%@ 的窗口过半了": "%@ is halfway through its window",
    "%@ 的窗口快结束了": "%@'s window is nearly over",
    "%@ 建议优先喝": "%@ — drink this one first",
    "%@ 的排气期基本结束，风味开始打开了。": "%@ has mostly finished degassing, and the flavour is starting to open up.",
    "%@ 现在进入最佳风味窗口，可以开始喝了。": "%@ is in its peak window now — a good time to start drinking it.",
    "%@ 的窗口已经过半，接下来的风味会慢慢变平。": "%@ is past the middle of its window; from here the flavour will slowly flatten.",
    "%@ 的窗口还剩两天，想喝到最好的状态就趁现在。": "%@ has two days left — now is the time if you want it at its best.",
    "%@ 的窗口比你的消耗速度更短，建议优先喝完。": "%@'s window is shorter than your pace, so it is worth finishing first.",
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
    "添加第一包豆子，开始记录它从养豆到衰退的整个过程。": "Add your first bean and start tracking it from resting all the way to decline.",
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
    "补充产区、处理法、价格": "Add origin, process and price",
    "烘焙与重量": "Roast and weight",
    "更多信息": "More details",
    "在喝": "Open",
    "已喝完": "Finished",
    "标记为已喝完": "Mark as finished",
    "库存": "Stock",
    "调整": "Adjust",
    "调整剩余量": "Adjust stock",
    "剩余量按总克数算": "Remaining is counted against the bag's total",
    "剩余量比总克数还多，保存时会按 %@ 调整总克数。": "There is more left than the bag holds; the total will be adjusted to %@ when you save.",
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
    "删除这包豆子？": "Delete this bean?",
    "删除这包豆子后，它关联的 %@ 条冲煮记录和 %@ 条风味记录也会一起被删除，无法恢复。": "Deleting this bean also deletes its %@ brews and %@ tasting notes. This cannot be undone.",
    "删除": "Delete",
    "取消": "Cancel",
    "保存": "Save",
    "没能保存下来，请再试一次": "Could not save. Please try again",
    "这张图片没能保存下来，可以换一张试试": "That image could not be saved. Try another one",
    "比如 Ethiopia Guji": "e.g. Ethiopia Guji",
    "比如 埃塞俄比亚 · Guji": "e.g. Ethiopia · Guji",
    "水洗": "Washed",
    "日晒": "Natural",
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
    "来自冲煮记录": "from a brew",
    "风味记录": "Tasting note",
    "记一笔风味": "Add a tasting note",
    "还没有风味记录\\n冲一次，然后记下今天这杯怎么样。": "No tasting notes yet.\\nBrew this bean and note how today's cup tasted.",
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
    "复制参数再来一次": "Brew again with the same recipe",
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
    "还没有冲煮记录\\n冲一次，然后记下今天这杯怎么样。": "No brews yet.\\nBrew this bean and note how today's cup tasted.",
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
    "风味窗口": "Flavour windows",
    "风味窗口规则": "Window rules",
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
    "排气 %@–%@ 天 · 窗口第 %@–%@ 天 · 第 %@ 天开始衰退": "Rest %@–%@ days · Window days %@–%@ · Declining from day %@",
    "关于": "About",
    "没有账号，没有登录，没有服务器。": "No account, no sign-in, no server.",
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
    "手冲首选，V60 闷蒸 30 秒。": "First choice for pour-over; 30-second bloom on the V60.",
    "闻起来发酵感很足。": "Smells heavily fermented.",
    "先放着养一养。": "Leaving it to rest for now.",
    "深一点，做奶咖不错。": "A bit darker; good with milk.",
    "每天一杯奶咖的主力。": "The daily milk-drink workhorse.",
    "袋子上的烘焙日期磨掉了，等确认一下。": "The roast date on the bag has rubbed off — waiting to confirm it.",
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
    "实验": "Experimental",
    "预计最佳": "estimated best",
    "预计最佳窗口 %@ – %@": "Estimated best window %@ – %@",
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
    "预计风味窗口是实验功能，和上面这套窗口规则是两回事：一个是模型估计，一个是你自己定的规则。": "The estimated flavour window is experimental and separate from the rules above: one is the model's guess, the other is what you set yourself.",
    "预计风味窗口已经关掉，详情页不会显示它。": "The estimated flavour window is switched off, so it will not appear on the bean page.",

    # The separator the missing-field list is joined with. A key of its own so
    # the English list reads "Variety, Altitude", not "Variety、Altitude".
    "、": ", ",

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
    "用你自己的记录回答问题": "Answers drawn from your own records",
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
    "本次回答引擎：%@": "Answer engine: %@",
    "%@ 生成": "Generated by %@",
    "已降级": "Fallback",
    "耗 %@ 秒": "%@ s",
    "来自你的记录": "From your records",
    "来自 BrewPhase 知识库": "From the BrewPhase knowledge base",

    # Example questions
    "我最近三次怎么冲的？": "How did I brew the last three times?",
    "我今天还有哪些豆子？": "Which bags do I have today?",
    "V60 一般用多少水温？": "What water temperature should a V60 use?",
    "我有没有遇到过类似的干涩？": "Have I run into that drying astringency before?",
    "「%@」现在适合喝吗？": "Is %@ ready to drink now?",
    "「%@」我最近三次怎么冲的？": "How did I brew %@ the last three times?",
    "「%@」我打过分吗？": "Did I ever score %@?",

    # MARK: Local RAG — settings
    "开启本地智能": "Turn on local intelligence",
    "关掉之后不再维护向量索引，也不会算任何向量":
        "When off, the vector index is no longer maintained and nothing is embedded",
    "向量模型": "Embedding model",
    "每次取多少条资料": "Passages per question",
    "取太多会让相似记录挤在一起，太少又可能漏掉你真正想问的那条记录。":
        "Too many and the similar records crowd together; too few and the one you meant may never show up.",
    "重建索引": "Rebuild index",
    "换了向量模型或界面语言之后需要重建":
        "Needed after changing the embedding model or the interface language",
    "正在重建…": "Rebuilding…",
    "开始重建": "Start rebuild",
    "完成了：索引里现在有 %@ 条，这次重算了 %@ 条。":
        "Done: the index now holds %@ entries, and %@ were recomputed.",
    "建议与分析只依据这台设备上的记录和 App 自带的知识条目。检索在本机完成，没有账号，也没有服务器。":
        "Suggestions and analysis draw only on the records on this device and the notes that ship with the app. Retrieval happens locally; no account, no server.",

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
    "根据你的记录：": "From your records:",
    "你的记录里有这些：": "Your records contain:",
    "另外，相关的记录：": "Also relevant:",
    "BrewPhase 知识库里相关的说法：": "The BrewPhase knowledge base says:",
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
    "按现有的窗口规则，今天最该喝的是「%@」。":
        "By the current window rules, the one to drink today is %@.",
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
    "本地智能，不联网": "Local intelligence, no network",
    "今日建议 · 我的最佳参数 · 相似冲煮": "Today · Best parameters · Similar brews",
    "今日建议": "Today",
    "相似冲煮": "Similar brews",
    "我的最佳参数": "My best parameters",
    "历史分析": "History check",
    "证据不足，先不给结论": "Not enough evidence yet — no conclusion for now",
    "豆仓里还没有豆子。先加一包，喝过几次之后这里就会有话说了。":
        "No bags in the cellar yet. Add one and brew it a few times, and this page will have something to say.",
    "写下这次遇到的情况，我在你自己的记录里找相似的先例。":
        "Describe what you ran into; I will look for similar moments in your own records.",
    "比如「干涩」「发苦」「香气闷」": "e.g. drying, bitter, muted aroma",
    "这台设备上没有可用的语义模型，相似冲煮已退到词法匹配：只认字面相近的说法。":
        "No semantic model is available on this device, so similar brews fell back to lexical matching: only literal wording counts.",
    "相似冲煮使用端侧语义模型，离线可用。":
        "Similar brews use the on-device semantic model; works offline.",
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
    "晴热": "Hot",
    "温和": "Mild",
    "转凉": "Cooling down",
    "冷": "Cold",
    "下雨": "Rainy",
    "未设置": "Not set",
    "今天的天气": "Today's weather",
    "推荐会参考，但只做微调": "Suggestions take it into account, with a light touch",
    "自动获取": "Auto",
    "自动…": "Auto…",
    "自动 · %@": "Auto · %@",
    "自动 · %@ %@": "Auto · %@ %@",
    "正在取位置和天气…": "Fetching your location and the weather…",
    "拿不到位置（未授权或暂时失败），先用手动选择的场景。":
        "Could not get your location (not authorised, or it failed). Using the scene you picked instead.",
    "天气服务暂时不可用（需要在开发者后台为这个 App 开通 WeatherKit）。先用手动场景。":
        "The weather service is unavailable (WeatherKit has to be enabled for this App ID in the developer portal). Using the manual scene instead.",
    "手冲还是意式": "Filter or espresso",
    "今天适合%@：%@": "Today suits %@: %@",
    "今天%@，通常更想喝%@。": "With %@ weather today, %@ is what usually hits the spot.",
    "你用%@平均打了 %@ 分（%@ 次）。": "Your %@ averages %@ over %@ brews.",
    "%@：平均 %@ 分（%@ 次）": "%@: %@ on average over %@ brews",
    "现在 %@°C": "It is %@°C right now",
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
    "天气也是原因之一：今天%@，几包同阶段的豆子里，这包更对路。":
        "Weather played a part too: with %@ weather, this bag fits the day better than its peers.",
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
}
