# 测试用自签名证书

`self-signed-127.0.0.1.{pem,key.pem}` 是**仅供测试**的自签名证书：

- CN / SAN：`IP:127.0.0.1`、`DNS:localhost`，有效期 10 年。
- 用途：`tests/net/proxy-fetch.test.ts` 里的本地 HTTPS 代理。客户端把它当作
  信任锚（`{ ca: TEST_CERT }`）时握手成功，不传时必须被证书校验拒绝——这两
  种结果正是 R1-1 要钉住的判据。
- 私钥是公开的测试材料，**不得**用于任何真实环境；生产代码没有任何关闭证书
  校验的开关，也不读这个目录。

重新生成：

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout self-signed-127.0.0.1.key.pem \
  -out self-signed-127.0.0.1.pem \
  -days 3650 -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"
```
