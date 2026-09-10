# Changelog

## Unreleased

- 压缩视图与 `<history>` 块中的 ask_user_question 提问条目改为结构化形态 `<askuserquestion index="…">`，内含 `<questions>`（提问内容）与 `<answers>`（用户回答）两段 CDATA 子元素；压缩保护与 skill 加载条目一致，首次覆盖时要求模型再次确认相关性，压缩提示词同步更新
- `<history>` 块首格式说明注释改为动态生成：`<user_message>`、`<sys>`、`<skill_content>`、`<askuserquestion>` 的条目说明仅在块内存在对应条目时包含，通用说明保持不变
