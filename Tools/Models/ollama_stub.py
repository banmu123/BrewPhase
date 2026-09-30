#!/usr/bin/env python3
"""一个只够用来自测的 Ollama 协议桩。

存在的理由：这台机器上没有装 Ollama，而「换一个 LLM provider 之后整条链路还通不通」
是本次对接里唯一没法靠单元测试回答的问题——它要的是真的发一次 HTTP、真的收一段
回答回来。这个脚本用 Python 标准库起了三个 Ollama 的端点，回答是固定文本，所以
截图里的那句话一定来自这里，而不是来自模型。

    python3 Tools/Models/ollama_stub.py [port]

然后在模拟器上：

    Tools/run.sh --demo --screen ask --ask "这包豆什么时候开封的？" \
      --pref brewphase.rag.answerEngine=ollama \
      --pref brewphase.rag.ollama.baseURL=http://127.0.0.1:11500 \
      --pref brewphase.rag.ollama.chatModel=stub-model

回答里会带上它实际收到的证据条数，所以一眼能看出检索有没有真的送出东西。
"""

from __future__ import annotations

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

VECTOR_DIMENSION = 384
MODEL_NAME = "stub-model"


class Handler(BaseHTTPRequestHandler):

    def _send(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's naming
        if self.path.startswith("/api/tags"):
            self._send({"models": [{"name": MODEL_NAME}]})
        else:
            self._send({"error": "not found"}, status=404)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            request = json.loads(raw)
        except json.JSONDecodeError:
            self._send({"error": "bad json"}, status=400)
            return

        if self.path.startswith("/api/embeddings"):
            self._send({"embedding": self._vector(request.get("prompt", ""))})
        elif self.path.startswith("/api/embed"):
            prompts = request.get("input") or []
            self._send({"embeddings": [self._vector(p) for p in prompts]})
        elif self.path.startswith("/api/chat"):
            self._send(self._chat(request))
        else:
            self._send({"error": "not found"}, status=404)

    @staticmethod
    def _vector(text: str) -> list[float]:
        """确定性的假向量。

        不追求语义质量——它只需要让索引建得起来、检索排得出顺序。用字符的码位
        散列到固定的维度上，和 App 里的词法 provider 是同一个思路。
        """
        vector = [0.0] * VECTOR_DIMENSION
        for index, character in enumerate(text):
            bucket = (ord(character) * 31 + index) % VECTOR_DIMENSION
            vector[bucket] += 1.0
        return vector

    @staticmethod
    def _chat(request: dict) -> dict:
        messages = request.get("messages") or []
        user = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
        system = next((m.get("content", "") for m in messages if m.get("role") == "system"), "")

        citations = sorted(set(re.findall(r"\[(\d+)\]", user)), key=int)
        scope = next((line for line in user.split("\n") if line.startswith("问题：")), "问题：")
        user_records = user.count("\n[") if "【用户自己的记录】" in user else 0

        # 回答的形状照着提示词的要求来：带引用、区分来源、不编数字。
        lines = [
            "（这段回答来自 Ollama 协议桩，不是模型生成的。）",
            f"桩收到了 {len(citations)} 条证据，编号 {', '.join(citations) if citations else '无'}。",
            f"它读到的{scope}",
        ]
        if citations:
            lines.append(f"按你的提示词，这相当于在引用源里找到了 {len(citations)} 条可用的记录 [1]。")
        else:
            lines.append("证据里没有任何编号，按规则它应该回答找不到。")
        lines.append(f"系统提示词长度 {len(system)} 字符，说明纪律说明确实送到了。")
        return {"model": request.get("model", MODEL_NAME),
                "message": {"role": "assistant", "content": "\n".join(lines)},
                "done": True}

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        sys.stderr.write("stub: %s\n" % (format % args))


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 11500
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"ollama stub listening on http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
