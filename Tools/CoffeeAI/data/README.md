# data/ — 训练数据目录

| 路径 | 内容 | 状态 |
|---|---|---|
| `corpus/examples_unreviewed.jsonl` | 10 条示例样本（训练内容，chat 格式） | **unreviewed，禁止训练** |
| `meta/examples_unreviewed.meta.jsonl` | 示例样本的来源/许可/审核状态/去重指纹 | 同上 |
| `splits/` | `train/valid/test.jsonl`（+ `.meta.jsonl` 审计文件 + `split_report.json`） | 划分产物，不入 Git |

格式与审核流程见上级 `../README.md` §2。要点：

- 训练内容与元数据**分文件**存放，`sample_id` 关联；模型只看 `messages`。
- **真实训练数据尚未准备好**。放正式语料时：新建 `corpus/coffee_v1.jsonl` +
  `meta/coffee_v1.meta.jsonl`，人工审核后置 `review_status: approved`。
- `splits/` 由 `python3 Tools/CoffeeAI/scripts/split_dataset.py` 生成，可随时删除重建
  （同 seed 结果逐字节一致）。
