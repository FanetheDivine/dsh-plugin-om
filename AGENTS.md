阅读[README.md](./README.md)以了解此项目

# 开发约定

- 文件变更后调用 `pnpm format && pnpm lint` 进行格式化和语法检查
- **任何commit**都必须为[CHANGELOG.md](./CHANGELOG.md)增加新条目
- 任何**代码变更**都必须同步`tests/`的测试用例
- 任何影响用户可见行为的变化必须同步更新 [README.md](./README.md)

## TODO

- 在消息记录/轨迹中添加工具调用简报结果（不限于 run_code）
- 记录fork会话的token