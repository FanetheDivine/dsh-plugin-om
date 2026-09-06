# Changelog

## Unreleased

### Changed

- 成本计算器参数改为「step平均输出」（每 step 模型输出的 thinking、text、tool-args，默认 780 tokens）与「step平均输入」（每 step 输入给模型的 text、用户或系统消息、tool-result，默认 660 tokens），取实测平均值，成本表上方描述同步说明该实测口径
