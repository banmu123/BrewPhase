# 44 Coffee + Health — 咖啡与健康（高敏感域）

> status: filled ｜ authorityTier: 1 ｜ lastVerified: 2026-09-30 ｜ topic: health

## Summary

高敏感领域。**规则（规格 §44 / §74）：只保存官方风险信息、研究结论、适用人群、限制与来源。不做诊断、不给治疗建议、不替用户判断疾病。**

所有结论**优先使用 FDA、EFSA、政府卫生机构、医学期刊/系统综述**。

## Facts — 咖啡因

| claim id | 事实 | sourceId | 适用人群 |
|---|---|---|---|
| claim.health.fda-400 | FDA 引用的口径：对**多数成人**，每天 **400 mg**（约 2–3 杯 12 fl oz 咖啡）一般不与负面影响相关；但个体敏感性与代谢速度差异很大。 | `fda-caffeine` | 健康成人 |
| claim.health.fda-variance | FDA 明确「too much」因人而异——取决于**体重、用药、疾病与个体敏感性**。 | `fda-caffeine` | 全体 |
| claim.health.fda-toxic | FDA 估计**快速摄入约 1200 mg** 咖啡因（约 12 杯）或 0.15 汤匙纯咖啡因，可致**癫痫发作等毒性作用**。 | `fda-caffeine` | 全体 |
| claim.health.fda-decaf | 脱因咖啡**仍含咖啡因**：典型为每 8 fl oz 约 **2–15 mg**。 | `fda-caffeine` | 全体 |
| claim.health.fda-natural-same | FDA 明确：天然存在于咖啡/茶中的咖啡因与添加咖啡因，在体内处理方式与安全性上**没有差别**。 | `fda-caffeine` | 全体 |
| claim.health.fda-withdrawal | 减量宜**逐步**；咖啡因戒断不被视为危险，但可能不适（头痛、焦虑、紧张）。 | `fda-caffeine` | 全体 |
| claim.health.fda-children | 医学专家（含 AAP）建议**儿童与青少年避免能量饮料**；儿童青少年摄入过多咖啡因可致心率增快、心悸、血压升高、焦虑，并影响睡眠、消化与水分。 | `fda-caffeine` | 儿童/青少年 |
| claim.health.fda-pregnancy-refer | FDA：若怀孕/备孕/哺乳，建议**咨询医疗人员**是否需要限制。 | `fda-caffeine` | 孕期/哺乳 |
| claim.health.efsa-single-200 | EFSA（2015）：**单次 ≤200 mg**（约 3 mg/kg bw）不引起一般健康成人安全担忧。 | `efsa-caffeine-opinion` | 健康成人 |
| claim.health.efsa-daily-400 | EFSA：**每日 ≤400 mg**（约 5.7 mg/kg bw/天）不引起非孕健康成人安全担忧。 | `efsa-caffeine-opinion` | 非孕成人 |
| claim.health.efsa-pregnancy-200 | EFSA：孕/哺乳期妇女每日 ≤200 mg 不引起对胎儿/母乳婴儿的安全担忧。 | `efsa-caffeine-opinion` | 孕期/哺乳 |
| claim.health.efsa-children-3mg | EFSA：儿童青少年的**习惯性**摄入可按 **3 mg/kg bw/天**；该水平亦可用于急性的单次剂量推导。 | `efsa-caffeine-opinion` | 儿童/青少年 |
| claim.health.efsa-sleep-100 | EFSA：**单次 100 mg**（约 1.4 mg/kg bw）**可能影响部分成人的睡眠时长与模式**，尤其在临睡前进食时。 | `efsa-caffeine-opinion` | 成人 |
| claim.health.efsa-exercise | EFSA：单次 ≤200 mg 在**运动前 2 小时内**摄入，在正常环境条件下不引起安全担忧。 | `efsa-caffeine-opinion` | 成人 |
| claim.health.efsa-alcohol | EFSA：酒精（至 0.65 g/kg bw，约 BAC 0.08%）不影响 ≤200 mg 单次咖啡因的安全性；且该剂量下咖啡因**不太可能掩盖**酒精中毒的主观知觉。 | `efsa-caffeine-opinion` | 成人 |
| claim.health.efsa-refs | EFSA 主题页给出参考含量：espresso(60ml)≈80mg、滤泡咖啡(200ml)≈90mg、红茶(220ml)≈50mg、可乐(355ml)≈40mg、能量饮料(250ml)≈80mg、黑巧克力(50g)≈25mg、牛奶巧克力(50g)≈10mg。 | `efsa-caffeine-topic` | 全体 |

## 明确不做的事

| 禁止 | 说明 |
|---|---|
| 诊断 | 不得依据症状替用户判断疾病 |
| 治疗建议 | 不得建议用咖啡/戒咖啡来治疗任何疾病 |
| 替代医疗人员 | 凡涉孕、哺乳、儿童、用药、疾病，一律指向**咨询医疗人员** |
| 从博客取健康结论 | 只用 FDA / EFSA / 政府卫生机构 / 系统综述 |

## Practical Guidance

- 面向用户的输出结构应为：**官方数值 + 适用人群 + 限制 + 来源 + 「请咨询医疗人员」**。
- 可做「含量换算」帮助理解（如一杯 espresso ≈ 80 mg → 400 mg 大致对应多少杯），但必须标注为**近似**，并用 EFSA/FDA 数字。

## Exceptions / Limitations

- 「咖啡与心血管疾病/胃食管反流/睡眠」等具体疾病的**关联结论**：本轮核验的 FDA/EFSA 来源未提供这些方向的结论性表述，故**不写入**。NCA 的 Research Library 有对同行评审研究的汇总（`nca-aboutcoffee`），可作为下一步补证入口。
- 「药物相互作用」未核验。

## Applicability

`generic`

## Evidence Type

`standard`（Tier 1，FDA）+ `research`（Tier 1，EFSA）

## Source

`fda-caffeine`、`efsa-caffeine-opinion`、`efsa-caffeine-topic`

## License

FDA 为**公有领域**；EFSA 为 `see-source-terms`（需署名）。独立改写，未复制正文。

## Last Verified

2026-09-30
