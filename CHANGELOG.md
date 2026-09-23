# Changelog

## Unreleased

- ask_user_question 提问条目改为逐题成对呈现：`<ask-user-question index="…">` 条目 CDATA 内按问题 id 配对输出 q:（问题文本）与 a:（用户回答）行，未作答的题记为 a:(未回答)，未能配对到问题的回答单独成行，工具返回不是 answers JSON 时回退为逐行问题加单行返回原文；压缩提示词、块首格式说明注释与 README 同步更新
