# Model Download Report（阶段七-D1，2026-10-14）

| 项 | 值 |
|---|---|
| model_id | `mlx-community/Qwen2.5-3B-Instruct-4bit`（11 files） |
| download_time | 2026-10-14 约 3 分钟（经 hf-mirror.com 镜像；直连 hf.co 被 406 "Unknown Client" 网络层拒绝） |
| local_cache_location | `~/.cache/huggingface/hub/models--mlx-community--Qwen2.5-3B-Instruct-4bit` |
| model_size | 约 2 GB（4bit 量化；磁盘 155Gi → 153Gi） |
| sha256 | HF Hub 未直接提供单文件 sha256（metadata 未含；safetensors 完整性由 hub 下载校验保证） |
| disk_before | 155 Gi 可用 |
| disk_after | 153 Gi 可用 |
| **model_downloaded** | **yes** |
| **training_started** | **no** |

## 下载过程备注（网络兼容性，供后续复现）

1. 直连 `huggingface.co`：HTTP 406 "Unknown Client"（网络层拦截）；
2. `HF_ENDPOINT=https://hf-mirror.com` 镜像 + hf-xet 1.7.0：Xet CAS 协议绕过镜像直连
   `cas-server.xethub.hf.co` → 401；
3. **最终方案**：卸载 hf-xet（强制经典 HTTP 下载路径）+ `HF_ENDPOINT=https://hf-mirror.com`
   → 下载成功，generate 冒烟通过（hello / 8 tokens / 45.87 tok/s / Peak memory 1.839 GB）。

## 复现要点

```bash
export HF_ENDPOINT=https://hf-mirror.com
pip uninstall hf-xet -y   # 若安装了 hf-xet 必须卸载，否则镜像下载会走 Xet 直连失败
mlx_lm.generate --model mlx-community/Qwen2.5-3B-Instruct-4bit --prompt "hello" --max-tokens 8
```
