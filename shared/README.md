# 协议同步约定

`docs/PROTOCOL.md` 是唯一权威协议文档。代码中有三处实现必须与之保持一致：

1. `server/src/shared/protocol.ts` — 服务端常量、帧头解析、错误码表
2. `android-host/app/src/main/java/com/pcxx/remote/host/protocol/Protocol.kt` — 受控端
3. `android-controller/app/src/main/java/com/pcxx/remote/controller/protocol/Protocol.kt` — 控制端

修改消息类型、帧类型或帧头结构时，必须同时更新以上三处并递增 `PROTOCOL_VERSION`，
否则服务端会以 `close 4000` 拒绝不兼容的客户端。

`web-console/src/api/client.ts` 只包含 REST 响应类型，不涉及二进制帧；新增 REST 字段时需同步其接口定义。
