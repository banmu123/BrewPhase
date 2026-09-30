# 38 Cupping — 杯测

> status: filled ｜ authorityTier: 1 ｜ lastVerified: 2026-09-30 ｜ topic: cupping

## Summary

杯测（cupping）是标准化评价咖啡的协议。**当前存在两套并行的官方体系**——这是本领域最重要的事实：

- **SCA CVA**：2024-11 起成为 SCA 官方杯测标准，取代 2004 Cupping Protocol。
- **CQI 2004 form**：CQI 明确表示继续在 Quality Evaluation 项目中使用 2004 form。

知识库若写「杯测标准是什么」，答案是 **「取决于用哪一套」**，而不是「就是那一套」。

## Facts

| claim id | 事实 | sourceId |
|---|---|---|
| claim.cupping.sca-cva-elements | SCA CVA 的构成：SCA-102（样品制备与品尝机制）、SCA-103（描述性）、SCA-104（情感性/偏好）、SCA-105（外在信息）；另有 SCA-710 Coffee Evaluator 专业能力认证标准。 | `sca-coffee-standards` |
| claim.cupping.sca-replaces-2004 | CVA 的三部分取代了 2004 Cupping Protocol and Form。 | `sca-cva` |
| claim.cupping.cqi-keeps-2004 | CQI：「我们将继续在 Quality Evaluation 项目（含 Q Grader 课程）中使用 2004 cupping form」，且无近期改动计划。 | `cqi-q-grader-faq` |
| claim.cupping.q-modules | Q 课程含 **9 个模块、20 场考试**，涵盖：杯测协议、嗅觉与味觉、绿咖啡缺陷识别、烘豆样品程度识别、有机酸识别、三角测试、处理法评估、价值链通识。 | `cqi-q-grader-faq` |
| claim.cupping.q-validity | 通过全部考试者获 Q Arabica / Q Robusta Grader 证书，有效期 **36 个月**；需每 3 年参加一次线下校准课。 | `cqi-q-grader-faq` |
| claim.cupping.q-calibration | 校准须通过**三个 flight 中的至少两个**；失败者可在 6 个月内再次参加校准课。 | `cqi-q-grader-faq` |
| claim.cupping.q-license-migration | **2025-10-01 起** Q Grader 课程作为更新后项目的一部分**由 SCA 承接**（CQI 于 2025-09-30 停止自营）。 | `cqi-home` |
| claim.cupping.cqi-programs | CQI 两大教育项目：**Quality Evaluation** 与 **Post-Harvest Processing**。 | `cqi-home` |
| claim.cupping.sca-cva-course | SCA 提供 **CVA for Cuppers** 两日沉浸式专业课程。 | `sca-cva` |
| claim.cupping.descriptive-panel-method | 标准杯测使用**校准过的描述性分析小组**；SCA 提供 Cupping Attributes 教学图。 | `ucdavis-coldbrew-2025`、`sca-flavor-wheel-2016` |

## 议程维度（规格 §38 清单 → 与 CVA 的映射）

`crust / break / aroma / flavor / aftertaste / acidity / body / uniformity / clean cup / defects / scoring`

| CVA 分类 | 覆盖的维度 |
|---|---|
| Physical | 客观物理属性（如粒径、水分等） |
| Descriptive | 香气、风味、余韵、酸质、口感（body/质地）等**描述性维度** |
| Affective | 整体偏好/喜好 |
| Extrinsic | 产地、认证、处理法等**外在信息** |

> 「uniformity / clean cup / scoring」属**传统 2004 form 术语**，在 CVA 体系中由 Descriptive + Affective 的重构承接。本知识库保留两侧术语，并标注归属。

## Practical Guidance

- 面向用户解释杯测时，**先说清是 SCA CVA 还是 CQI 2004**，避免术语混用。
- 术语映射表见 `terminology/terminology.json`。

## Exceptions / Limitations

- CVA 表格的**具体评分字段与分值**本轮未取得（标准正文/工具付费或需登录）→ REVIEW_QUEUE。
- 杯测的样品制备参数（粉水比、研磨、水温）**未核验**。

## Applicability

`generic`

## Evidence Type

`standard`（Tier 1）

## Source

`sca-coffee-standards`、`sca-cva`、`cqi-q-grader-faq`、`cqi-home`、`ucdavis-coldbrew-2025`

## License

`see-source-terms`。独立改写。

## Last Verified

2026-09-30
