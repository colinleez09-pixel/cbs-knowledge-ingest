# 回归测试场景 (v2.0)

## 目录

- [概览](#概览)
- [样例验证点](#样例验证点)
- [通用测试场景](#通用测试场景)

## 概览

本文档列出 v2.0 的回归测试场景。AI 在执行完分析后应对照检查。

## 样例验证点

### 1. 字段树完整性
- **输入**：历史用例包含 SoapClient 的 rReq（嵌套 dict）
- **预期**：case-data.json 中 field_trees 包含完整递归路径（如 `AdjustmentRequestMsg.AdjustmentRequest.OpType`）
- **验证**：field_trees.SoapClient[].path 不含空字符串，深层字段路径完整

### 2. rReq 补丁生成
- **输入**：用例 rReq 与资产 rReq 有字段差异
- **预期**：script_patches 包含 rReq 字段的 add-field/replace-field/remove-field
- **验证**：script_patches 中 component=SoapClient 且 field_path 以 rReq 相关路径开头

### 3. rRsp 补丁生成
- **输入**：用例 rRsp 与资产 rRsp 有值差异
- **预期**：script_patches 包含 rRsp 的 replace-field
- **验证**：rRsp 补丁的 case_value 完整（不截断）

### 4. rVars 补丁生成
- **输入**：用例 rVars 与资产 vars 有差异
- **预期**：script_patches 包含 set-variable/remove-variable
- **验证**：TableSetVar 组件的 vars 补丁正确

### 5. nosend/nocare/norecv 识别
- **输入**：用例字段值包含 "nosend"/"nocare"/"norecv"
- **预期**：script_patches 中 operation 为 set-nosend/set-nocare/set-norecv
- **验证**：特殊值不被误判为 replace-field

### 6. 变量引用识别
- **输入**：用例字段值包含 `${My_AcctKey}`
- **预期**：operation 为 runtime-bind
- **验证**：variable_name 正确提取

### 7. 表达式识别
- **输入**：用例字段值包含 `${G.modHour(G.now(),-8)}`
- **预期**：operation 为 expression-bind
- **验证**：不误判为 runtime-bind

### 8. 变量生产者检测
- **输入**：Step[0] 的 SoapClient rVars 定义了 My_AcctKey
- **预期**：variable_graph 中 My_AcctKey 的 producer 为 step 0, type=soap-rvars
- **验证**：producer_type 正确

### 9. 变量消费者检测
- **输入**：Step[3] 的 rReq 引用了 ${My_AcctKey}
- **预期**：variable_graph 中 My_AcctKey 的 consumer 为 step 3
- **验证**：consumer_location 为完整字段路径

### 10. 变量依赖链
- **输入**：Step[0] 生产 My_AcctKey, Step[3] 消费 My_AcctKey
- **预期**：variable_dependencies 包含 {from_step: 0, to_step: 3, variable: "My_AcctKey"}
- **验证**：confidence 为 confirmed

### 11. 未匹配步骤 inline-recipe
- **输入**：步骤无匹配资产（如 DataBaseQuery）
- **预期**：construction_mode 为 inline-recipe, inline_recipe 包含完整组件配置
- **验证**：inline_recipe.components[].option_parameter 非空

### 12. 匹配多维评分
- **输入**：步骤与资产名称相同但字段结构不同
- **预期**：score_breakdown.request_structure 较低
- **验证**：overall 评分合理反映差异

### 13. 重建验证
- **输入**：asset-plus-patches 步骤有完整补丁
- **预期**：reconstruction.status 为 exact 或 semantic-equivalent
- **验证**：key_field_coverage >= 0.8

### 14. 重建冲突检测
- **输入**：补丁不完整或冲突
- **预期**：reconstruction.status 为 conflict 或 unexplained-difference
- **验证**：unexplained_differences 非空

### 15. 安全 extend 合并
- **输入**：GBrain 中已有 analysis-data, 新用例同场景
- **预期**：source_cases 并集, patches 追加不覆盖
- **验证**：已有 evidence 保留

### 16. maturity 标记
- **输入**：单用例分析
- **预期**：maturity 为 provisional
- **验证**：不误标为 stable

### 17. 证据标注
- **输入**：AI 填写的 patch
- **预期**：每个 patch 有 evidence_sources（至少1项）和 confidence
- **验证**：required_for_execution=true 的 patch confidence 不为 unresolved

### 18. pattern_signature 排除 setup
- **输入**：用例包含 CreateCustomer + Adjustment 步骤
- **预期**：pattern_signature 为 Adjustment（不含 CreateCustomer）
- **验证**：preparation_operations 包含 CreateCustomer 相关操作

## 通用测试场景

### T1: 单用例完整流程
- 执行 extract → fetch → init-draft → AI analysis → validate → (dry-run stop)
- 验证：0 error, 可接受数量的 warning

### T2: 批量用例同 pattern
- 多个用例同一 pattern_signature
- 验证：归入同一 scenario, source_cases 并集

### T3: 批量用例不同 pattern
- 多个用例不同 pattern_signature
- 验证：生成多个 scenario, 无 pattern 冲突

### T4: extend 模式
- GBrain 已有场景, 分析新同场景用例
- 验证：安全合并, 不覆盖已有数据

### T5: 未匹配步骤处理
- 步骤无匹配资产
- 验证：construction_mode=inline-recipe, 生成完整 inline_recipe

### T6: 特殊值处理
- rReq 包含 nosend/nocare/norecv
- 验证：正确识别为 set-nosend 等, 非误判为 replace-field

### T7: 变量流完整性
- 跨步骤变量引用
- 验证：variable_dependencies 准确, confidence 合理

### T8: 重建覆盖率
- asset-plus-patches 步骤
- 验证：reconstruction.key_field_coverage >= 0.8

### T9: 门禁完整性
- 故意留空 reason/evidence
- 验证：V10/V11 报 error

### T10: fetch-asset 缓存
- 重复 fetch 同一 asset_id
- 验证：第二次命中缓存, manifest 显示 cached=true
