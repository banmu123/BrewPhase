# Batch 1 — 来源与许可审查清单

> 生成日期：2026-10-14 ｜ 对应样本：`batch1_candidates.jsonl`（30 条）+ `data/corpus/examples_unreviewed.jsonl`（10 条，阶段一示例）
> 结论先行：**两批样本的全部回答均为独立撰写（`license_status: own-original`），未复制任何来源正文**；
> 来源仅作为事实出处登记。未引用任何 paywalled / pending-verification / Tier-4 社区来源。

## 1. 本批引用的全部来源（21 个，均已注册）

| sourceId | Tier | 注册状态 | 来源许可 | 本项目使用方式 | 合规判断 |
|---|---|---|---|---|---|
| `wcr-varieties-catalog` | 1 | active | **CC BY-NC-ND 4.0** | 仅提取事实点（两个种、产量占比、参照品种方法、授粉），全部独立改写；未复制目录表格、未改编数据 | ✅ 符合注册表纪律「品种知识只能独立改写」 |
| `wcr-varieties-catalog-fields` | 1 | active | see-source-terms | 同上，事实提取 + 独立改写 | ✅ |
| `nca-aboutcoffee` | 1 | active | see-source-terms | 「咖啡豆是种子」一处事实 | ✅ |
| `sca-coffee-standards` | 1 | active | see-source-terms | CVA 构成（SCA-102~105）、SCA-131 制定中 | ✅ 仅陈述标准存在与编号，未复制标准正文 |
| `sca-cva` | 1 | active | see-source-terms | CVA 取代 2004 协议、采纳情况 | ✅ |
| `ucdavis-coldbrew-2025` | 1 | active | see-source-terms | 冷萃研究结论（烘焙度>温度>时间、8h≈24h） | ✅ 研究结论转述并标注实验条件限制 |
| `ucdavis-research-index` | 1 | active | see-source-terms | 通用色曲线研究存在性 | ✅ |
| `fda-caffeine` | 1 | active | **public-domain** | 咖啡因 400mg 口径、个体差异 | ✅ 已署名来源 |
| `efsa-caffeine-opinion` | 1 | active | see-source-terms | EFSA 每日/单次口径 | ✅ 已注明为 2015 意见口径 |
| `cqi-php` / `cqi-home` / `cqi-q-grader-faq` | 1 | active | see-source-terms | 处理法教育框架、课程覆盖范围 | ✅ |
| `hario-v60-expert-guide` | 2 | active | proprietary-free | V60 官方配方数值、调参方向、洗滤纸 | ✅ 厂商来源允许「事实提取+独立改写+标注」，已标注 |
| `hario-v60-hoffmann` | 3 | active | proprietary-free | Hoffmann 配方数值 | ✅ 已署名 |
| `hario-recipe-cards` | 2 | **partial**（第三方托管官方配方卡） | proprietary-free | Mizudashi 官方配方 | ✅ 引用官方配方数值；托管方式已在注册表注明 |
| `aeropress-how-to-use` / `aeropress-manual-inverted` | 2 | active | proprietary-free | 官方水温/流程/倒置法立场 | ✅ |
| `fellow-brew-talks` / `fellow-espresso-basics` | 2 | active | proprietary-free | 深烘/浅烘养豆案例、意式故障树、配方温度 | ✅ |
| `baratza-documents` | 2 | active | proprietary-free | 刻度不可跨机换算口径 | ✅ |
| `sage-bes875-ug-i23` | 2 | active | proprietary-free | 除垢周期、结垢机理 | ✅ |
| `gaggia-classic-manual` | 2 | active | proprietary-free | 禁醋、除垢周期（2019 版） | ✅ |
| `stumptown-kalita-guide` | 3 | active | see-source-terms | 洗滤纸跨来源共识 | ✅ |

## 2. 刻意未引用的来源（合规红线）

| 来源 | 原因 |
|---|---|
| `sca-digital-store`（SCA Handbooks，付费墙） | 付费数字产品，正文不可复制；只允许记录书目。本批样本未使用其任何内容 |
| `barista-hustle`（订阅制） | 同上，仅可取课程主题骨架，本批未使用 |
| `sca-flavor-wheel-2016`（CC BY-NC-ND，restricted） | 禁止改编；样本仅在既有示例 ex-006 中提及名称（未复制内容） |
| `wcr-sensory-lexicon` / `kalita-official` / `nespresso-manuals-index` | pending-verification，禁止作为事实来源 |
| `home-barista-forum` / `reddit-r-coffee`（Tier 4，pending） | 仅可作轶事证据；b1-027（倒置法）在回答中说明「社区来源为轶事级且待核验」，但**未将其登记为事实来源** |

## 3. 许可模型说明

每条样本的 `license_status` 均为 `own-original`：指**样本回答文本**为本项目独立撰写。
`source_ids` 登记的是回答中事实点的出处，不意味着来源允许整段复制。
这与 `SOURCE_REGISTRY.md` §0 的纪律一致：对 `see-source-terms` 与厂商手册，
只做「事实提取 + 独立改写 + 标注来源」。若人工审核发现任何一条的表述与来源原文
过近，请在审核清单中选「修改」。
